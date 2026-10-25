import { randomUUID } from 'node:crypto';
import { audit, bounded, context, enabled, fail, master, rowId, sensitive } from './feature-utils.js';

const KINDS = new Set(['letter_send', 'text_send', 'qzone_post', 'reflection']);
function jobRecord(row) { return row ? { ...row, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null } : null; }
function protectedPayload(value, depth = 0) {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some(item => protectedPayload(item, depth + 1));
  return value && typeof value === 'object' && Object.entries(value).some(([key, item]) => /^(?:__proto__|constructor|prototype|password|passwd|api[_-]?key|access[_-]?token|secret|authorization)$/i.test(key) || protectedPayload(item, depth + 1));
}

/** Persistent, at-least-once jobs. Delivery handlers must recheck current authorization. */
export class Scheduler {
  constructor({ db, config = {}, logger = console, clock = Date.now }) {
    Object.assign(this, { db, config, logger, now: clock });
    this.owner = randomUUID(); this.handlers = new Map(); this.timer = null; this.running = null;
  }
  register(kind, handler) {
    if (!KINDS.has(kind) || typeof handler !== 'function') fail('INVALID_ARGUMENT', 'Register a supported job kind and a function');
    this.handlers.set(kind, handler); return this;
  }
  schedule(args = {}, ctx) {
    const settings = enabled(this.config, 'scheduler'); master(ctx);
    if (!KINDS.has(args.kind)) fail('INVALID_ARGUMENT', 'Unsupported scheduled task kind');
    const chatId = args.chatId ?? ctx.chatId; context({ ...ctx, chatId });
    const input = args.runAt ?? args.run_at ?? this.now();
    const runAt = typeof input === 'string' ? Date.parse(input) : Number(input);
    bounded(runAt, this.now(), this.now() - 60_000, this.now() + 366 * 86_400_000);
    const payload = args.payload ?? {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || ![Object.prototype, null].includes(Object.getPrototypeOf(payload))) fail('INVALID_ARGUMENT', 'Job payload must be a plain object');
    let encoded;
    try { encoded = JSON.stringify(payload); } catch { fail('INVALID_ARGUMENT', 'Job payload must be JSON serializable'); }
    if (encoded.length > 64_000 || sensitive(encoded) || protectedPayload(payload)) fail('INVALID_ARGUMENT', 'Job payload contains protected data or is too large');
    const maxAttempts = Math.floor(bounded(args.maxAttempts, settings.maxAttempts ?? 3, 1, 10));
    return this.db.transaction(() => {
      const pending = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running','retry')").get().n;
      if (pending >= bounded(settings.maxPending, 100, 1, 10000)) fail('QUOTA_EXCEEDED', 'Pending job limit reached');
      const now = this.now();
      const result = this.db.prepare('INSERT INTO jobs(kind,chat_id,self_id,payload,run_at,status,actor_id,actor_role,turn_id,max_attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(args.kind, chatId, ctx.selfId == null ? null : String(ctx.selfId), encoded, runAt, 'pending', String(ctx.senderId), ctx.role, ctx.turnId ?? null, maxAttempts, now, now);
      const id = Number(result.lastInsertRowid); audit(this.db, 'schedule.create', ctx, { id, kind: args.kind, runAt, chatId });
      return jobRecord(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
    });
  }
  list(args = {}, ctx) {
    enabled(this.config, 'scheduler'); master(ctx);
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(Math.floor(bounded(args.limit, 50, 1, 200))).map(jobRecord);
  }
  cancel(args = {}, ctx) {
    enabled(this.config, 'scheduler'); master(ctx);
    const id = rowId(args.id);
    const result = this.db.prepare("UPDATE jobs SET status='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status IN ('pending','retry')").run(this.now(), id);
    if (!result.changes) fail('INVALID_STATE', 'Only a queued job can be cancelled');
    audit(this.db, 'schedule.cancel', ctx, { id }); return jobRecord(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
  }
  claim(settings) {
    return this.db.transaction(() => {
      const now = this.now();
      const expired = this.db.prepare("SELECT id,chat_id,actor_id,turn_id FROM jobs WHERE status='running' AND lease_until<=? AND attempts>=max_attempts").all(now);
      this.db.prepare("UPDATE jobs SET status='failed',last_error='Worker lease expired after final attempt',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='running' AND lease_until<=? AND attempts>=max_attempts").run(now, now);
      for (const job of expired) audit(this.db, 'schedule.lease_failed', { chatId: job.chat_id, senderId: job.actor_id, turnId: job.turn_id }, { id: job.id });
      const row = this.db.prepare("SELECT * FROM jobs WHERE ((status IN ('pending','retry') AND run_at<=?) OR (status='running' AND lease_until<=?)) AND attempts<max_attempts ORDER BY run_at,id LIMIT 1").get(now, now);
      if (!row) return null;
      const leaseMs = bounded(settings.leaseMs, 60_000, 100, 3_600_000);
      const token = `${this.owner}:${randomUUID()}`;
      this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=?").run(token, now + leaseMs, now, row.id);
      return { ...jobRecord(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id)), token, leaseMs };
    });
  }
  async execute(job, settings) {
    const controller = new AbortController();
    let timeout;
    const heartbeat = setInterval(() => {
      try {
        const result = this.db.prepare("UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=?")
          .run(this.now() + job.leaseMs, this.now(), job.id, job.token);
        if (!result.changes) controller.abort(new Error('Job lease lost'));
      } catch (error) { controller.abort(error); }
    }, Math.max(25, Math.floor(job.leaseMs / 3)));
    heartbeat.unref?.();
    const ctx = { chatId: job.chat_id, selfId: job.self_id, senderId: job.actor_id, role: job.actor_role, turnId: job.turn_id, scheduled: true, jobId: job.id, signal: controller.signal };
    try {
      const handler = this.handlers.get(job.kind);
      if (!handler) fail('UNSUPPORTED', `No handler registered for ${job.kind}`);
      const result = await Promise.race([
        Promise.resolve().then(() => handler(job.payload, { ...job, context: ctx, signal: controller.signal })),
        new Promise((_, reject) => { timeout = setTimeout(() => { const error = new Error('Scheduled task timed out'); controller.abort(error); reject(error); }, bounded(settings.jobTimeoutMs, 120_000, 100, 900_000)); }),
      ]);
      if (controller.signal.aborted) throw controller.signal.reason;
      let encoded;
      try { encoded = JSON.stringify(result ?? null); } catch { encoded = JSON.stringify({ completed: true }); }
      if (encoded.length > 8000 || sensitive(encoded)) encoded = JSON.stringify({ completed: true });
      const update = this.db.prepare("UPDATE jobs SET status='completed',result=?,lease_owner=NULL,lease_until=NULL,completed_at=?,updated_at=? WHERE id=? AND lease_owner=? AND status='running'")
        .run(encoded, this.now(), this.now(), job.id, job.token);
      if (update.changes) audit(this.db, 'schedule.complete', ctx, { id: job.id, attempts: job.attempts });
    } catch (error) {
      const retry = job.attempts < job.max_attempts;
      const delay = Math.min(bounded(settings.maxBackoffMs, 3_600_000, 100, 86_400_000), bounded(settings.retryBaseMs, 5000, 1, 3_600_000) * 2 ** (job.attempts - 1));
      const description = sensitive(error?.message) ? 'Scheduled task failed' : String(error?.message ?? error).slice(0, 1000);
      const update = this.db.prepare("UPDATE jobs SET status=?,run_at=?,last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_owner=? AND status='running'")
        .run(retry ? 'retry' : 'failed', this.now() + delay, description, this.now(), job.id, job.token);
      if (update.changes) audit(this.db, 'schedule.fail', ctx, { id: job.id, attempts: job.attempts, retry });
      this.logger?.warn?.(`Scheduled job ${job.id} ${retry ? 'will retry' : 'failed'}: ${description}`);
    } finally { clearInterval(heartbeat); clearTimeout(timeout); }
  }
  tick() {
    if (this.running) return this.running;
    const settings = enabled(this.config, 'scheduler');
    this.running = (async () => {
      let count = 0;
      for (; count < bounded(settings.maxBatch, 10, 1, 100); count++) {
        const job = this.claim(settings); if (!job) break;
        await this.execute(job, settings);
      }
      return { processed: count };
    })().finally(() => { this.running = null; });
    return this.running;
  }
  start() {
    const settings = enabled(this.config, 'scheduler');
    if (this.timer) return;
    const run = () => { Promise.resolve().then(() => this.tick()).catch(error => this.logger?.error?.(`Scheduler: ${error.message}`)); };
    this.timer = setInterval(run, bounded(settings.intervalMs ?? settings.pollMs, 1000, 100, 60_000)); this.timer.unref?.(); run();
  }
  async stop() { clearInterval(this.timer); this.timer = null; if (this.running) await this.running; }
}
export { KINDS as SCHEDULE_KINDS };
export default Scheduler;
