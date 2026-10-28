import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, unlink, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { audit, bounded, containedFile, context, enabled, fail, rowId, safeText, storageLock } from './feature-utils.js';

/** Header and dimension validation; SVG, remote URLs, and ordinary QQ photos are never collected. */
function imageInfo(bytes) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    let offset = 8, imageData = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + length + 12 > bytes.length) fail('INVALID_MEDIA', 'Truncated PNG');
      if (type === 'IDAT') imageData = true;
      offset += length + 12;
      if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!ended || !imageData) fail('INVALID_MEDIA', 'Incomplete PNG');
    return { ext: 'png', mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.at(-1) === 0x3b) return { ext: 'gif', mime: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 26 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      let marker = bytes[offset++]; while (marker === 0xff) marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 8) return { ext: 'jpg', mime: 'image/jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      offset += length;
    }
    fail('INVALID_MEDIA', 'JPEG has no valid dimensions');
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X') return { ext: 'webp', mime: 'image/webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (type === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { ext: 'webp', mime: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (type === 'VP8L' && bytes[20] === 0x2f) return { ext: 'webp', mime: 'image/webp', width: 1 + (bytes.readUInt32LE(21) & 0x3fff), height: 1 + ((bytes.readUInt32LE(21) >>> 14) & 0x3fff) };
  }
  fail('INVALID_MEDIA', 'Expected a PNG, JPEG, GIF, or WebP image');
}
async function readBounded(file, maxBytes) {
  const handle = await open(file, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes || metadata.size < 14) fail('INVALID_MEDIA', 'Sticker file size is invalid');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, metadata.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maxBytes || length !== metadata.size) fail('INVALID_MEDIA', 'Sticker changed or exceeds the size limit');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
export class StickerService {
  constructor({ db, config = {}, adapter, mediaRoot }) {
    Object.assign(this, { db, config, adapter, mediaRoot: resolve(mediaRoot ?? 'data/media') });
    db.exec('CREATE TABLE IF NOT EXISTS sticker_collect_pending(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)');
  }
  storeQuota(settings, incomingBytes = 0, incomingFiles = 0) {
    const maximumBytes = bounded(settings.maxStoreBytes, 268435456, 0, 10 * 1024 ** 3);
    const maximumFiles = bounded(settings.maxStoreFiles, 2000, 0, 100000);
    const rows = this.db.prepare('SELECT file,bytes FROM stickers').all();
    const bytes = rows.reduce((total, row) => {
      try { return total + statSync(row.file).size; }
      catch { return total + Math.max(0, Number(row.bytes) || 0); }
    }, 0);
    if (rows.length + incomingFiles > maximumFiles || bytes + incomingBytes > maximumBytes || (!incomingFiles && (rows.length >= maximumFiles || bytes >= maximumBytes))) fail('QUOTA_EXCEEDED', '贴纸库总容量或文件数量已达上限');
  }
  async cleanupOrphans(sourceFile) {
    const directory = join(this.mediaRoot, 'stickers');
    await mkdir(directory, { recursive: true }); await containedFile(this.mediaRoot, directory);
    const registered = new Set(this.db.prepare('SELECT file FROM stickers').all().map(row => resolve(row.file)));
    for (const item of await readdir(directory, {withFileTypes: true})) {
      const file = join(directory, item.name);
      if (!item.isFile() || !/^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/.test(item.name) || registered.has(resolve(file)) || resolve(file) === resolve(sourceFile)) continue;
      await containedFile(this.mediaRoot, file);
      await unlink(file);
      this.db.prepare('DELETE FROM media_assets WHERE path=?').run(file);
    }
  }
  reserveCollect(ctx) {
    const settings = enabled(this.config, 'stickers'); context(ctx);
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM sticker_collect_pending WHERE created_at<?').run(Date.now() - 3_600_000);
      this.storeQuota(settings);
      const allPending = this.db.prepare('SELECT COUNT(*) AS n FROM sticker_collect_pending').get().n;
      const stored = this.db.prepare('SELECT COUNT(*) AS n FROM stickers').get().n;
      if (stored + allPending >= bounded(settings.maxStoreFiles, 2000, 0, 100000)) fail('QUOTA_EXCEEDED', '贴纸库文件名额已用完或被预留');
      const pending = this.db.prepare('SELECT COUNT(*) AS n FROM sticker_collect_pending WHERE chat_id=?').get(ctx.chatId).n;
      const used = this.db.prepare("SELECT COUNT(*) AS n FROM sticker_events WHERE chat_id=? AND kind='collect' AND created_at>=?").get(ctx.chatId, Date.now() - 3_600_000).n;
      if (used + pending >= bounded(settings.maxPerGroupPerHour ?? settings.hourlyCollectLimit, 20, 0, 10000)) fail('QUOTA_EXCEEDED', '每小时贴纸收集额度已用完');
      const id = randomUUID();
      this.db.prepare('INSERT INTO sticker_collect_pending VALUES(?,?,?,?)').run(id, ctx.chatId, String(ctx.senderId), Date.now());
      return id;
    });
  }
  releaseCollect(id, ctx) {
    context(ctx);
    this.db.prepare('DELETE FROM sticker_collect_pending WHERE id=? AND chat_id=? AND actor_id=?').run(id, ctx.chatId, String(ctx.senderId));
  }
  quota(ctx, kind, maximum) {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM sticker_events WHERE chat_id=? AND kind IN (?,?) AND created_at>=?')
      .get(ctx.chatId, kind, `${kind}_pending`, Date.now() - 3_600_000).n;
    if (count >= maximum) fail('QUOTA_EXCEEDED', `Hourly sticker ${kind} limit reached`);
  }
  async collect(args = {}, ctx) {
    context(ctx);
    return storageLock(this.mediaRoot, async () => {
      const state = { reservation: args.reservation, created: null };
      try { return await this.collectReserved(args, ctx, state); }
      catch (error) { if (state.created) await unlink(state.created).catch(() => {}); throw error; }
      finally { if (state.reservation) this.releaseCollect(state.reservation, ctx); }
    });
  }
  async collectReserved(args, ctx, state) {
    const settings = enabled(this.config, 'stickers'); context(ctx);
    const source = args.segment?.data ?? args.segment ?? args;
    if (!(Number(source.sub_type ?? source.subType) === 1 || source.type === 'mface' || args.segment?.type === 'mface' || source.mface || source.emoji_id || source.emojiId)) fail('NOT_A_STICKER', 'Only QQ sticker or emoji messages can be collected');
    const file = await containedFile(this.mediaRoot, args.file ?? args.path);
    const maxBytes = bounded(settings.maxBytes, 4 * 1024 * 1024, 1, 32 * 1024 * 1024);
    const bytes = await readBounded(file, maxBytes);
    const info = imageInfo(bytes);
    const maxDimension = bounded(settings.maxDimension, 4096, 1, 16384);
    const maxRatio = bounded(settings.maxAspectRatio, 6, 1, 20);
    if (Math.min(info.width, info.height) < (settings.minDimension ?? 1) || Math.max(info.width, info.height) > maxDimension || Math.max(info.width / info.height, info.height / info.width) > maxRatio) fail('INVALID_MEDIA', 'Sticker dimensions exceed the configured limit');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await this.cleanupOrphans(file);
    const existing = this.db.prepare('SELECT * FROM stickers WHERE hash=?').get(hash);
    if (existing) {
      // Hashes are global for deduplication, while source-chat visibility remains private.
      if (ctx.role !== 'master' && existing.source_chat_id !== ctx.chatId) fail('ALREADY_EXISTS', 'This image is already stored in another chat');
      return { ...existing, tags: JSON.parse(existing.tags), duplicate: true };
    }
    state.reservation ??= this.reserveCollect(ctx);
    const reservation = this.db.prepare('SELECT * FROM sticker_collect_pending WHERE id=? AND chat_id=? AND actor_id=? AND created_at>=?').get(state.reservation, ctx.chatId, String(ctx.senderId), Date.now() - 3_600_000);
    if (!reservation) fail('QUOTA_EXCEEDED', '贴纸额度预留无效或已过期');
    this.storeQuota(settings, bytes.length, 1);
    const tags = (Array.isArray(args.tags) ? args.tags : []).slice(0, 20).map(tag => safeText(tag, 'tag', 40));
    const emotion = safeText(args.emotion ?? '', 'emotion', 60, true);
    const directory = join(this.mediaRoot, 'stickers');
    await mkdir(directory, { recursive: true }); await containedFile(this.mediaRoot, directory);
    const target = join(directory, `${hash}.${info.ext}`);
    // Write the verified bytes rather than re-reading a mutable source file.
    const output = await open(target, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') return null; throw error; });
    if (output) { state.created = target; try { await output.writeFile(bytes); } finally { await output.close(); } }
    await containedFile(this.mediaRoot, target);
    if (!output && createHash('sha256').update(await readBounded(target, maxBytes)).digest('hex') !== hash) fail('INVALID_MEDIA', 'Existing sticker does not match its content hash');
    const result = this.db.transaction(() => {
      this.quota(ctx, 'collect', bounded(settings.maxPerGroupPerHour ?? settings.hourlyCollectLimit, 20, 0, 10000));
      const entry = this.db.prepare('INSERT OR IGNORE INTO stickers(hash,file,tags,emotion,source_chat_id,actor_id,mime,width,height,bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(hash, target, JSON.stringify(tags), emotion, ctx.chatId, String(ctx.senderId), info.mime, info.width, info.height, bytes.length, Date.now());
      const record = this.db.prepare('SELECT * FROM stickers WHERE hash=?').get(hash);
      if (ctx.role !== 'master' && record.source_chat_id !== ctx.chatId) fail('ALREADY_EXISTS', 'This image is already stored in another chat');
      if (entry.changes) this.db.prepare("INSERT INTO sticker_events(sticker_id,chat_id,kind,created_at) VALUES(?,?,'collect',?)").run(record.id, ctx.chatId, Date.now());
      audit(this.db, 'sticker.collect', ctx, { id: record.id, hash });
      return record;
    });
    return { ...result, tags: JSON.parse(result.tags) };
  }
  search(args = {}, ctx) {
    enabled(this.config, 'stickers'); context(ctx);
    const query = safeText(args.tag ?? args.query ?? '', 'tag', 100, true).replace(/[\\%_]/g, '\\$&');
    return this.db.prepare(`SELECT * FROM stickers WHERE (?=1 OR source_chat_id=?) AND (tags LIKE ? ESCAPE '\\' OR emotion LIKE ? ESCAPE '\\') ORDER BY usage_count ASC,created_at DESC LIMIT ?`)
      .all(Number(ctx.role === 'master'), ctx.chatId, `%${query}%`, `%${query}%`, Math.floor(bounded(args.limit, 10, 1, 50))).map(row => ({ ...row, tags: JSON.parse(row.tags) }));
  }
  async send(args = {}, ctx) {
    const settings = enabled(this.config, 'stickers'); context(ctx);
    ctx.signal?.throwIfAborted();
    const record = args.id || args.stickerId ? this.db.prepare('SELECT * FROM stickers WHERE id=? AND (?=1 OR source_chat_id=?)').get(rowId(args.id ?? args.stickerId), Number(ctx.role === 'master'), ctx.chatId) : this.search({ tag: args.tag, limit: 1 }, ctx)[0];
    if (!record) fail('NOT_FOUND', 'No matching sticker in this chat');
    await containedFile(this.mediaRoot, record.file);
    const bytes = await readBounded(record.file, bounded(settings.maxBytes, 4 * 1024 * 1024, 1, 32 * 1024 * 1024));
    if (createHash('sha256').update(bytes).digest('hex') !== record.hash) fail('INVALID_MEDIA', 'Stored sticker failed its content integrity check');
    ctx.signal?.throwIfAborted();
    const eventId = this.db.transaction(() => {
      this.quota(ctx, 'send', bounded(settings.maxPerGroupPerHour ?? settings.hourlySendLimit, 20, 0, 10000));
      return Number(this.db.prepare("INSERT INTO sticker_events(sticker_id,chat_id,kind,created_at) VALUES(?,?,'send_pending',?)").run(record.id, ctx.chatId, Date.now()).lastInsertRowid);
    });
    const send = this.adapter?.sendSticker ?? this.adapter?.sendImage;
    if (!send) { this.db.prepare('DELETE FROM sticker_events WHERE id=?').run(eventId); return { ...record, delivery: 'prepared' }; }
    try { ctx.signal?.throwIfAborted(); await send.call(this.adapter, ctx.chatId, record.file, {context: ctx, signal: ctx.signal}); }
    catch (error) { this.db.prepare('DELETE FROM sticker_events WHERE id=?').run(eventId); throw error; }
    this.db.transaction(() => {
      this.db.prepare("UPDATE sticker_events SET kind='send' WHERE id=?").run(eventId);
      this.db.prepare('UPDATE stickers SET usage_count=usage_count+1 WHERE id=?').run(record.id);
      audit(this.db, 'sticker.send', ctx, { id: record.id });
    });
    return { ...record, usage_count: record.usage_count + 1, delivery: 'sent' };
  }
}
export default StickerService;
