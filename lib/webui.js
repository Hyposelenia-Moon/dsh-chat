import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { verifyBackend } from '../backend/provenance.js';
import { redact } from './logger.js';

const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/;

/**
 * 官方 DSH WebUI 启动器：用后端自带的 `--profile web` 起一个只监听本机的
 * 浏览器界面，从 stdout 里取带一次性令牌的地址；令牌只在私聊里交给主人。
 * 不依赖插件自己的前端，也不再维护精简面板。
 */
export class OfficialWebUi {
  constructor({ runtime, spawn = nodeSpawn, timeoutMs = 60000 }) {
    this.runtime = runtime;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.url = null;
  }

  /** 检查 web profile 是否已安装官方界面。 */
  static profileReady(dshHome) {
    const file = path.join(dshHome, 'profiles', 'web', 'package.json');
    if (!existsSync(file)) return { ok: false, reason: '缺少 web profile' };
    try {
      const deps = JSON.parse(readFileSync(file, 'utf8')).dependencies ?? {};
      if (!deps['@deepseek-ai/dsh-web-app']) return { ok: false, reason: 'web profile 未安装官方界面' };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: redact(error.message).slice(0, 200) };
    }
  }

  start() {
    if (this.starting) return this.starting;
    if (this.child && this.url) return Promise.resolve(this.url);
    const pending = Promise.resolve().then(() => this._launch());
    this.starting = pending;
    pending.then(() => { if (this.starting === pending) this.starting = null; }, () => { if (this.starting === pending) this.starting = null; });
    return pending;
  }

  async _launch() {
    const spec = verifyBackend(this.runtime.config);
    const ready = OfficialWebUi.profileReady(spec.env.DSH_HOME);
    if (!ready.ok) throw new Error(`${ready.reason}。请先安装官方 web profile`);
    if (this.cancelled) { this.cancelled = false; throw new Error('DSH WebUI 启动已停止'); }
    const child = this.spawn(spec.command, [spec.args[0], '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    try {
      const url = await new Promise((resolve, reject) => {
        let out = '', settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); this.cancelStart = null;
          child.stdout?.off('data', onData);
          if (error) reject(error); else resolve(value);
        };
        const onData = chunk => {
          out = (out + chunk).slice(-20000);
          const match = out.match(URL_PATTERN);
          if (match) finish(null, match[0]);
        };
        const timer = setTimeout(() => finish(new Error('DSH WebUI 启动超时')), this.timeoutMs);
        this.cancelStart = () => finish(new Error('DSH WebUI 启动已停止'));
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', onData);
        // stderr 可能包含分块令牌，丢弃原始输出，不拼进异常或日志。
        child.stderr?.on('data', () => {});
        child.once('error', () => finish(new Error('DSH WebUI 子进程启动失败')));
        child.once('exit', code => {
          if (this.child === child) { this.child = null; this.url = null; }
          finish(new Error(`DSH WebUI 退出（code=${code}）`));
        });
      });
      if (this.child !== child) throw new Error('DSH WebUI 启动已停止');
      this.url = url;
      this.runtime.logger?.info('webui_started', {port:new URL(url).port});
      return url;
    } catch (error) {
      if (this.child === child) { this.child = null; this.url = null; }
      if (child.exitCode === null) { try { child.kill(); } catch { /* 已退出 */ } }
      throw error;
    }
  }

  stop() {
    if (this.starting && !this.child) this.cancelled = true;
    this.cancelStart?.();
    const child = this.child;
    this.child = null; this.url = null;
    if (child && child.exitCode === null) { try { child.kill(); } catch { /* 已退出 */ } }
  }
}

export default OfficialWebUi;
