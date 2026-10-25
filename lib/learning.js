import { audit, bounded, context, enabled, fail, master, rowId, safeText } from './feature-utils.js';

/** Stores text candidates only. No method writes configuration, code, permissions, or credentials. */
export class LearningService {
  constructor({ db, config = {} }) { Object.assign(this, { db, config }); this.paused = db.prepare("SELECT value FROM feature_state WHERE key='learning.paused'").get()?.value === 'true'; }
  settings() { const value = enabled(this.config, 'learning'); if (this.paused || value.paused) fail('LEARNING_PAUSED', 'Learning is paused'); return value; }
  feedback(args = {}, ctx) {
    this.settings(); context(ctx);
    if (!['good', 'bad', 'correction', 'repeat'].includes(args.signal)) fail('INVALID_ARGUMENT', 'Unknown feedback signal');
    const note = safeText(args.note ?? '', 'note', 2000, true);
    const messageId = args.messageId == null ? null : rowId(args.messageId);
    if (messageId && !this.db.prepare('SELECT id FROM messages WHERE id=? AND chat_id=?').get(messageId, ctx.chatId)) fail('NOT_FOUND', 'Message is outside this chat');
    const result = this.db.prepare('INSERT INTO feedback(chat_id,message_id,signal,note,actor_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(ctx.chatId, messageId, args.signal, note, String(ctx.senderId), Date.now());
    audit(this.db, 'learning.feedback', ctx, { id: Number(result.lastInsertRowid), signal: args.signal });
    return this.db.prepare('SELECT * FROM feedback WHERE id=?').get(Number(result.lastInsertRowid));
  }
  propose(args = {}, ctx) {
    const settings = this.settings(); context(ctx);
    const content = safeText(args.content, 'persona text', settings.maxLength ?? 12000);
    const reason = safeText(args.reason ?? '', 'reason', 2000, true);
    if (args.kind && args.kind !== 'persona') fail('INVALID_ARGUMENT', 'Only a text persona can be proposed');
    const now = Date.now();
    return this.db.transaction(() => {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE created_at>=?').get(Math.floor(now / 86_400_000) * 86_400_000).n;
      if (count >= bounded(settings.maxCandidatesPerDay ?? settings.dailyCandidateLimit, 3, 0, 1000)) fail('QUOTA_EXCEEDED', 'Daily persona candidate limit reached');
      const version = this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM profiles').get().version;
      const result = this.db.prepare("INSERT INTO profiles(version,content,reason,kind,active,status,actor_id,automatic,created_at) VALUES(?,?,?,'persona',0,'pending',?,1,?)")
        .run(version, content, reason, String(ctx.senderId), now);
      const id = Number(result.lastInsertRowid);
      audit(this.db, 'learning.propose', ctx, { id, version });
      return this.db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
    });
  }
  activate(args, ctx, rollback) {
    enabled(this.config, 'learning'); master(ctx);
    const id = rowId(args.id);
    return this.db.transaction(() => {
      const candidate = this.db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
      if (!candidate) fail('NOT_FOUND', 'Persona version does not exist');
      if (rollback && !candidate.approved_at) fail('FORBIDDEN', 'Rollback requires a previously approved version');
      if (!rollback && candidate.status !== 'pending') fail('INVALID_STATE', 'Only a pending persona can be approved');
      const previous = this.current();
      const now = Date.now();
      this.db.prepare('UPDATE profiles SET active=0 WHERE active=1').run();
      this.db.prepare("UPDATE profiles SET active=1,status='approved',approved_by=?,approved_at=COALESCE(approved_at,?) WHERE id=?").run(String(ctx.senderId), now, id);
      this.db.prepare('INSERT INTO profile_approvals(profile_id,previous_profile_id,action,actor_id,reason,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, previous?.id ?? null, rollback ? 'rollback' : 'approve', String(ctx.senderId), safeText(args.reason ?? '', 'reason', 2000, true), now);
      audit(this.db, rollback ? 'learning.rollback' : 'learning.approve', ctx, { id, previousId: previous?.id ?? null });
      return this.current();
    });
  }
  approve(args, ctx) { return this.activate(args, ctx, false); }
  rollback(args, ctx) { return this.activate(args, ctx, true); }
  current() { return this.db.prepare('SELECT * FROM profiles WHERE active=1').get() ?? null; }
  list(args = {}, ctx) { enabled(this.config, 'learning'); master(ctx); return this.db.prepare('SELECT * FROM profiles ORDER BY version DESC LIMIT ?').all(Math.floor(bounded(args.limit, 50, 1, 200))); }
  pause(args = {}, ctx) {
    master(ctx); this.paused = args.paused !== false;
    this.db.prepare("INSERT INTO feature_state(key,value,updated_at) VALUES('learning.paused',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(String(this.paused), Date.now());
    audit(this.db, 'learning.pause', ctx, { paused: this.paused }); return { paused: this.paused };
  }
  saveTemplate(args = {}, ctx) {
    this.settings(); master(ctx);
    const intent = safeText(args.intent, 'intent', 200);
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 20) fail('INVALID_ARGUMENT', 'A template needs 1 to 20 text steps');
    const steps = args.steps.map(step => safeText(step, 'step', 500));
    const result = this.db.prepare('INSERT INTO skill_templates(intent,steps,successful,actor_id,created_at) VALUES(?,?,?,?,?)')
      .run(intent, JSON.stringify(steps), Number(args.successful !== false), String(ctx.senderId), Date.now());
    const id = Number(result.lastInsertRowid); audit(this.db, 'learning.template', ctx, { id }); return { id, intent, steps };
  }
  templates(args = {}, ctx) {
    this.settings(); context(ctx);
    const query = safeText(args.query ?? '', 'query', 200, true).replace(/[\\%_]/g, '\\$&');
    return this.db.prepare("SELECT id,intent,steps FROM skill_templates WHERE successful=1 AND intent LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 5")
      .all(`%${query}%`).map(row => ({ ...row, steps: JSON.parse(row.steps) }));
  }
}
export default LearningService;
