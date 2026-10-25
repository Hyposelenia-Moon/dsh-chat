import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { audit, bounded, context, enabled, fail, master, rowId, text, containedFile } from './feature-utils.js';

export class LettersService {
  constructor({ db, config = {}, adapter, mediaRoot }) { Object.assign(this, { db, config, adapter, mediaRoot: resolve(mediaRoot ?? 'data/media') }); }
  async write(args = {}, ctx) {
    const settings = enabled(this.config, 'letters'); master(ctx);
    const title = text(args.title ?? '', 'title', 200, true);
    const body = text(args.body, 'body', settings.maxLength ?? 30000);
    const format = args.format ?? 'text';
    if (format === 'image') fail('UNSUPPORTED', 'Image letters need a separately configured, trusted renderer; use text or file');
    if (!['text', 'file'].includes(format)) fail('INVALID_ARGUMENT', 'Supported letter formats are text and file');
    const chatId = args.chatId ?? ctx.chatId;
    context({ ...ctx, chatId });
    const scheduledAt = args.scheduledAt == null ? null : bounded(args.scheduledAt, 0, Date.now(), Date.now() + 366 * 86_400_000);
    const result = this.db.prepare('INSERT INTO letters(chat_id,title,body,format,actor_id,scheduled_at,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(chatId, title, body, format, String(ctx.senderId), scheduledAt, Date.now());
    const id = Number(result.lastInsertRowid);
    if (format === 'file') {
      const directory = join(this.mediaRoot, 'letters');
      await mkdir(directory, { recursive: true });
      await containedFile(this.mediaRoot, directory);
      const file = join(directory, `letter-${id}.txt`);
      try {
        await writeFile(file, `${title ? `${title}\n\n` : ''}${body}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await containedFile(this.mediaRoot, file);
        this.db.prepare('UPDATE letters SET file=? WHERE id=?').run(file, id);
      } catch (error) { this.db.prepare('DELETE FROM letters WHERE id=?').run(id); throw error; }
    }
    audit(this.db, 'letter.write', ctx, { id, format, chatId, scheduledAt });
    return this.get({ id }, ctx);
  }
  get(args, ctx) {
    enabled(this.config, 'letters'); master(ctx);
    const row = this.db.prepare('SELECT * FROM letters WHERE id=?').get(rowId(args.id));
    if (!row) fail('NOT_FOUND', 'Letter does not exist');
    return { ...row, text: `${row.title ? `${row.title}\n\n` : ''}${row.body}` };
  }
  async send(args, ctx) {
    const letter = this.get(args, ctx);
    if (letter.sent_at) return { ...letter, delivery: 'already_sent' };
    if (!this.adapter?.sendLetter) return { ...letter, delivery: 'prepared' };
    if (letter.file) await containedFile(this.mediaRoot, letter.file);
    await this.adapter.sendLetter(letter.chat_id, letter, ctx);
    return { ...this.markSent(args, ctx), delivery: 'sent' };
  }
  markSent(args, ctx) {
    const row = this.get(args, ctx);
    this.db.prepare('UPDATE letters SET sent_at=COALESCE(sent_at,?) WHERE id=?').run(Date.now(), row.id);
    audit(this.db, 'letter.sent', ctx, { id: row.id });
    return this.get(args, ctx);
  }
}
export default LettersService;
