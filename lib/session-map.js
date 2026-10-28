import { chatKey } from './qq-adapter.js';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentModel, resolveModelValue, validateOption, classifyModel } from './model.js';

/** Persistent chat identity with one active ACP session per chat. */
export class SessionMap {
  constructor({ db, acp, config, mcp, logger = console, workspace = 'data/dsh-chat/workspace' }) {
    Object.assign(this, { db, acp, config, mcp, logger, workspace });
    this.active = new Map();
    this.opening = new Map();
    this.closing = new Map();
    acp.on('exit', () => this.active.clear());
    acp.on('session-invalidated', ({ sessionId, draining }) => {
      for (const [chatId, record] of this.active) {
        if (record.sessionId !== sessionId) continue;
        this.active.delete(chatId);
        const done = draining.finally(() => this.closing.delete(chatId));
        this.closing.set(chatId, done);
        done.catch(() => {});
      }
    });
    acp.on('update', ({ sessionId, update }) => {
      if (update?.sessionUpdate !== 'config_option_update') return;
      for (const record of this.active.values()) {
        if (record.sessionId === sessionId) record.configOptions = update.configOptions ?? record.configOptions;
      }
    });
  }

  async ensure(ctx) {
    const key = chatKey(ctx);
    if (this.closing.has(key)) await this.closing.get(key);
    if (this.opening.has(key)) {
      await this.opening.get(key);
      return this.ensure(ctx);
    }
    const promise = (async () => {
      const server = this.mcp ? await this.mcp.forChat(ctx) : undefined;
      const record = this.active.get(key);
      if (record && record.mcpUrl === server?.url) return record;
      if (record) {
        // 已激活的 ACP session 无法替换 MCP 地址，必须关闭后恢复。
        this.active.delete(key);
        await this.acp.request('session/close', {sessionId:record.sessionId});
      }
      return this.#open(ctx, server);
    })().finally(() => this.opening.delete(key));
    this.opening.set(key, promise);
    return promise;
  }

  async #open(ctx, server, overrideModel) {
    const key = chatKey(ctx);
    await this.acp.start();
    const row = this.db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get(key);
    if (row && ctx.turnId && classifyModel(row.model) === 'unknown') throw new Error('无法确认已存会话模型提供方信任等级');
    const cwd = resolve(row?.cwd || this.workspace);
    mkdirSync(cwd, { recursive: true });
    const params = { cwd, mcpServers: server ? [server] : [] };
    let result;
    if (row) {
      try {
        result = await this.acp.request('session/resume', { ...params, sessionId: row.session_id });
        result.sessionId = row.session_id;
      } catch (error) {
        // Only an explicit missing session permits creation. Network/auth/MCP failures
        // must keep the persistent identity for a later retry.
        if (error.code !== -32602 || !/not resumable|unknown session/.test(error.message)) throw error;
        this.logger.warn?.('DSH 会话已不可恢复，将创建新会话');
      }
    }
    if (!result) result = await this.acp.request('session/new', params);
    const record = { sessionId: result.sessionId, configOptions: result.configOptions ?? [], cwd, mcpUrl:server?.url };
    const modelOption = record.configOptions.some(item => item.id === 'model');
    const effortOption = record.configOptions.some(item => item.id === 'reasoning_effort');
    const wanted = overrideModel || row?.model || this.config.models?.groupDefaults?.[ctx.chatId]
      || this.config.models?.groupDefaults?.[ctx.chatId.replace(/^group:/, '')] || this.config.models?.default;
    try {
      const initialModel = currentModel(record.configOptions);
      if (!initialModel) throw new Error('ACP 未返回可确认的实际模型，拒绝使用会话');
      if (wanted && modelOption) {
        const requested = resolveModelValue(record.configOptions, wanted);
        this.#checkModel(requested);
        if (row && classifyModel(initialModel.value) !== classifyModel(requested)) {
          // 恢复后的默认模型与存储选择跨信任等级，禁止在旧历史上切换。
          await this.acp.request('session/close', {sessionId:record.sessionId});
          this.db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(key);
          return this.#open(ctx, server, requested);
        }
        const value = resolveModelValue(record.configOptions, wanted);
        this.#checkModel(value);
        await this.#set(record, 'model', value);
      }
      const actualModel = currentModel(record.configOptions);
      if (!actualModel) throw new Error('ACP 未返回可确认的实际模型，拒绝使用会话');
      this.#checkModel(actualModel.value);
      const effort = row?.reasoning_effort || this.config.models?.reasoningEffort;
      if (effort && effortOption) await this.#set(record, 'reasoning_effort', effort);
      const now = Date.now();
      this.db.prepare(`INSERT INTO sessions(chat_id,chat_type,session_id,model,reasoning_effort,preset,cwd,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET session_id=excluded.session_id,
        model=excluded.model,reasoning_effort=excluded.reasoning_effort,cwd=excluded.cwd,updated_at=excluded.updated_at`)
        .run(key, ctx.chatType ?? ctx.type ?? ctx.chatId.split(':')[0], record.sessionId,
          currentModel(record.configOptions)?.value ?? row?.model ?? null,
          record.configOptions.find(item => item.id === 'reasoning_effort')?.currentValue ?? row?.reasoning_effort ?? null,
          'qq-host', cwd, row?.created_at ?? now, now);
      this.active.set(key, record);
      return record;
    } catch (error) {
      await this.acp.request('session/close', { sessionId: record.sessionId }).catch(() => {});
      throw error;
    }
  }

  async #set(record, configId, value) {
    validateOption(record.configOptions, configId, value);
    const before = currentModel(record.configOptions)?.value;
    const result = await this.acp.request('session/set_config_option', { sessionId: record.sessionId, configId, value });
    try {
      const actual = currentModel(result?.configOptions);
      if (!actual) throw new Error('missing actual model');
      this.#checkModel(actual.value);
      if (configId === 'model' ? actual.value !== value : before && actual.value !== before) throw new Error('unexpected actual model');
    } catch {
      for (const [key, active] of this.active) if (active === record) this.active.delete(key);
      await this.acp.request('session/close', {sessionId:record.sessionId}).catch(() => {});
      throw new Error('ACP 返回的实际模型未通过确认，已关闭会话');
    }
    record.configOptions = result.configOptions;
    return record.configOptions;
  }

  async setOption(ctx, configId, value) {
    const key = chatKey(ctx);
    let record = await this.ensure(ctx);
    if (configId === 'model') {
      value = resolveModelValue(record.configOptions, value);
      this.#checkModel(value);
      const saved = this.db.prepare('SELECT model FROM sessions WHERE chat_id = ?').get(key);
      if (classifyModel(currentModel(record.configOptions)?.value ?? saved?.model) !== classifyModel(value)) {
        await this.reset(ctx);
        const server = this.mcp ? await this.mcp.forChat(ctx) : undefined;
        record = await this.#open(ctx, server, value);
      }
    }
    const options = await this.#set(record, configId, value);
    this.db.prepare('UPDATE sessions SET model = ?, reasoning_effort = ?, updated_at = ? WHERE chat_id = ?')
      .run(currentModel(options)?.value ?? null, options.find(item => item.id === 'reasoning_effort')?.currentValue ?? null,
        Date.now(), key);
    return options;
  }

  #checkModel(value) {
    const trust = classifyModel(value);
    if (trust === 'unknown') throw new Error('无法确认模型提供方信任等级');
    if (!this.config.models?.allowFree && trust === 'free') throw new Error('免费模型尚未启用');
  }

  async reset(ctx) {
    const chatId = typeof ctx === 'string' ? ctx : chatKey(ctx);
    if (!/^[1-9]\d{0,15}:(group|private):[1-9]\d{0,15}$/.test(chatId)) throw new Error('重置会话需要包含机器人账号的身份');
    if (this.closing.has(chatId)) await this.closing.get(chatId);
    if (this.opening.has(chatId)) await this.opening.get(chatId);
    const record = this.active.get(chatId);
    this.active.delete(chatId);
    if (record) await this.acp.request('session/close', { sessionId: record.sessionId });
    this.db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
  }
}

export default SessionMap;
