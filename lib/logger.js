import fs from 'node:fs';
import path from 'node:path';
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(api.?key|access.?token|refresh.?token|authorization|password|secret|cookie)$/i.test(k) ? '[redacted]' : redact(v)]));
  if (typeof value !== 'string') return value;
  return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]').replace(/(https?:\/\/[^\s/]+\/mcp\/)[^\s/"?]+/g, '$1[redacted]').replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]').replace(/(api[_-]?key|token|password|secret)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[redacted]');
}
export class Logger {
  constructor({directory, maxBytes = 5242880, retentionDays = 30}) { this.directory = directory; this.maxBytes = maxBytes; this.retentionDays = retentionDays; fs.mkdirSync(directory, {recursive: true}); this.file = path.join(directory, 'events.jsonl'); }
  log(level, event, fields = {}) {
    if (fs.existsSync(this.file) && fs.statSync(this.file).size >= this.maxBytes) {
      fs.renameSync(this.file, path.join(this.directory, `events-${Date.now()}.jsonl`));
      const files = fs.readdirSync(this.directory).filter(n => /^events-\d+\.jsonl$/.test(n)).sort();
      for (const n of files) if (Number(n.slice(7, -6)) < Date.now() - this.retentionDays * 86400000) fs.unlinkSync(path.join(this.directory, n));
    }
    fs.appendFileSync(this.file, JSON.stringify(redact({time: new Date().toISOString(), level, event, ...fields})) + '\n', {mode: 0o600});
  }
  info(event, fields) { this.log('info', event, fields); }
  warn(event, fields) { this.log('warn', event, fields); }
  error(event, fields) { this.log('error', event, fields); }
  debug(event, fields) { this.log('debug', event, fields); }
  recent(limit = 15) { return fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-limit).filter(Boolean).map(s => JSON.parse(s)) : []; }
}
