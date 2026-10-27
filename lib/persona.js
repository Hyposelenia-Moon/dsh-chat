import {audit, context, fail, master, rowId, text} from './feature-utils.js';

const NAME_MAX = 40;
const PROMPT_MAX = 16000;
/**
 * 人格卡：可并存的多套系统提示词，按聊天绑定。
 * 参考 dsh-custom-mode 的「多个助手」概念，但数据与选择都在插件内，不依赖 DSH 插件或前端。
 */
export class PersonaCards {
  constructor({db}) { this.db = db; }

  /** 列表只返回概要；提示词正文用 get() 读取。 */
  list(ctx) {
    context(ctx);
    return this.db.prepare('SELECT id,name,enabled,updated_at FROM persona_cards ORDER BY id').all();
  }
  get(args = {}, ctx) {
    context(ctx);
    const row = this.db.prepare('SELECT * FROM persona_cards WHERE id=?').get(rowId(args.id));
    if (!row) fail('NOT_FOUND', '人格卡不存在');
    return row;
  }
  create(args = {}, ctx) {
    master(ctx);
    const name = text(args.name, 'name', NAME_MAX);
    const prompt = text(args.prompt, 'prompt', PROMPT_MAX);
    const model = args.model === undefined ? '' : text(args.model, 'model', 200, true);
    const now = Date.now();
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT id FROM persona_cards WHERE name=?').get(name)) fail('INVALID_ARGUMENT', '同名人格卡已存在');
      const result = this.db.prepare('INSERT INTO persona_cards(name,prompt,model,enabled,actor_id,created_at,updated_at) VALUES(?,?,?,1,?,?,?)')
        .run(name, prompt, model, String(ctx.senderId), now, now);
      const id = Number(result.lastInsertRowid);
      audit(this.db, 'persona.create', ctx, {id, name});
      return this.get({id}, ctx);
    });
  }
  update(args = {}, ctx) {
    master(ctx);
    const current = this.get({id: args.id}, ctx);
    const name = args.name === undefined ? current.name : text(args.name, 'name', NAME_MAX);
    const prompt = args.prompt === undefined ? current.prompt : text(args.prompt, 'prompt', PROMPT_MAX);
    const model = args.model === undefined ? current.model : text(args.model, 'model', 200, true);
    const enabled = args.enabled === undefined ? current.enabled : (args.enabled ? 1 : 0);
    return this.db.transaction(() => {
      const clash = this.db.prepare('SELECT id FROM persona_cards WHERE name=? AND id<>?').get(name, current.id);
      if (clash) fail('INVALID_ARGUMENT', '同名人格卡已存在');
      this.db.prepare('UPDATE persona_cards SET name=?,prompt=?,model=?,enabled=?,updated_at=? WHERE id=?')
        .run(name, prompt, model, enabled, Date.now(), current.id);
      audit(this.db, 'persona.update', ctx, {id: current.id});
      return this.get({id: current.id}, ctx);
    });
  }
  remove(args = {}, ctx) {
    master(ctx);
    const id = rowId(args.id);
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT id FROM persona_cards WHERE id=?').get(id)) fail('NOT_FOUND', '人格卡不存在');
      this.db.prepare('DELETE FROM persona_cards WHERE id=?').run(id);
      audit(this.db, 'persona.remove', ctx, {id});
      return {id, removed: true};
    });
  }
  /** 绑定到当前聊天；下一条消息生效，不打断进行中的轮次。 */
  bind(args = {}, ctx) {
    master(ctx);
    const id = rowId(args.id);
    return this.db.transaction(() => {
      const card = this.get({id}, ctx);
      if (!card.enabled) fail('INVALID_STATE', '人格卡已停用');
      this.db.prepare(`INSERT INTO chat_persona(chat_id,card_id,actor_id,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET card_id=excluded.card_id,actor_id=excluded.actor_id,updated_at=excluded.updated_at`)
        .run(ctx.chatId, id, String(ctx.senderId), Date.now());
      audit(this.db, 'persona.bind', ctx, {id, chatId: ctx.chatId});
      return {chatId: ctx.chatId, card};
    });
  }
  unbind(args = {}, ctx) {
    master(ctx);
    const result = this.db.prepare('DELETE FROM chat_persona WHERE chat_id=?').run(ctx.chatId);
    audit(this.db, 'persona.unbind', ctx, {chatId: ctx.chatId});
    return {chatId: ctx.chatId, cleared: result.changes > 0};
  }
  /** 当前聊天生效的人格卡；未绑定或已停用时返回 null。 */
  current(chatId) {
    const row = this.db.prepare(`SELECT c.* FROM chat_persona p JOIN persona_cards c ON c.id=p.card_id
      WHERE p.chat_id=? AND c.enabled=1`).get(chatId);
    return row ?? null;
  }
}
export default PersonaCards;

/**
 * 锅巴面板的批量入口：`persona.cards` 是一段 JSON 数组，留空表示不改动。
 * 名称是稳定键：同名覆盖提示词，未出现的名称会被删除（绑定随外键级联清理）。
 */
export function syncPersonaCards(source, db) {
  if (typeof source !== 'string' || !source.trim()) return {skipped: true};
  let cards;
  try { cards = JSON.parse(source); } catch { return {skipped: true, error: 'not json'}; }
  if (!Array.isArray(cards)) return {skipped: true, error: 'not an array'};
  return db.transaction(() => {
    const names = [];
    const now = Date.now();
    for (const card of cards) {
      const name = String(card?.name ?? '').trim();
      const prompt = String(card?.prompt ?? '').trim();
      if (!name || !prompt || name.length > NAME_MAX || prompt.length > PROMPT_MAX) continue;
      names.push(name);
      db.prepare(`INSERT INTO persona_cards(name,prompt,model,enabled,actor_id,created_at,updated_at) VALUES(?,?,?,1,'guoba',?,?)
        ON CONFLICT(name) DO UPDATE SET prompt=excluded.prompt, model=excluded.model, updated_at=excluded.updated_at`)
        .run(name, prompt, String(card.model ?? ''), now, now);
    }
    if (!names.length) return {skipped: true, error: 'no valid card'};
    db.prepare(`DELETE FROM persona_cards WHERE name NOT IN (${names.map(() => '?').join(',')})`).run(...names);
    return {synced: names.length};
  });
}

