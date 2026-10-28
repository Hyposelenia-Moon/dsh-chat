import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {Agent, ProxyAgent, fetch} from 'undici';
import {bounded, context} from './feature-utils.js';

export function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b)));
  }
  if (net.isIP(address) === 6) {
    const v = address.toLowerCase();
    if (v.startsWith('::ffff:')) return false;
    return /^[23][0-9a-f]{3}:/.test(v) && !v.startsWith('2001:db8:') && !v.startsWith('2002:');
  }
  return false;
}
export function imageType(b) {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (b.length >= 10 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return 'gif';
  if (b.length >= 16 && b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP') return 'webp';
  throw new Error('媒体必须为 PNG、JPEG、GIF 或 WebP 图片');
}
export class MediaStore {
  constructor({root, config, logger, db}) {
    this.root = path.resolve(root); this.config = config; this.logger = logger; this.db = db;
    fs.mkdirSync(this.root, {recursive: true});
    db?.exec('CREATE TABLE IF NOT EXISTS media_assets(path TEXT NOT NULL,chat_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(path,chat_id))');
    db?.exec('CREATE TABLE IF NOT EXISTS media_download_events(chat_id TEXT NOT NULL,created_at INTEGER NOT NULL)');
    this.downloadEvents = new Map();
    this.timer = setInterval(() => { try { this.cleanup(); } catch { this.logger?.warn('media_cleanup_failed'); } }, this.settings().cleanupIntervalMs);
    this.timer.unref();
  }
  settings() {
    const value = this.config?.media ?? {};
    return {...value,
      maxBytes: bounded(value.maxBytes, 8 * 1024 * 1024, 1, 64 * 1024 * 1024),
      timeoutMs: bounded(value.timeoutMs, 15000, 1, 300000),
      ttlHours: bounded(value.ttlHours, 24, 0, 8760),
      maxCacheBytes: bounded(value.maxCacheBytes, 128 * 1024 * 1024, 0, 10 * 1024 ** 3),
      maxDownloadsPerChatPerHour: bounded(value.maxDownloadsPerChatPerHour, 60, 0, 100000),
      cleanupIntervalMs: bounded(value.cleanupIntervalMs, 300000, 10, 86400000)};
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  local(file,ctx) {
    if (typeof file !== 'string' || file.includes('\0')) throw new Error('文件路径无效');
    const resolved = fs.realpathSync(path.resolve(this.root, file));
    const relative = path.relative(fs.realpathSync(this.root), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(resolved).isFile()) throw new Error('文件必须位于插件媒体目录内');
    if (fs.statSync(resolved).size > this.settings().maxBytes) throw new Error('文件超出大小限制');
    if (ctx) {
      context(ctx);
      const uploadDirectory = /^\d+$/.test(String(ctx.selfId ?? '')) ? path.join(this.root,'uploads',String(ctx.selfId),ctx.chatId.replace(':','_')) : null;
      const inUploads = uploadDirectory && fs.existsSync(uploadDirectory) && !path.relative(fs.realpathSync(uploadDirectory),resolved).startsWith('..') && !path.isAbsolute(path.relative(fs.realpathSync(uploadDirectory),resolved));
      if (!inUploads && !this.db?.prepare('SELECT 1 FROM media_assets WHERE path=? AND chat_id=?').get(resolved,ctx.storageKey ?? ctx.chatId)) throw new Error('媒体文件未授权给当前聊天');
    }
    return resolved;
  }
  register(file,ctx) {
    const resolved=this.local(file);
    if (!ctx?.chatId || !this.db) throw new Error('媒体授权需要数据库和会话上下文');
    this.db.prepare('INSERT OR IGNORE INTO media_assets(path,chat_id,created_at) VALUES(?,?,?)').run(resolved,ctx.storageKey ?? ctx.chatId,Date.now());
    return resolved;
  }
  async image({path: file, url},ctx) {
    if (file) { const safe = this.local(file,ctx); imageType(fs.readFileSync(safe)); return safe; }
    if (!url) throw new Error('请提供图片 path 或 url');
    const bytes = await this.download(url,ctx);
    const ext = imageType(bytes), directory = path.join(this.root, 'cache');
    fs.mkdirSync(directory, {recursive: true});
    this.localDirectory(directory);
    const output = path.join(directory, `${createHash('sha256').update(bytes).digest('hex')}.${ext}`);
    this.cleanup();
    this.cleanup(fs.existsSync(output) ? 0 : bytes.length);
    let created = false;
    try {
      let descriptor;
      try {
        descriptor = fs.openSync(output, 'wx', 0o600); created = true;
        fs.writeFileSync(descriptor, bytes);
      } catch (error) { if (error.code !== 'EEXIST') throw error; this.local(output); }
      finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
      if (ctx) this.register(output,ctx);
      return output;
    } catch (error) { if (created) { fs.unlinkSync(output); this.db?.prepare('DELETE FROM media_assets WHERE path=?').run(output); } throw error; }
  }
  async download(rawUrl,ctx) {
    if (ctx) context(ctx);
    const chatId = ctx?.storageKey ?? ctx?.chatId ?? '__local__', now = Date.now();
    const maximum = this.settings().maxDownloadsPerChatPerHour;
    if (this.db) this.db.transaction(() => {
      this.db.prepare('DELETE FROM media_download_events WHERE created_at<?').run(now - 3_600_000);
      if (this.db.prepare('SELECT COUNT(*) AS n FROM media_download_events WHERE chat_id=?').get(chatId).n >= maximum) throw new Error('当前聊天每小时媒体下载额度已用完');
      this.db.prepare('INSERT INTO media_download_events VALUES(?,?)').run(chatId, now);
    });
    else {
      for (const [key, values] of this.downloadEvents) { const live = values.filter(time => time > now - 3_600_000); if (live.length) this.downloadEvents.set(key, live); else this.downloadEvents.delete(key); }
      const events = this.downloadEvents.get(chatId) ?? [];
      if (events.length >= maximum) throw new Error('当前聊天每小时媒体下载额度已用完');
      events.push(now); this.downloadEvents.set(chatId, events);
    }
    return this.fetchDownload(rawUrl);
  }
  async fetchDownload(rawUrl) {
    let url = new URL(rawUrl);
    for (let redirects = 0; redirects < 4; redirects++) {
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('媒体地址必须为公开 HTTPS 地址');
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await dns.lookup(hostname, {all: true});
      if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('媒体地址指向了受限网络');
      const chosen = addresses.find(a => a.family === 4) || addresses[0];
      const dispatcher = new Agent({connect: {lookup: (_h, options, callback) => callback(null, options.all ? [chosen] : chosen.address, chosen.family)}});
      let response, usedProxy;
      try {
        response = await fetch(url, {dispatcher, redirect: 'manual', signal: AbortSignal.timeout(this.settings().timeoutMs)});
      } catch (error) {
        await dispatcher.close();
        const proxy = this.settings().proxyUrl || process.env.HTTPS_PROXY || process.env.https_proxy;
        if (!proxy || !/(^|\.)(qpic\.cn|qq\.com|qlogo\.cn)$/.test(hostname)) throw new Error('图片直连下载失败；可为 QQ 媒体配置 media.proxyUrl', {cause: error});
        usedProxy = new ProxyAgent(proxy);
        response = await fetch(url, {dispatcher: usedProxy, redirect: 'manual', signal: AbortSignal.timeout(this.settings().timeoutMs)});
        this.logger?.info('media_proxy_fallback', {hostname});
      }
      try {
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel(); if (!location) throw new Error('图片重定向地址缺失');
          url = new URL(location, url); continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`图片下载失败 (${response.status})`); }
        if (Number(response.headers.get('content-length') || 0) > this.settings().maxBytes) { await response.body?.cancel(); throw new Error('图片超出大小限制'); }
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > this.settings().maxBytes) { await response.body?.cancel().catch(() => {}); throw new Error('图片超出大小限制'); }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      } finally { await dispatcher.close(); await usedProxy?.close(); }
    }
    throw new Error('图片重定向次数过多');
  }
  localDirectory(directory) {
    const relative = path.relative(fs.realpathSync(this.root), fs.realpathSync(directory));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('媒体缓存目录越界');
  }
  cleanup(incomingBytes = 0) {
    const directory = path.join(this.root, 'cache'), settings = this.settings();
    if (incomingBytes > settings.maxCacheBytes) throw new Error('图片超出媒体缓存总容量限制');
    if (fs.existsSync(directory)) {
      this.localDirectory(directory);
      const files = fs.readdirSync(directory, {withFileTypes: true}).filter(item => item.isFile()).map(item => {
        const file = path.join(directory, item.name); return {file, ...fs.statSync(file)};
      }).sort((a,b) => a.mtimeMs - b.mtimeMs);
      let total = files.reduce((sum, file) => sum + file.size, 0);
      for (const file of files) {
        if (file.mtimeMs < Date.now() - settings.ttlHours * 3600000 || total + incomingBytes > settings.maxCacheBytes) {
          fs.unlinkSync(file.file); total -= file.size;
          this.db?.prepare('DELETE FROM media_assets WHERE path=?').run(file.file);
        }
      }
    }
    if (this.db) for (const row of this.db.prepare('SELECT DISTINCT path FROM media_assets').all()) {
      try { this.local(row.path); }
      catch { this.db.prepare('DELETE FROM media_assets WHERE path=?').run(row.path); }
    }
  }
}
