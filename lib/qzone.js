import { bounded, containedFile, enabled, fail, master, text } from './feature-utils.js';

export class QzoneService {
  constructor({ db, config = {}, adapter, mediaRoot }) { Object.assign(this, { db, config, adapter, mediaRoot }); }
  async capabilities(ctx = {}) {
    const advertised = typeof this.adapter?.capabilities === 'function' ? (await this.adapter.capabilities(ctx.chatId, { context: ctx, signal: ctx.signal }))?.qzone : undefined;
    return Object.fromEntries(['post', 'comment', 'like'].map(action => [action,
      advertised?.[action] === true && (typeof this.adapter?.qzone === 'function' || typeof this.adapter?.[`qzone${action[0].toUpperCase()}${action.slice(1)}`] === 'function'),
    ]));
  }
  async invoke(action, args, ctx) {
    const settings = enabled(this.config, 'qzone'); master(ctx);
    ctx.signal?.throwIfAborted();
    const capabilities = await this.capabilities(ctx);
    ctx.signal?.throwIfAborted();
    if (!capabilities[action]) fail('UNSUPPORTED', `Current QQ adapter does not provide Qzone ${action}`);
    if (action === 'comment' && settings.commentsEnabled !== true) fail('FEATURE_DISABLED', 'Qzone comments are disabled');
    const params = {};
    if (action !== 'like') params.text = text(args.text, 'text', settings.maxLength ?? 10000);
    if (action !== 'post') params.postId = text(args.postId, 'postId', 200);
    if (action === 'post' && args.images?.length) {
      if (!Array.isArray(args.images) || args.images.length > 9) fail('INVALID_ARGUMENT', 'At most nine controlled image files are allowed');
      params.images = await Promise.all(args.images.map(file => containedFile(this.mediaRoot, file)));
    }
    ctx.signal?.throwIfAborted();
    const event = `qzone.${action}`;
    const auditId = this.db.transaction(() => {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE event IN (?,?) AND created_at>=?').get(event, `${event}.pending`, Date.now() - 86_400_000).n;
      if (count >= bounded(settings.dailyLimit, 5, 0, 1000)) fail('QUOTA_EXCEEDED', 'Daily Qzone action limit reached');
      return Number(this.db.prepare('INSERT INTO audit(event,actor_id,chat_id,turn_id,detail,created_at) VALUES(?,?,?,?,?,?)')
        .run(`${event}.pending`, String(ctx.senderId), ctx.chatId, ctx.turnId ?? null, JSON.stringify({ postId: params.postId ?? null, imageCount: params.images?.length ?? 0 }), Date.now()).lastInsertRowid);
    });
    try {
      const method = this.adapter[`qzone${action[0].toUpperCase()}${action.slice(1)}`];
      ctx.signal?.throwIfAborted();
      const result = typeof method === 'function' ? await method.call(this.adapter, params, ctx)
        : await this.adapter.qzone({ action, ...params }, ctx.chatId, { context: ctx, signal: ctx.signal });
      this.db.prepare('UPDATE audit SET event=? WHERE id=?').run(event, auditId);
      return { supported: true, action, result: result ?? null };
    } catch (error) { this.db.prepare('UPDATE audit SET event=? WHERE id=?').run(`${event}.failed`, auditId); throw error; }
  }
  post(args = {}, ctx) { return this.invoke('post', args, ctx); }
  comment(args = {}, ctx) { return this.invoke('comment', args, ctx); }
  like(args = {}, ctx) { return this.invoke('like', args, ctx); }
}
export default QzoneService;
