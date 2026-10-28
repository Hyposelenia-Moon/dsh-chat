import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp, mkdir, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../model/db.js';
import {StickerService} from '../lib/stickers.js';
import {MediaStore} from '../lib/media.js';
import {LearningService} from '../lib/learning.js';
import {QzoneService} from '../lib/qzone.js';
import {loadConfig, validateConfig} from '../lib/config.js';
import {schemas} from '../guoba/schema.js';

const ctx = {chatId: 'group:123', senderId: '456', role: 'member'};
const other = {...ctx, chatId: 'group:789'};
const quota = error => error.code === 'QUOTA_EXCEEDED';
const gif = value => Buffer.from([71,73,70,56,57,97,1,0,1,0,0,0,0,value,0,59]);
async function setup(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-security-storage-'));
  const mediaRoot = join(root, 'media'); await mkdir(mediaRoot);
  const db = new Store({path: join(root, 'test.sqlite')});
  t.after(async () => { db.close(); await rm(root, {recursive: true, force: true}); });
  return {root, mediaRoot, db, config};
}
function message(db, chatId = ctx.chatId, role = 'assistant') {
  return Number(db.prepare('INSERT INTO messages(chat_id,role,created_at) VALUES(?,?,?)').run(chatId, role, Date.now()).lastInsertRowid);
}

test('贴纸并发收集先预留额度，拒绝项不产生新文件', async t => {
  const options = await setup(t, {stickers: {enabled: true, maxPerGroupPerHour: 1}});
  const service = new StickerService(options);
  const paths = [join(options.mediaRoot, 'a.gif'), join(options.mediaRoot, 'b.gif')];
  await Promise.all(paths.map((file, i) => writeFile(file, gif(i))));
  const results = await Promise.allSettled(paths.map(file => service.collect({file, sub_type: 1}, ctx)));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected' && quota(row.reason)).length, 1);
  assert.equal((await readdir(join(options.mediaRoot, 'stickers'))).length, 1);
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM sticker_collect_pending').get().n, 0);
});

test('下载前贴纸额度入口跨服务占用并允许失败释放', async t => {
  const options = await setup(t, {stickers: {enabled: true, maxPerGroupPerHour: 1}});
  const a = new StickerService(options), b = new StickerService(options);
  const reservation = a.reserveCollect(ctx);
  assert.throws(() => b.reserveCollect(ctx), quota);
  a.releaseCollect(reservation, other);
  assert.throws(() => b.reserveCollect(ctx), quota);
  a.releaseCollect(reservation, ctx);
  const retry = b.reserveCollect(ctx);
  await assert.rejects(b.collect({file: join(options.mediaRoot, 'missing'), sub_type: 1, reservation: retry}, ctx));
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM sticker_collect_pending').get().n, 0);
  b.releaseCollect(b.reserveCollect(ctx), ctx);
});

test('贴纸数据库失败回滚只删除本次新文件并释放预留', async t => {
  const options = await setup(t, {stickers: {enabled: true}});
  const service = new StickerService(options), file = join(options.mediaRoot, 'input.gif');
  await writeFile(file, gif(3));
  const original = options.db.audit;
  options.db.audit = () => { throw new Error('本地模拟审计写入失败'); };
  await assert.rejects(service.collect({file, type: 'mface'}, ctx), /审计写入失败/);
  assert.deepEqual(await readdir(join(options.mediaRoot, 'stickers')), []);
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM stickers').get().n, 0);
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM sticker_collect_pending').get().n, 0);
  options.db.audit = original;
  assert.ok((await service.collect({file, type: 'mface'}, ctx)).id);
});

test('贴纸库文件数含下载前预留，全库满时拒绝下载且保留合法文件', async t => {
  const options = await setup(t, {stickers: {enabled: true, maxStoreFiles: 1}});
  const service = new StickerService(options), file = join(options.mediaRoot, 'input.gif');
  await writeFile(file, gif(1));
  const reservation = service.reserveCollect(ctx);
  assert.throws(() => service.reserveCollect(other), quota);
  const record = await service.collect({file, type: 'mface', reservation}, ctx);
  assert.throws(() => service.reserveCollect(ctx), quota);
  const second = join(options.mediaRoot, 'second.gif'); await writeFile(second, gif(2));
  await assert.rejects(service.collect({file: second, type: 'mface'}, ctx), quota);
  assert.equal(fs.existsSync(record.file), true);
  assert.equal((await readdir(join(options.mediaRoot, 'stickers'))).length, 1);
  assert.equal((await service.collect({file, type: 'mface'}, ctx)).duplicate, true);
});

test('贴纸库写前检查准确总字节，不淘汰合法文件并释放失败预留', async t => {
  const options = await setup(t, {stickers: {enabled: true, maxStoreBytes: 31}});
  const service = new StickerService(options), file = join(options.mediaRoot, 'a.gif'), second = join(options.mediaRoot, 'b.gif');
  await writeFile(file, gif(1)); await writeFile(second, gif(2));
  const first = await service.collect({file, type: 'mface'}, ctx);
  const reservation = service.reserveCollect(ctx);
  await assert.rejects(service.collect({file: second, type: 'mface', reservation}, ctx), quota);
  assert.equal(fs.existsSync(first.file), true);
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM sticker_collect_pending').get().n, 0);
  options.config.stickers.maxStoreBytes = 16;
  assert.throws(() => service.reserveCollect(ctx), quota);
  assert.equal((await readdir(join(options.mediaRoot, 'stickers'))).length, 1);
});

test('贴纸收集仅清理贴纸目录未注册哈希文件并保护当前原图与合法记录', async t => {
  const options = await setup(t, {stickers: {enabled: true}}), service = new StickerService(options);
  const directory = join(options.mediaRoot, 'stickers'), cache = join(options.mediaRoot, 'cache');
  await mkdir(directory); await mkdir(cache);
  const orphan = join(directory, `${'a'.repeat(64)}.gif`), source = join(directory, `${'b'.repeat(64)}.gif`);
  const cacheSource = join(cache, `${'c'.repeat(64)}.gif`), unrelated = join(directory, 'user-file.gif');
  for (const file of [orphan, source, cacheSource, unrelated]) await writeFile(file, gif(3));
  const first = await service.collect({file: source, type: 'mface'}, ctx);
  assert.equal(fs.existsSync(orphan), false); assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(cacheSource), true); assert.equal(fs.existsSync(unrelated), true);
  await service.collect({file: cacheSource, type: 'mface'}, ctx);
  assert.equal(fs.existsSync(first.file), true); assert.equal(fs.existsSync(cacheSource), true);
});

test('贴纸发送适配器收到可信 context 与 signal', async t => {
  const options = await setup(t, {stickers: {enabled: true}});
  const signal = new AbortController().signal, trusted = {...ctx, signal}, sent = [];
  const service = new StickerService({...options, adapter: {sendSticker: async (...args) => sent.push(args)}});
  const file = join(options.mediaRoot, 'input.gif'); await writeFile(file, gif(1));
  const record = await service.collect({file, type: 'mface'}, trusted);
  await service.send({id: record.id}, trusted);
  assert.deepEqual(sent[0], [ctx.chatId, record.file, {context: trusted, signal}]);
});

test('媒体写入前按 TTL 与总容量清理，并清除授权孤儿', async t => {
  const options = await setup(t, {media: {maxCacheBytes: 32, ttlHours: 1}});
  const media = new MediaStore({...options, root: options.mediaRoot}); t.after(() => media.stop());
  media.fetchDownload = async value => gif(Number(value));
  const first = await media.image({url: '1'}, ctx);
  const second = await media.image({url: '2'}, ctx);
  fs.utimesSync(first, new Date(1), new Date(1));
  options.db.prepare('INSERT INTO media_assets VALUES(?,?,?)').run(join(options.mediaRoot, 'missing.gif'), ctx.chatId, 1);
  const third = await media.image({url: '3'}, ctx);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), true); assert.equal(fs.existsSync(third), true);
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM media_assets').get().n, 2);
  await media.image({url: '4'}, ctx);
  assert.equal((await readdir(join(options.mediaRoot, 'cache'))).length, 2);
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM media_assets').get().n, 2);
  options.config.media.maxCacheBytes = 15;
  await assert.rejects(media.image({url: '5'}, ctx), /总容量/);
});

test('媒体下载额度按聊天持久化并在联网前拒绝，失败尝试也计数', async t => {
  const options = await setup(t, {media: {maxDownloadsPerChatPerHour: 1}});
  const a = new MediaStore({...options, root: options.mediaRoot}); t.after(() => a.stop());
  let calls = 0; a.fetchDownload = async () => { calls++; throw new Error('本地失败'); };
  await assert.rejects(a.download('unused', ctx), /本地失败/);
  await assert.rejects(a.download('unused', ctx), /每小时/);
  assert.equal(calls, 1);
  const b = new MediaStore({...options, root: options.mediaRoot}); t.after(() => b.stop());
  b.fetchDownload = async () => gif(1);
  await assert.rejects(b.download('unused', ctx), /每小时/);
  assert.equal((await b.download('unused', other)).length, 16);
});

test('媒体周期清理定时器 unref 且 stop 后不再清理，缺省配置可用', async t => {
  const options = await setup(t, {media: {cleanupIntervalMs: 10, ttlHours: 0}});
  const media = new MediaStore({...options, root: options.mediaRoot}); t.after(() => media.stop());
  assert.equal(media.timer.hasRef(), false);
  const cache = join(options.mediaRoot, 'cache'); await mkdir(cache);
  const expired = join(cache, 'old.gif'); await writeFile(expired, gif(1)); fs.utimesSync(expired, new Date(1), new Date(1));
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(fs.existsSync(expired), false);
  media.stop(); assert.equal(media.timer, null);
  await writeFile(expired, gif(1)); fs.utimesSync(expired, new Date(1), new Date(1));
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(fs.existsSync(expired), true);
  const fallback = new MediaStore({root: options.mediaRoot}); t.after(() => fallback.stop());
  assert.equal(fallback.settings().maxCacheBytes, 134217728);
  assert.equal(fallback.settings().maxDownloadsPerChatPerHour, 60);
});

test('同哈希并发收集只保存一次，重复缓存保留跨聊天授权', async t => {
  const options = await setup(t, {stickers: {enabled: true}, media: {maxCacheBytes: 16}});
  const file = join(options.mediaRoot, 'same.gif'); await writeFile(file, gif(2));
  const service = new StickerService(options);
  const records = await Promise.all([service.collect({file, type: 'mface'}, ctx), service.collect({file, type: 'mface'}, ctx)]);
  assert.equal(records[0].id, records[1].id);
  assert.equal(options.db.prepare("SELECT COUNT(*) AS n FROM sticker_events WHERE kind='collect'").get().n, 1);
  const media = new MediaStore({...options, root: options.mediaRoot}); t.after(() => media.stop());
  media.fetchDownload = async () => gif(2);
  const cached = await media.image({url: 'unused'}, ctx);
  await media.image({url: 'unused'}, other);
  assert.equal(media.local(cached, ctx), cached);
  assert.equal(media.local(cached, other), cached);
});

test('媒体授权写入失败清理本次新建缓存文件', async t => {
  const options = await setup(t);
  const media = new MediaStore({...options, root: options.mediaRoot}); t.after(() => media.stop());
  media.fetchDownload = async () => gif(4);
  media.register = () => { throw new Error('本地授权失败'); };
  await assert.rejects(media.image({url: 'unused'}, ctx), /授权失败/);
  assert.deepEqual(await readdir(join(options.mediaRoot, 'cache')), []);
});

test('反馈拒绝无助手消息、用户消息及跨聊天消息', async t => {
  const options = await setup(t, {learning: {enabled: true}}), service = new LearningService(options);
  assert.throws(() => service.feedback({signal: 'good'}, ctx), error => error.code === 'NOT_FOUND');
  const user = message(options.db, ctx.chatId, 'user'), elsewhere = message(options.db, other.chatId);
  for (const id of [user, elsewhere]) assert.throws(() => service.feedback({signal: 'good', messageId: id}, ctx), error => error.code === 'NOT_FOUND');
  const assistant = message(options.db);
  assert.equal(service.feedback({signal: 'good'}, ctx).message_id, assistant);
});

test('反馈按 sender/chat 冷却，同 actor 同 message 更新且日额度保护新记录', async t => {
  const options = await setup(t, {learning: {enabled: true, feedbackCooldownMs: 3000, maxFeedbackPerChatPerDay: 2}}), service = new LearningService(options);
  const id = message(options.db);
  const first = service.feedback({signal: 'good', messageId: id}, ctx);
  assert.throws(() => service.feedback({signal: 'bad', messageId: id}, ctx), quota);
  service.feedback({signal: 'good', messageId: id}, {...ctx, senderId: 'other'});
  message(options.db, other.chatId);
  assert.ok(service.feedback({signal: 'good'}, other).id);
  options.config.learning.feedbackCooldownMs = 0;
  assert.equal(service.feedback({signal: 'bad', messageId: id, note: '修正反馈'}, ctx).id, first.id);
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE chat_id=?').get(ctx.chatId).n, 2);
  assert.throws(() => service.feedback({signal: 'good', messageId: message(options.db)}, ctx), quota);
});

test('贴纸总库字段默认配置校验和锅巴声明保持一致', () => {
  const config = loadConfig();
  for (const [field, fallback, maximum] of [['maxStoreBytes', 268435456, 10737418240], ['maxStoreFiles', 2000, 100000]]) {
    assert.equal(config.stickers[field], fallback);
    const schema = schemas.find(row => row.field === `stickers.${field}`);
    assert.equal(schema.componentProps.min, 0); assert.equal(schema.componentProps.max, maximum);
    for (const value of [-1, maximum + 1, 0.5]) {
      const invalid = structuredClone(config); invalid.stickers[field] = value;
      assert.throws(() => validateConfig(invalid), new RegExp(`stickers.${field}`));
    }
    const disabled = structuredClone(config); disabled.stickers[field] = 0;
    assert.doesNotThrow(() => validateConfig(disabled));
  }
});

test('媒体授权和下载额度按机器人 storageKey 隔离，拒绝旧 uploads 目录', async t => {
  const options = await setup(t, {media: {maxDownloadsPerChatPerHour: 1}});
  const media = new MediaStore({...options, root: options.mediaRoot}); t.after(() => media.stop());
  media.fetchDownload = async () => gif(6);
  const a = {...ctx, selfId: '111', storageKey: 'bot:111:group:123'}, b = {...ctx, selfId: '222', storageKey: 'bot:222:group:123'};
  const cached = await media.image({url: 'unused'}, a);
  assert.throws(() => media.local(cached, b), /未授权/);
  assert.throws(() => media.local(cached, ctx), /未授权/);
  await assert.rejects(media.download('unused', a), /每小时/);
  assert.equal((await media.download('unused', b)).length, 16);
  const own = join(options.mediaRoot, 'uploads', '111', 'group_123'), legacy = join(options.mediaRoot, 'uploads', 'group_123');
  await mkdir(own, {recursive: true}); await mkdir(legacy, {recursive: true});
  const ownFile = join(own, 'a.gif'), oldFile = join(legacy, 'a.gif');
  await writeFile(ownFile, gif(1)); await writeFile(oldFile, gif(1));
  assert.equal(media.local(ownFile, a), ownFile);
  assert.throws(() => media.local(ownFile, b), /未授权/);
  assert.throws(() => media.local(oldFile, a), /未授权/);
  assert.throws(() => media.local(oldFile, ctx), /未授权/);
});

test('反馈消息绑定、限速和日额度按机器人 storageKey 隔离', async t => {
  const options = await setup(t, {learning: {enabled: true, maxFeedbackPerChatPerDay: 1}}), service = new LearningService(options);
  const a = {...ctx, selfId: '111', storageKey: 'bot:111:group:123'}, b = {...ctx, selfId: '222', storageKey: 'bot:222:group:123'};
  const first = message(options.db, a.storageKey), second = message(options.db, b.storageKey);
  assert.throws(() => service.feedback({signal: 'good', messageId: first}, b), error => error.code === 'NOT_FOUND');
  assert.equal(service.feedback({signal: 'good'}, a).chat_id, a.storageKey);
  assert.equal(service.feedback({signal: 'bad'}, b).message_id, second);
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 2);
  assert.throws(() => service.feedback({signal: 'good'}, a), quota);
  assert.throws(() => service.feedback({signal: 'good'}, ctx), error => error.code === 'NOT_FOUND');
});

test('空间能力探测和执行将可信 context 放进适配器 options', async t => {
  const options = await setup(t, {qzone: {enabled: true}}), calls = [];
  const trusted = {...ctx, role: 'master', selfId: '111', storageKey: 'bot:111:group:123', signal: new AbortController().signal};
  const service = new QzoneService({...options, adapter: {
    capabilities: async (...args) => { calls.push(args); return {qzone: {post: true}}; },
    qzone: async (...args) => { calls.push(args); return {ok: true}; },
  }});
  await service.post({text: '本地测试动态'}, trusted);
  assert.deepEqual(calls[0], [ctx.chatId, {context: trusted, signal: trusted.signal}]);
  assert.deepEqual(calls[1], [{action: 'post', text: '本地测试动态'}, ctx.chatId, {context: trusted, signal: trusted.signal}]);
});

test('反馈写入时清理超保留期数据并保留有效记录', async t => {
  const options = await setup(t, {learning: {enabled: true, feedbackCooldownMs: 0, feedbackRetentionDays: 1}}), service = new LearningService(options);
  const id = message(options.db);
  const old = service.feedback({signal: 'good', messageId: id}, ctx);
  options.db.prepare('UPDATE feedback SET created_at=? WHERE id=?').run(Date.now() - 2 * 86400000, old.id);
  const recent = service.feedback({signal: 'bad', messageId: message(options.db)}, ctx);
  assert.equal(options.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 1);
  assert.equal(options.db.prepare('SELECT id FROM feedback').get().id, recent.id);
});
