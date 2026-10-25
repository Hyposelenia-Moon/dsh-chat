import { audit, bounded, context, enabled, fail, master, rowId, safeText } from './feature-utils.js';

function searchTokens(query) {
  const words = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 12);
  const grams = new Set();
  // Retain complete words for FTS and add at most 24 Han bigrams for conversational wording.
  for (const run of query.match(/\p{Script=Han}{2,}/gu) ?? []) {
    const characters = Array.from(run);
    for (let index = 0; index + 1 < characters.length && grams.size < 24; index++) grams.add(characters[index] + characters[index + 1]);
    if (grams.size >= 24) break;
  }
  return [...new Set([...words, ...grams])].slice(0, 32);
}

export class MemoryService {
  constructor({ db, config = {}, logger = console }) { Object.assign(this, { db, config, logger }); }
  scope(args, ctx, write = false) {
    context(ctx);
    const scope = args.scope ?? 'user';
    let id = args.scopeId ?? args.scope_id;
    if (scope === 'global') {
      if (write) master(ctx);
      id = '';
    } else if (scope === 'user') {
      id = String(id ?? ctx.senderId);
      if (ctx.role !== 'master' && id !== String(ctx.senderId)) fail('FORBIDDEN', 'Only your own user memory is accessible');
    } else if (scope === 'group') {
      id = String(id ?? (ctx.chatId.startsWith('group:') ? ctx.chatId.slice(6) : ''));
      if (!id || (ctx.role !== 'master' && ctx.chatId !== `group:${id}`)) fail('FORBIDDEN', 'Only the current group memory is accessible');
    } else fail('INVALID_ARGUMENT', 'Unknown memory scope');
    return { scope, id };
  }
  search(args = {}, ctx) {
    enabled(this.config, 'memory'); context(ctx);
    const query = safeText(args.query ?? '', 'query', 500, true);
    const limit = Math.floor(bounded(args.limit, 6, 1, 50));
    let scopeSql, scopeValues;
    if (args.scope) {
      const target = this.scope(args, ctx);
      scopeSql = 'm.scope=? AND m.scope_id=?'; scopeValues = [target.scope, target.id];
      if (target.scope === 'user') { scopeSql += ' AND m.source_chat_id=?'; scopeValues.push(ctx.chatId); }
    } else {
      scopeSql = "(m.scope='global' OR (m.scope='user' AND m.scope_id=? AND m.source_chat_id=?) OR (m.scope='group' AND m.scope_id=?))";
      scopeValues = [String(ctx.senderId), ctx.chatId, ctx.chatId.startsWith('group:') ? ctx.chatId.slice(6) : ''];
    }
    const tokens = searchTokens(query);
    const ftsScores = new Map();
    if (tokens.length && this.db.fts !== false) {
      try {
        const expression = tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ');
        for (const row of this.db.prepare(`SELECT rowid, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 500`).all(expression)) ftsScores.set(Number(row.rowid), row.rank);
      } catch (error) { if (!/no such table|fts5/i.test(error.message)) throw error; }
    }
    const predicates = tokens.map(() => "(m.content LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\')");
    const values = tokens.flatMap(token => { const value = `%${token.replace(/[\\%_]/g, '\\$&')}%`; return [value, value]; });
    if (ftsScores.size) { predicates.push(`m.id IN (${[...ftsScores.keys()].map(() => '?').join(',')})`); values.push(...ftsScores.keys()); }
    const match = predicates.length ? `AND (${predicates.join(' OR ')})` : '';
    const rows = this.db.prepare(`SELECT m.* FROM memories m WHERE m.forgotten_at IS NULL AND m.superseded_by IS NULL AND ${scopeSql} ${match} ORDER BY m.importance DESC,m.created_at DESC LIMIT 500`).all(...scopeValues, ...values);
    const now = Date.now();
    const scored = rows.map(row => {
      const haystack = `${row.subject} ${row.content}`.toLocaleLowerCase();
      const hits = tokens.reduce((n, token) => n + Number(haystack.includes(token.toLocaleLowerCase())), 0);
      const recency = Math.exp(-(now - row.created_at) / (90 * 86_400_000));
      return { ...row, score: hits * 3 + (ftsScores.has(row.id) ? 2 + Math.min(3, -ftsScores.get(row.id)) : 0) + row.importance + recency * 0.2 };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
    for (const row of scored) this.db.prepare('UPDATE memories SET last_used_at=? WHERE id=?').run(now, row.id);
    return scored;
  }
  write(args = {}, ctx) {
    const settings = enabled(this.config, 'memory');
    const { scope, id } = this.scope(args, ctx, true);
    const content = safeText(args.content, 'content', settings.maxLength ?? 4000);
    const subject = safeText(args.subject ?? '', 'subject', 300, true);
    const kind = args.kind ?? 'fact';
    if (!['fact', 'preference', 'event', 'relation', 'rule'].includes(kind)) fail('INVALID_ARGUMENT', 'Unknown memory kind');
    const importance = bounded(args.importance, 0.5, 0, 1);
    // Tool-originated memory is automatic unless the trusted caller explicitly marks a manual owner action.
    const automatic = !(ctx.role === 'master' && args.automatic !== true && (args.manual === true || args.automatic === false));
    const now = Date.now();
    return this.db.transaction(() => {
      if (automatic) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE automatic=1 AND created_at>=?').get(Math.floor(now / 86_400_000) * 86_400_000).n;
        if (count >= bounded(settings.maxAutomaticPerDay ?? settings.dailyWriteLimit, 20, 0, 10000)) fail('QUOTA_EXCEEDED', 'Daily automatic memory limit reached');
      }
      const duplicate = this.db.prepare("SELECT * FROM memories WHERE scope=? AND scope_id=? AND content=? AND (?<>'user' OR source_chat_id=?) AND forgotten_at IS NULL AND superseded_by IS NULL").get(scope, id, content, scope, ctx.chatId);
      if (duplicate) return { ...duplicate, duplicate: true };
      const result = this.db.prepare('INSERT INTO memories(scope,scope_id,subject,kind,content,importance,created_at,automatic,actor_id,source_chat_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(scope, id, subject, kind, content, importance, now, Number(automatic), String(ctx.senderId), ctx.chatId);
      const record = this.db.prepare('SELECT * FROM memories WHERE id=?').get(Number(result.lastInsertRowid));
      audit(this.db, 'memory.write', ctx, { id: record.id, scope, scopeId: id, automatic });
      return record;
    });
  }
  changeState(args, ctx, forgotten) {
    enabled(this.config, 'memory'); master(ctx);
    const id = rowId(args.id);
    const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id);
    if (!row) fail('NOT_FOUND', 'Memory does not exist');
    this.db.prepare('UPDATE memories SET forgotten_at=? WHERE id=?').run(forgotten ? Date.now() : null, id);
    audit(this.db, forgotten ? 'memory.forget' : 'memory.restore', ctx, { id });
    return this.db.prepare('SELECT * FROM memories WHERE id=?').get(id);
  }
  forget(args, ctx) { return this.changeState(args, ctx, true); }
  restore(args, ctx) { return this.changeState(args, ctx, false); }
}
export default MemoryService;
