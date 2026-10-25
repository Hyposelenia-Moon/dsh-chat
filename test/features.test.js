import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../model/db.js';
import { MemoryService } from '../lib/memory.js';
import { LearningService } from '../lib/learning.js';
import { StickerService } from '../lib/stickers.js';
import { LettersService } from '../lib/letters.js';
import { Scheduler } from '../lib/scheduler.js';
import { QzoneService } from '../lib/qzone.js';

const member = { chatId: 'group:123', senderId: '456', role: 'member' };
const owner = { chatId: 'private:789', senderId: '789', selfId: '987654', role: 'master' };
const errorCode = expected => error => error.code === expected;
async function setup(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-chat-features-'));
  const mediaRoot = join(root, 'media'); await mkdir(mediaRoot);
  const db = new Store({ path: join(root, 'test.sqlite') });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { db, config, mediaRoot, root };
}

test('SQLite persists sessions, audit, and unique gateway messages', async t => {
  const { db } = await setup(t);
  db.prepare('INSERT INTO sessions(chat_id,chat_type,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('group:1', 'group', 'acp-1', 1, 1);
  const insert = db.prepare('INSERT OR IGNORE INTO messages(chat_id,role,qq_message_id,created_at) VALUES(?,?,?,?)');
  assert.equal(insert.run('group:1', 'user', 'message-1', 1).changes, 1);
  assert.equal(insert.run('group:1', 'user', 'message-1', 1).changes, 0);
  assert.throws(() => db.transaction(() => { db.audit('rollback', owner); throw new Error('rollback'); }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0);
  db.exec('ALTER TABLE jobs DROP COLUMN self_id; PRAGMA user_version=1;');
  const upgraded = new Store({ path: db.path });
  try {
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 2);
    assert.ok(upgraded.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'self_id'));
    assert.equal(upgraded.prepare('SELECT session_id FROM sessions').get().session_id, 'acp-1');
  } finally { upgraded.close(); }
});

test('memory supports Chinese search, scope isolation, forgetting, and restoration', async t => {
  const options = await setup(t, { memory: { enabled: true } });
  const service = new MemoryService(options);
  const a = service.write({ content: '喜欢喝茉莉花茶', kind: 'preference' }, member);
  service.write({ scope: 'group', content: '周末讨论科幻小说', kind: 'rule' }, member);
  service.write({ content: '只喝咖啡', scope: 'user', scopeId: '999' }, owner);
  assert.equal(service.search({ query: '茉莉' }, member)[0].id, a.id);
  assert.equal(service.search({ query: '咖啡' }, member).length, 0);
  assert.equal(service.search({ query: '科幻', scope: 'group' }, member).length, 1);
  assert.throws(() => service.search({ query: '咖啡', scope: 'user', scopeId: '999' }, member), errorCode('FORBIDDEN'));
  assert.throws(() => service.write({ content: '越权', scope: 'global' }, member), errorCode('FORBIDDEN'));
  assert.throws(() => service.forget({ id: a.id }, member), errorCode('FORBIDDEN'));
  service.forget({ id: a.id }, owner);
  assert.equal(service.search({ query: '茉莉' }, member).length, 0);
  service.restore({ id: a.id }, owner);
  assert.equal(service.search({ query: '茉莉' }, member).length, 1);
});

test('memory rejects secrets and enforces daily automatic quota from the default config key', async t => {
  const service = new MemoryService(await setup(t, { memory: { enabled: true, maxAutomaticPerDay: 1 } }));
  assert.throws(() => service.write({ content: 'api_key=sk-123456789012345678901234' }, member), errorCode('SENSITIVE_CONTENT'));
  service.write({ content: '喜欢轻松的语气' }, member);
  assert.throws(() => service.write({ content: '喜欢简短回复' }, member), errorCode('QUOTA_EXCEEDED'));
  assert.ok(service.write({ content: '主人手工记录', manual: true }, owner).id);
});

test('conversational Chinese queries rank shared phrases without crossing chat scopes', async t => {
  const service = new MemoryService(await setup(t, { memory: { enabled: true } }));
  const tea = service.write({ content: '喜欢喝绿茶', kind: 'preference' }, member);
  service.write({ content: '周末喜欢打羽毛球', kind: 'preference', importance: 1 }, member);
  service.write({ content: '工作使用 Docker 容器', kind: 'fact' }, member);
  service.write({ content: '喜欢喝绿茶和茉莉花茶', kind: 'preference' }, { ...member, chatId: `private:${member.senderId}` });
  assert.equal(service.search({ query: '你还记得我喜欢喝什么吗' }, member)[0].id, tea.id);
  assert.equal(service.search({ query: '我平时喝绿茶的偏好你知道吗' }, member)[0].id, tea.id);
  assert.equal(service.search({ query: 'Docker' }, member)[0].content, '工作使用 Docker 容器');
  assert.equal(service.search({ query: '你还记得我喜欢喝什么吗', scope: 'user' }, member).some(row => row.source_chat_id !== member.chatId), false);
  assert.equal(service.search({ query: '你还记得我喜欢喝什么吗' }, { ...member, chatId: 'group:999' }).length, 0);
  assert.doesNotThrow(() => service.search({ query: '你还记得我喜欢喝什么吗'.repeat(30) }, member));
});

test('same user memory stays in its source chat across private and group conversations', async t => {
  const service = new MemoryService(await setup(t, { memory: { enabled: true } }));
  const privateCtx = { ...member, chatId: `private:${member.senderId}` };
  const privateRecord = service.write({ content: '个人偏好是茉莉花茶', scope: 'user' }, privateCtx);
  assert.equal(service.search({ query: '茉莉' }, member).length, 0);
  assert.equal(service.search({ query: '茉莉', scope: 'user' }, member).length, 0);
  assert.equal(service.search({ query: '茉莉', scope: 'user', scopeId: member.senderId }, { ...member, role: 'master' }).length, 0);
  const groupRecord = service.write({ content: '个人偏好是茉莉花茶', scope: 'user' }, member);
  assert.notEqual(groupRecord.id, privateRecord.id);
  assert.equal(service.search({ query: '茉莉' }, member)[0].id, groupRecord.id);
  assert.equal(service.search({ query: '茉莉' }, privateCtx)[0].id, privateRecord.id);
  assert.equal(service.search({ query: '茉莉' }, { ...member, chatId: 'group:999' }).length, 0);
});

test('learning approval is owner-only, rollback requires prior approval, pause survives a new service', async t => {
  const options = await setup(t, { learning: { enabled: true, maxCandidatesPerDay: 3 } });
  const service = new LearningService(options);
  const first = service.propose({ content: '回答简短，称呼自然。' }, member);
  assert.equal(service.current(), null);
  assert.throws(() => service.approve({ id: first.id }, member), errorCode('FORBIDDEN'));
  assert.throws(() => service.rollback({ id: first.id }, owner), errorCode('FORBIDDEN'));
  service.approve({ id: first.id }, owner);
  const second = service.propose({ content: '在长问题中分点说明。' }, member);
  service.approve({ id: second.id }, owner);
  assert.equal(service.rollback({ id: first.id }, owner).id, first.id);
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM profile_approvals').get().n, 3);
  service.pause({ paused: true }, owner);
  assert.throws(() => new LearningService(options).propose({ content: '新候选' }, member), errorCode('LEARNING_PAUSED'));
  service.pause({ paused: false }, owner);
  service.propose({ content: '保留必要上下文。' }, member);
  assert.throws(() => service.propose({ content: '超过限制。' }, member), errorCode('QUOTA_EXCEEDED'));
});

test('sticker collection checks real emoji metadata, hashes, controlled paths, and quotas', async t => {
  const options = await setup(t, { stickers: { enabled: true, maxPerGroupPerHour: 1 } });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=', 'base64');
  const file = join(options.mediaRoot, 'input.png'); await writeFile(file, png);
  const sent = [];
  const service = new StickerService({ ...options, adapter: { sendImage: async (...args) => sent.push(args) } });
  await assert.rejects(service.collect({ file }, member), errorCode('NOT_A_STICKER'));
  const sticker = await service.collect({ file, sub_type: 1, tags: ['开心'] }, member);
  assert.equal(sticker.width, 1); assert.equal(sticker.hash.length, 64);
  assert.equal((await service.collect({ file, type: 'mface' }, member)).duplicate, true);
  assert.equal(service.search({ tag: '开心' }, member).length, 1);
  assert.equal(service.search({}, { ...member, chatId: 'group:321' }).length, 0);
  assert.equal((await service.send({ stickerId: sticker.id }, member)).delivery, 'sent');
  assert.equal(sent.length, 1);
  await assert.rejects(service.send({ id: sticker.id }, member), errorCode('QUOTA_EXCEEDED'));
  const outside = join(options.root, 'outside.png'); await writeFile(outside, png);
  await assert.rejects(service.collect({ file: outside, sub_type: 1 }, member), errorCode('INVALID_PATH'));
  const fake = join(options.mediaRoot, 'fake.png'); await writeFile(fake, '<svg>not a real sticker</svg>');
  await assert.rejects(service.collect({ file: fake, sub_type: 1 }, member), errorCode('INVALID_MEDIA'));
  const controller = new AbortController();
  const cancelled = service.send({ id: sticker.id }, { ...member, signal: controller.signal });
  controller.abort(new Error('Turn ended'));
  await assert.rejects(cancelled, /Turn ended/);
  assert.equal(sent.length, 1);
  await writeFile(sticker.file, Buffer.from(png).fill(1, 45, 46));
  await assert.rejects(service.send({ id: sticker.id }, member), errorCode('INVALID_MEDIA'));
});

test('letters create actual text files, refuse unimplemented image output, and mark only delivered letters', async t => {
  const options = await setup(t, { letters: { enabled: true } });
  const service = new LettersService(options);
  await assert.rejects(service.write({ body: '你好', format: 'text' }, member), errorCode('FORBIDDEN'));
  await assert.rejects(service.write({ body: '你好', format: 'image' }, owner), errorCode('UNSUPPORTED'));
  const letter = await service.write({ title: '一封信', body: '祝你今天顺利。', format: 'file' }, owner);
  assert.equal(await readFile(letter.file, 'utf8'), '一封信\n\n祝你今天顺利。\n');
  assert.equal((await service.send({ id: letter.id }, owner)).delivery, 'prepared');
  assert.equal(service.get({ id: letter.id }, owner).sent_at, null);
  service.adapter = { sendLetter: async () => {} };
  assert.equal((await service.send({ id: letter.id }, owner)).delivery, 'sent');
  assert.ok(service.get({ id: letter.id }, owner).sent_at);
});

test('scheduler persists retry/backoff and resumes via a fresh worker', async t => {
  const options = await setup(t, { scheduler: { enabled: true, retryBaseMs: 20, maxBatch: 10 } });
  let now = Date.now();
  const first = new Scheduler({ ...options, clock: () => now, logger: { warn() {} } });
  assert.throws(() => first.schedule({ kind: 'text_send' }, member), errorCode('FORBIDDEN'));
  assert.throws(() => first.schedule({ kind: 'shell', payload: {} }, owner), errorCode('INVALID_ARGUMENT'));
  assert.throws(() => first.schedule({ kind: 'text_send', payload: { apiKey: 'sensitive' } }, owner), errorCode('INVALID_ARGUMENT'));
  const job = first.schedule({ kind: 'text_send', payload: { text: '定时问候' } }, owner);
  first.register('text_send', async () => { throw new Error('transient'); });
  await first.tick();
  const retry = options.db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
  assert.equal(retry.status, 'retry'); assert.equal(retry.attempts, 1); assert.equal(retry.run_at, now + 20);
  const restartedDb = new Store({ path: options.db.path }); t.after(() => restartedDb.close());
  const second = new Scheduler({ ...options, db: restartedDb, clock: () => now, logger: { warn() {} } });
  let calls = 0;
  second.register('text_send', async (payload, claimed) => { calls++; assert.equal(payload.text, '定时问候'); assert.equal(claimed.context.senderId, owner.senderId); assert.equal(claimed.context.selfId, owner.selfId); assert.equal(claimed.context.signal, claimed.signal); return { delivered: true }; });
  await second.tick(); assert.equal(calls, 0);
  now += 20; await second.tick();
  assert.equal(calls, 1);
  const completed = options.db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
  assert.equal(completed.status, 'completed'); assert.equal(completed.attempts, 2);
  restartedDb.close();
});

test('scheduler recovers an expired crash lease and prevents concurrent workers from claiming it twice', async t => {
  const options = await setup(t, { scheduler: { enabled: true, leaseMs: 100 } });
  let now = Date.now();
  const first = new Scheduler({ ...options, clock: () => now });
  const job = first.schedule({ kind: 'text_send', payload: { text: '一次任务' } }, owner);
  const claimed = first.claim(options.config.scheduler);
  assert.equal(claimed.id, job.id);
  const second = new Scheduler({ ...options, clock: () => now });
  assert.equal(second.claim(options.config.scheduler), null);
  now += 101;
  let calls = 0;
  first.register('text_send', async () => { calls++; });
  second.register('text_send', async () => { calls++; });
  await Promise.all([first.tick(), second.tick()]);
  assert.equal(calls, 1);
  const row = options.db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
  assert.equal(row.attempts, 2);
  assert.equal(row.status, 'completed');
});

test('qzone capability probing rejects unavailable adapters and requires owner and comment opt-in', async t => {
  const options = await setup(t, { qzone: { enabled: true } });
  const service = new QzoneService(options);
  assert.deepEqual(await service.capabilities(owner), { post: false, comment: false, like: false });
  await assert.rejects(service.post({ text: '今天很好' }, owner), errorCode('UNSUPPORTED'));
  service.adapter = { capabilities: () => ({ qzone: { post: true, comment: true, like: true } }), qzone: async ({ action }) => ({ id: action }) };
  await assert.rejects(service.post({ text: '今天很好' }, member), errorCode('FORBIDDEN'));
  assert.equal((await service.post({ text: '今天很好' }, owner)).supported, true);
  await assert.rejects(service.comment({ postId: 'post-1', text: '你好' }, owner), errorCode('FEATURE_DISABLED'));
});

test('qzone cancellation after asynchronous capability probing prevents a post', async t => {
  const options = await setup(t, { qzone: { enabled: true } });
  const controller = new AbortController(); let calls = 0;
  const service = new QzoneService({ ...options, adapter: {
    capabilities: async () => { controller.abort(new Error('Turn ended')); return { qzone: { post: true } }; },
    qzone: async () => { calls++; },
  } });
  await assert.rejects(service.post({ text: '取消后不发送' }, { ...owner, signal: controller.signal }), /Turn ended/);
  assert.equal(calls, 0);
  assert.equal(options.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='qzone.post.pending'").get().n, 0);
});

test('extended features default to disabled', async t => {
  const options = await setup(t);
  assert.throws(() => new MemoryService(options).search({}, member), errorCode('FEATURE_DISABLED'));
  assert.throws(() => new LearningService(options).propose({ content: '候选' }, owner), errorCode('FEATURE_DISABLED'));
  await assert.rejects(new LettersService(options).write({ body: '信' }, owner), errorCode('FEATURE_DISABLED'));
});
