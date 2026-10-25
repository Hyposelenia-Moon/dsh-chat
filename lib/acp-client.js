import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { verifyBackend as defaultVerify } from '../backend/provenance.js';

export class AcpError extends Error {
  constructor(message, code = 'ACP_ERROR', data) { super(message); this.name = 'AcpError'; this.code = code; this.data = data; }
}

export function redactStderr(text) {
  return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(https?:\/\/[^\s/]+\/mcp\/)[^\s/"?]+/g, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
}

/** One NDJSON JSON-RPC connection. All per-chat serialization lives above it. */
export class AcpClient extends EventEmitter {
  constructor(input, { logger = console, onPermission, spawn = nodeSpawn, verifyBackend = defaultVerify } = {}) {
    super();
    this.config = input.backend ?? input;
    Object.assign(this, { logger, onPermission, spawn, verifyBackend });
    this.pending = new Map(); this.nextId = 1; this.child = null; this.starting = null;
    this.capabilities = null; this.active = false; this.quarantined = new Map();
  }

  async start() {
    if (this.active) return this.capabilities;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start() {
    if (this.child) await this.stop();
    const spec = this.verifyBackend(this.config);
    if (this.config.patchPath) throw new Error('外部 patchPath 未经 qq 组合校验，请通过 backend-prepare 生成 profile');
    const child = this.spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env,
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.buffer = ''; this.stderr = ''; this.stderrTruncated = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#read(chunk));
    child.stderr.on('data', chunk => this.#readStderr(chunk));
    child.stdin.on('error', error => this.#fail(new AcpError(`ACP stdin 断开：${error.code ?? 'IO'}`, 'ACP_IO')));
    child.once('error', error => this.#fail(new AcpError(`ACP 启动失败：${error.code ?? 'spawn'}`, 'ACP_SPAWN')));
    child.once('exit', (code, signal) => {
      this.#readStderr('\n');
      const current = this.child === child;
      if (current) { this.child = null; this.active = false; this.capabilities = null; }
      this.#rejectAll(new AcpError(`ACP 进程退出（${code ?? signal}）`, 'ACP_EXIT'), child);
      if (current) this.emit('exit', { code, signal });
    });
    try {
      const result = await this.request('initialize', {
        protocolVersion: 1, clientInfo: { name: 'dsh-chat', version: '0.1.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, { timeoutMs: this.config.startupTimeoutMs ?? 30000 });
      if (result.protocolVersion !== 1) throw new AcpError('ACP protocolVersion 不兼容', 'ACP_VERSION');
      this.capabilities = result; this.active = true; return result;
    } catch (error) { await this.stop(); throw error; }
  }

  request(method, params = {}, { timeoutMs = this.config.requestTimeoutMs ?? 180000, signal } = {}) {
    if (!this.child?.stdin.writable) return Promise.reject(new AcpError('ACP 尚未连接', 'ACP_OFFLINE'));
    if (signal?.aborted) return Promise.reject(new AcpError('ACP 请求已取消', 'ABORT_ERR'));
    if (method === 'session/prompt' && this.quarantined.has(params.sessionId))
      return Promise.reject(new AcpError('ACP 上一轮取消正在释放会话', 'ACP_DRAINING'));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return Promise.reject(new AcpError('ACP timeoutMs 无效', 'ACP_CONFIG'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = reason => {
        if (!this.pending.has(id)) return;
        if (method === 'session/prompt' && params.sessionId) this.#drainCancelled(params.sessionId);
        this.#settle(id, false, reason);
        if (['session/new', 'session/resume', 'session/set_config_option', 'session/close'].includes(method)) {
          // A lost mutation response makes the server's active identity/config
          // unknowable (new may already have allocated a session). Reconnect
          // instead of leaving orphaned sessions or using ambiguous options.
          this.#fail(new AcpError('ACP 会话操作结果不确定，连接已关闭', 'ACP_SESSION_UNCERTAIN'));
        }
      };
      const abort = () => cancel(new AcpError('ACP 请求已取消', 'ABORT_ERR'));
      const timer = setTimeout(() => cancel(new AcpError(`ACP 请求超时：${method}`, 'ACP_TIMEOUT')), timeoutMs);
      this.pending.set(id, { resolve, reject, timer, signal, abort, child: this.child });
      signal?.addEventListener('abort', abort, { once: true });
      this.#write({ jsonrpc: '2.0', id, method, params }, error => {
        if (error) this.#settle(id, false, new AcpError('ACP 写入失败', 'ACP_IO'));
      });
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin.writable) return false;
    this.#write({ jsonrpc: '2.0', method, params }); return true;
  }

  #drainCancelled(sessionId) {
    if (this.quarantined.has(sessionId)) return;
    this.notify('session/cancel', { sessionId });
    // Closing waits for prompt cancellation and committed updates to drain. A
    // later ensure() may resume only after this acknowledgement, preventing
    // delayed text from the cancelled turn becoming the next turn's reply.
    const draining = this.request('session/close', { sessionId }, { timeoutMs: this.config.startupTimeoutMs ?? 30000 })
      .catch(error => {
        // If the backend cannot confirm close, its other sessions must reconnect
        // too: keeping an ambiguous stream alive would mix turn identities.
        this.#fail(new AcpError('ACP 取消未能完成释放，连接已关闭', 'ACP_DRAIN_FAILED'));
        throw error;
      }).finally(() => this.quarantined.delete(sessionId));
    this.quarantined.set(sessionId, draining);
    draining.catch(() => {});
    this.emit('session-invalidated', { sessionId, draining });
  }

  #write(message, callback = () => {}) {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`, callback); }
    catch (error) { callback(error); }
  }

  #read(chunk) {
    this.buffer += chunk;
    const max = this.config.maxFrameBytes ?? 8 * 1024 * 1024;
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > max) return this.#fail(new AcpError('ACP 帧超限', 'ACP_PROTOCOL'));
      let message;
      try { message = JSON.parse(line); }
      catch { return this.#fail(new AcpError('ACP stdout 包含非协议内容', 'ACP_PROTOCOL')); }
      if (!message || message.jsonrpc !== '2.0' || typeof message !== 'object' || Array.isArray(message))
        return this.#fail(new AcpError('ACP JSON-RPC 帧无效', 'ACP_PROTOCOL'));
      if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'id')) void this.#serverRequest(message);
        else if (message.method === 'session/update') this.emit('update', message.params);
        else this.emit('notification', message);
      } else if (Object.hasOwn(message, 'id')) {
        if (message.error) this.#settle(message.id, false,
          new AcpError(message.error.message ?? 'ACP 请求失败', message.error.code, message.error.data));
        else if (Object.hasOwn(message, 'result')) this.#settle(message.id, true, message.result);
        else return this.#fail(new AcpError('ACP 响应缺少 result/error', 'ACP_PROTOCOL'));
      }
    }
    if (Buffer.byteLength(this.buffer) > max) this.#fail(new AcpError('ACP 帧超限', 'ACP_PROTOCOL'));
  }

  async #serverRequest(message) {
    const child = this.child;
    if (message.method !== 'session/request_permission') {
      this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported client method' } }); return;
    }
    let timer, result = { outcome: { outcome: 'cancelled' } };
    try {
      const decision = await Promise.race([
        Promise.resolve().then(() => this.onPermission?.(message.params) ?? false),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), this.config.permissionTimeoutMs ?? 10000); }),
      ]);
      const options = message.params.options ?? [];
      if (typeof decision === 'boolean') {
        const selected = options.find(item => item.kind === (decision ? 'allow_once' : 'reject_once'));
        if (selected) result = { outcome: { outcome: 'selected', optionId: selected.optionId } };
      } else if (decision?.outcome?.outcome === 'selected'
        && options.some(item => item.optionId === decision.outcome.optionId)) result = decision;
    } catch { this.logger.warn?.('ACP 权限策略失败，已拒绝'); }
    finally { clearTimeout(timer); }
    if (this.child === child) this.#write({ jsonrpc: '2.0', id: message.id, result });
  }

  #readStderr(chunk) {
    if (this.stderrTruncated) {
      const end = chunk.indexOf('\n');
      if (end === -1) return;
      chunk = chunk.slice(end + 1); this.stderrTruncated = false;
      this.logger.warn?.('[DSH] stderr line truncated');
    }
    this.stderr += chunk;
    let end;
    while ((end = this.stderr.indexOf('\n')) !== -1) {
      const line = this.stderr.slice(0, end).trim(); this.stderr = this.stderr.slice(end + 1);
      if (line) this.logger.warn?.(`[DSH] ${redactStderr(line).slice(0, 2000)}`);
    }
    // Drop an overlong unfinished line rather than exposing a split credential.
    if (this.stderr.length > 16384) { this.stderr = ''; this.stderrTruncated = true; }
  }

  #settle(id, success, value) {
    const item = this.pending.get(id); if (!item) return;
    this.pending.delete(id); clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.abort);
    (success ? item.resolve : item.reject)(value);
  }
  #rejectAll(error, child) {
    for (const [id, item] of this.pending) if (!child || item.child === child) this.#settle(id, false, error);
  }
  #fail(error) { this.active = false; this.#rejectAll(error, this.child); this.child?.kill(); }

  async stop() {
    const child = this.child;
    this.active = false;
    this.#rejectAll(new AcpError('ACP 已停止', 'ACP_STOPPED'));
    if (!child) return;
    await new Promise(resolve => {
      let timer;
      const done = () => { clearTimeout(timer); resolve(); };
      child.once('exit', done); child.stdin.end();
      timer = setTimeout(() => { child.kill(); setTimeout(done, 1000).unref(); }, 1500);
    });
  }
}

export default AcpClient;
