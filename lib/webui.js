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

  async start() {
    if (this.child) return this.url;
    const spec = verifyBackend(this.runtime.config);
    const ready = OfficialWebUi.profileReady(spec.env.DSH_HOME);
    if (!ready.ok) {
      throw new Error(`${ready.reason}。请先在 DSH 目录执行：dsh plugin --profile web add @deepseek-ai/dsh-web-app@0.2.1-rc.3`);
    }
    const entry = spec.args[0];
    const child = this.spawn(spec.command, [entry, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const url = await new Promise((resolve, reject) => {
      let out = '', err = '';
      const timer = setTimeout(() => { this.stop(); reject(new Error('DSH WebUI 启动超时（60 秒）')); }, this.timeoutMs);
      const finish = (fn, value) => { clearTimeout(timer); fn(value); };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', chunk => {
        out = (out + chunk).slice(-20000);
        const match = out.match(URL_PATTERN);
        if (match) finish(resolve, match[0]);
      });
      child.stderr?.on('data', chunk => { err = (err + chunk).slice(-2000); });
      child.once('error', error => finish(reject, error));
      child.once('exit', code => finish(reject, new Error(`DSH WebUI 退出（code=${code}）${err ? '：' + redact(err).slice(0, 300) : ''}`)));
    });
    this.url = url;
    child.once('exit', () => { if (this.child === child) { this.child = null; this.url = null; } });
    this.runtime.logger?.info('webui_started', { port: new URL(url).port });
    return url;
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.url = null;
    if (child && child.exitCode === null) { try { child.kill(); } catch { /* 已退出 */ } }
  }
}

export default OfficialWebUi;
