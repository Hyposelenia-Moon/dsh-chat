import { realpath } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';

export class FeatureError extends Error {
  constructor(code, message) { super(message); this.name = 'FeatureError'; this.code = code; }
}
export function fail(code, message) { throw new FeatureError(code, message); }
export function enabled(config, feature) {
  const value = config?.[feature];
  const active = typeof value === 'boolean' ? value : value?.enabled;
  if (active !== true && !(feature === 'scheduler' && active === undefined)) fail('FEATURE_DISABLED', `${feature} is disabled`);
  return typeof value === 'object' ? value : {};
}
export function context(ctx) {
  if (!ctx || !/^(?:private|group):[^\s:]+$/.test(ctx.chatId ?? '') || !ctx.senderId) fail('INVALID_CONTEXT', 'A trusted chat and sender context is required');
  return ctx;
}
export function master(ctx) { context(ctx); if (ctx.role !== 'master') fail('FORBIDDEN', 'Owner approval is required'); }
export function text(value, name = 'text', max = 8000, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || /\u0000/.test(value)) fail('INVALID_ARGUMENT', `${name} must be text of at most ${max} characters`);
  return value.trim();
}
const SECRET = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[_A-Za-z0-9-]{12,}|(?:\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)|密码|密钥|口令)\s*[:=：]\s*\S{3,}|\bBearer\s+[A-Za-z0-9._~-]{12,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[0-9X](?!\d))/i;
export function sensitive(value) { return SECRET.test(String(value)); }
export function safeText(value, name, max = 8000, allowEmpty = false) {
  const clean = text(value, name, max, allowEmpty);
  if (sensitive(clean)) fail('SENSITIVE_CONTENT', `${name} contains a secret or personal contact detail`);
  return clean;
}
export function bounded(value, fallback, min, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) fail('INVALID_ARGUMENT', `Expected a number between ${min} and ${max}`);
  return number;
}
export async function containedFile(root, file) {
  if (!root || typeof file !== 'string') fail('INVALID_PATH', 'A controlled media file is required');
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
  const part = relative(realRoot, realFile);
  if (!part || part === '..' || part.startsWith(`..\\`) || part.startsWith('../') || isAbsolute(part)) fail('INVALID_PATH', 'File is outside the configured media directory');
  return realFile;
}
export function audit(db, event, ctx, detail = {}) {
  if (typeof db.audit === 'function') db.audit(event, ctx, detail);
  else db.prepare('INSERT INTO audit(event,actor_id,chat_id,turn_id,detail,created_at) VALUES(?,?,?,?,?,?)')
    .run(event, ctx?.senderId ?? null, ctx?.chatId ?? null, ctx?.turnId ?? null, JSON.stringify(detail), Date.now());
}
const storageLocks = new Map();
export async function storageLock(key, callback) {
  const previous = storageLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  storageLocks.set(key, current);
  await previous;
  try { return await callback(); }
  finally { release(); if (storageLocks.get(key) === current) storageLocks.delete(key); }
}
export function rowId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail('INVALID_ARGUMENT', 'A positive record id is required');
  return id;
}
