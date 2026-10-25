import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {Agent, ProxyAgent, fetch} from 'undici';

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
  }
  local(file,ctx) {
    if (typeof file !== 'string' || file.includes('\0')) throw new Error('文件路径无效');
    const resolved = fs.realpathSync(path.resolve(this.root, file));
    const relative = path.relative(fs.realpathSync(this.root), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(resolved).isFile()) throw new Error('文件必须位于插件媒体目录内');
    if (fs.statSync(resolved).size > this.config.media.maxBytes) throw new Error('文件超出大小限制');
    if (ctx) {
      const uploadDirectory = path.join(this.root,'uploads',ctx.chatId.replace(':','_'));
      const inUploads = fs.existsSync(uploadDirectory) && !path.relative(fs.realpathSync(uploadDirectory),resolved).startsWith('..') && !path.isAbsolute(path.relative(fs.realpathSync(uploadDirectory),resolved));
      if (!inUploads && !this.db?.prepare('SELECT 1 FROM media_assets WHERE path=? AND chat_id=?').get(resolved,ctx.chatId)) throw new Error('媒体文件未授权给当前聊天');
    }
    return resolved;
  }
  register(file,ctx) {
    const resolved=this.local(file);
    if (!ctx?.chatId || !this.db) throw new Error('媒体授权需要数据库和会话上下文');
    this.db.prepare('INSERT OR IGNORE INTO media_assets(path,chat_id,created_at) VALUES(?,?,?)').run(resolved,ctx.chatId,Date.now());
    return resolved;
  }
  async image({path: file, url},ctx) {
    if (file) { const safe = this.local(file,ctx); imageType(fs.readFileSync(safe)); return safe; }
    if (!url) throw new Error('请提供图片 path 或 url');
    const bytes = await this.download(url);
    const ext = imageType(bytes), directory = path.join(this.root, 'cache');
    fs.mkdirSync(directory, {recursive: true});
    const output = path.join(directory, `${createHash('sha256').update(bytes).digest('hex')}.${ext}`);
    fs.writeFileSync(output, bytes, {mode: 0o600}); if (ctx) this.register(output,ctx); return output;
  }
  async download(rawUrl) {
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
        response = await fetch(url, {dispatcher, redirect: 'manual', signal: AbortSignal.timeout(this.config.media.timeoutMs)});
      } catch (error) {
        await dispatcher.close();
        const proxy = this.config.media.proxyUrl || process.env.HTTPS_PROXY || process.env.https_proxy;
        if (!proxy || !/(^|\.)(qpic\.cn|qq\.com|qlogo\.cn)$/.test(hostname)) throw new Error('图片直连下载失败；可为 QQ 媒体配置 media.proxyUrl', {cause: error});
        usedProxy = new ProxyAgent(proxy);
        response = await fetch(url, {dispatcher: usedProxy, redirect: 'manual', signal: AbortSignal.timeout(this.config.media.timeoutMs)});
        this.logger?.info('media_proxy_fallback', {hostname});
      }
      try {
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel(); if (!location) throw new Error('图片重定向地址缺失');
          url = new URL(location, url); continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`图片下载失败 (${response.status})`); }
        if (Number(response.headers.get('content-length') || 0) > this.config.media.maxBytes) { await response.body?.cancel(); throw new Error('图片超出大小限制'); }
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > this.config.media.maxBytes) { await response.body?.cancel().catch(() => {}); throw new Error('图片超出大小限制'); }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      } finally { await dispatcher.close(); await usedProxy?.close(); }
    }
    throw new Error('图片重定向次数过多');
  }
  cleanup() {
    const directory = path.join(this.root, 'cache');
    if (!fs.existsSync(directory)) return;
    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, item.name);
      if (item.isFile() && fs.statSync(file).mtimeMs < Date.now() - this.config.media.ttlHours * 3600000) fs.unlinkSync(file);
    }
  }
}
