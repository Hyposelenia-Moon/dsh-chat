import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentModel, resolveModelValue, validateOption } from './model.js';

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
    if (this.closing.has(ctx.chatId)) await this.closing.get(ctx.chatId);
    if (this.active.has(ctx.chatId)) return this.active.get(ctx.chatId);
    if (this.opening.has(ctx.chatId)) return this.opening.get(ctx.chatId);
    const promise = this.#open(ctx).finally(() => this.opening.delete(ctx.chatId));
    this.opening.set(ctx.chatId, promise);
    return promise;
  }

  async #open(ctx) {
    await this.acp.start();
    const row = this.db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get(ctx.chatId);
    const cwd = resolve(row?.cwd || this.workspace);
    mkdirSync(cwd, { recursive: true });
    const server = this.mcp ? await this.mcp.forChat(ctx) : undefined;
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
    const record = { sessionId: result.sessionId, configOptions: result.configOptions ?? [], cwd };
    // ACP may omit configOptions when resuming. Without that list no model can be
    // resolved or verified, so keep the backend default (and the stored choice)
    // instead of failing every message for this chat.
    const modelOption = record.configOptions.some(item => item.id === 'model');
    const effortOption = record.configOptions.some(item => item.id === 'reasoning_effort');
    const wanted = row?.model || this.config.models?.groupDefaults?.[ctx.chatId]
      || this.config.models?.groupDefaults?.[ctx.chatId.replace(/^group:/, '')] || this.config.models?.default;
    try {
      if (wanted && modelOption) {
        const value = resolveModelValue(record.configOptions, wanted);
        this.#checkModel(value);
        await this.#set(record, 'model', value);
      } else if (wanted) this.logger.warn?.('ACP 未返回模型选项，沿用后端默认模型', { chatId: ctx.chatId });
      const actualModel = currentModel(record.configOptions);
      if (actualModel) this.#checkModel(actualModel.value);
      const effort = row?.reasoning_effort || this.config.models?.reasoningEffort;
      if (effort && effortOption) await this.#set(record, 'reasoning_effort', effort);
      const now = Date.now();
      this.db.prepare(`INSERT INTO sessions(chat_id,chat_type,session_id,model,reasoning_effort,preset,cwd,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET session_id=excluded.session_id,
        model=excluded.model,reasoning_effort=excluded.reasoning_effort,cwd=excluded.cwd,updated_at=excluded.updated_at`)
        .run(ctx.chatId, ctx.chatType ?? ctx.type ?? ctx.chatId.split(':')[0], record.sessionId,
          currentModel(record.configOptions)?.value ?? row?.model ?? null,
          record.configOptions.find(item => item.id === 'reasoning_effort')?.currentValue ?? row?.reasoning_effort ?? null,
          'qq-host', cwd, row?.created_at ?? now, now);
      this.active.set(ctx.chatId, record);
      return record;
    } catch (error) {
      await this.acp.request('session/close', { sessionId: record.sessionId }).catch(() => {});
      throw error;
    }
  }

  async #set(record, configId, value) {
    validateOption(record.configOptions, configId, value);
    const result = await this.acp.request('session/set_config_option', { sessionId: record.sessionId, configId, value });
    record.configOptions = result.configOptions;
    return record.configOptions;
  }

  async setOption(ctx, configId, value) {
    const record = await this.ensure(ctx);
    if (configId === 'model') {
      value = resolveModelValue(record.configOptions, value);
      this.#checkModel(value);
    }
    const options = await this.#set(record, configId, value);
    this.db.prepare('UPDATE sessions SET model = ?, reasoning_effort = ?, updated_at = ? WHERE chat_id = ?')
      .run(currentModel(options)?.value ?? null, options.find(item => item.id === 'reasoning_effort')?.currentValue ?? null,
        Date.now(), ctx.chatId);
    return options;
  }

  #checkModel(value) {
    let provider, model;
    try { [provider, model] = JSON.parse(value); } catch { return; }
    if (!this.config.models?.allowFree && (/our-free-model/.test(provider) || /(?:\/free|:free)$/.test(model)))
      throw new Error('免费模型尚未启用');
  }

  async reset(chatId) {
    if (this.closing.has(chatId)) await this.closing.get(chatId);
    if (this.opening.has(chatId)) await this.opening.get(chatId);
    const record = this.active.get(chatId);
    if (record) await this.acp.request('session/close', { sessionId: record.sessionId });
    this.active.delete(chatId);
    this.db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
  }
}

export default SessionMap;
