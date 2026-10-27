import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QQAdapter, normalizeEvent } from '../lib/qq-adapter.js';
import { guobaPatch, supportGuoba } from '../guoba.support.js';

const event = (extra = {}) => ({
  message_type: 'group', group_id: 123, user_id: 456, self_id: 789,
  message_id: 'message-1', sender: { role: 'member', nickname: '小明' },
  message: [{ type: 'at', data: { qq: '789' } }, { type: 'text', data: { text: '  你好  ' } }],
  ...extra,
});

test('normalization preserves trusted identity, mentions and attachments', () => {
  const ctx = normalizeEvent(event({ sender: { role: 'admin', nickname: '群管' } }));
  assert.equal(ctx.chatId, 'group:123');
  assert.equal(ctx.senderId, '456');
  assert.equal(ctx.selfId, '789');
  assert.equal(ctx.text, '你好');
  assert.deepEqual(ctx.mentions, ['789']);
  assert.equal(ctx.isAdmin, true);
  assert.equal(ctx.isMaster, false);
  assert.equal(ctx.role, 'admin');
});

test('nickname and untrusted master-like fields cannot grant master rights', () => {
  const ctx = normalizeEvent(event({
    sender: { role: 'member', isMaster: true, nickname: 'master' },
    isMaster: 'true', isAdmin: true,
  }));
  assert.equal(ctx.role, 'member');
  assert.equal(ctx.isAdmin, false);
  assert.equal(normalizeEvent(event(), { permissions: { masters: ['456'] } }).isMaster, true);
  assert.equal(normalizeEvent(event({ isMaster: true })).isMaster, true);
});

test('normalization handles private CQ input and rejects missing identity', () => {
  const ctx = normalizeEvent({ user_id: 456, self_id: 789, message_type: 'private',
    raw_message: '[CQ:at,qq=789]你好&#91;QQ&#93;' });
  assert.equal(ctx.chatId, 'private:456');
  assert.equal(ctx.text, '你好[QQ]');
  assert.deepEqual(ctx.mentions, ['789']);
  assert.throws(() => normalizeEvent({ message_type: 'private', user_id: 'model-selected-target' }), /有效|chatId/);
});

test('Yunzai event reply, quote, mention and explicit reply segments work', async () => {
  const sent = [];
  const adapter = new QQAdapter();
  await adapter.fromEvent(event({ reply: async (...args) => sent.push(args) }));
  await adapter.sendText('group:123', '回答', { quote: true });
  await adapter.mention('group:123', '456', ' 你好');
  await adapter.reply('group:123', 'message-1', '引用');
  assert.deepEqual(sent[0], ['回答', true]);
  assert.deepEqual(sent[1][0], [{ type: 'at', qq: '456' }, { type: 'text', text: ' 你好' }]);
  assert.equal(sent[2][0][0].id, 'message-1');
  await adapter.sendText('group:123','排队回复',{replyTo:'original-message',quote:true});
  assert.equal(sent[3][0][0].id,'original-message');
  assert.equal(sent[3][1],false);
  assert.throws(() => adapter.mention('private:456', '789'), /群聊/);
  assert.throws(() => adapter.mention('group:123', 'all'), /有效/);
});

test('Yunzai pickGroup and NapCat callApi are supported without arbitrary API exposure', async () => {
  const sent = [];
  const adapter = new QQAdapter({ bot: { pickGroup: id => ({ sendMsg: content => sent.push({ id, content }) }) } });
  await adapter.sendText('group:123', '内容');
  assert.deepEqual(sent, [{ id: 123, content: '内容' }]);
  const calls = [];
  const onebot = new QQAdapter({ bot: { callApi: async (action, params) => calls.push({ action, params }) } });
  await onebot.sendText('private:456', '文字 [CQ:at,qq=all]');
  assert.equal(calls[0].action, 'send_private_msg');
  assert.deepEqual(calls[0].params.message, [{ type: 'text', data: { text: '文字 [CQ:at,qq=all]' } }]);
  assert.equal(typeof onebot.callApi, 'undefined');
  await assert.rejects(onebot.sendText('http://example.com', 'bad'), /chatId/);
});

test('media must be a real file beneath the configured media directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-adapter-'));
  try {
    const media = path.join(root, 'media');
    await mkdir(media);
    await writeFile(path.join(media, 'image.png'), 'media');
    await writeFile(path.join(root, 'secret.txt'), 'secret');
    const sent = [];
    const adapter = new QQAdapter({ mediaRoot: media });
    await adapter.fromEvent(event({ reply: async content => sent.push(content) }));
    await adapter.sendImage('group:123', path.join(media, 'image.png'));
    assert.equal(sent[0].type, 'image');
    await assert.rejects(adapter.sendImage('group:123', path.join(root, 'secret.txt')), /超出/);
    await assert.rejects(adapter.sendImage('group:123', 'https://example.com/image.png'), /先由媒体服务/);
    await assert.rejects(adapter.sendImage('group:123', media), /超出|普通文件/);
    assert.equal(sent.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('flat Yunzai segment factories convert to OneBot data segments and gateway failures surface', async () => {
  const calls = [];
  const adapter = new QQAdapter({
    segment: { at: qq => ({ type: 'at', qq }), text: text => ({ type: 'text', text }) },
    bot: { callApi: async (action, params) => { calls.push({ action, params }); return { status: 'ok', retcode: 0 }; } },
  });
  await adapter.mention('group:123', '456', '你好');
  assert.deepEqual(calls[0].params.message, [{ type: 'at', data: { qq: '456' } }, { type: 'text', data: { text: '你好' } }]);
  const failed = new QQAdapter({ bot: { callApi: async () => ({ status: 'failed', retcode: 1200, message: '权限不足' }) } });
  await assert.rejects(failed.sendText('group:123', '消息'), /网关拒绝/);
});

test('multi-account global Bot manager follows the verified event self ID', async () => {
  const sent = [];
  const adapter = new QQAdapter({ bot: { 789: { pickGroup: id => ({ sendMsg: content => sent.push({ id, content }) }) } } });
  const ctx = adapter.fromEvent(event());
  assert.equal(typeof ctx.then, 'undefined');
  await adapter.sendText('group:123', '选定账号');
  assert.deepEqual(sent, [{ id: 123, content: '选定账号' }]);
});

test('voice degrades to text and Qzone stays disabled until a real capability exists', async () => {
  const sent = [];
  const adapter = new QQAdapter();
  await adapter.fromEvent(event({ reply: async content => sent.push(content) }));
  await adapter.sendVoice('group:123', { text: '语音内容' });
  assert.deepEqual(sent, ['语音内容']);
  assert.deepEqual(adapter.capabilities().qzone, { post: false, comment: false, like: false });
  await assert.rejects(adapter.qzone({ action: 'post', text: '动态' }), /未提供/);
  const posts = [];
  const enabled = new QQAdapter({ bot: { qzone: { post: params => posts.push(params) } } });
  await enabled.qzone({ action: 'post', text: '动态' });
  assert.deepEqual(posts, [{ text: '动态' }]);
});

test('cancellation during media validation prevents the later outbound message', async () => {
  const controller = new AbortController();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [];
  const adapter = new QQAdapter();
  adapter.fromEvent(event({ reply: async content => sent.push(content) }));
  adapter._mediaPath = async () => { await gate; return '/validated/image.png'; };
  const pending = adapter.sendImage('group:123', '/input.png', { signal: controller.signal });
  const rejected = assert.rejects(pending, /取消/);
  controller.abort(new Error('取消'));
  release();
  await rejected;
  assert.deepEqual(sent, []);
});

test('a failed in-flight TTS attempt does not send text fallback after cancellation', async () => {
  const controller = new AbortController();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [];
  const adapter = new QQAdapter({ segment: { tts: text => ({ type: 'tts', text }) } });
  adapter.fromEvent(event({ reply: async content => { sent.push(content); await gate; throw new Error('TTS 失败'); } }));
  const pending = adapter.sendVoice('group:123', { text: '内容' }, { signal: controller.signal });
  const rejected = assert.rejects(pending, /取消/);
  controller.abort(new Error('取消'));
  release();
  await rejected;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'tts');
});

test('group info only returns the documented public fields', async () => {
  const adapter = new QQAdapter({ bot: { callApi: async () => ({ data: {
    group_id: 123, group_name: '群名', member_count: 2, token: 'sensitive', internal: {},
  } }) } });
  assert.deepEqual(await adapter.groupInfo('group:123'), { group_id: 123, group_name: '群名', member_count: 2 });
  await assert.rejects(adapter.groupInfo('private:456'), /群聊/);
});

test('Guoba accepts known flat or nested fields and rejects prototype paths', () => {
  assert.deepEqual(guobaPatch({ 'chat.prefix': '!聊', models: { allowFree: false }, unknown: true }), {
    chat: { prefix: '!聊' }, models: { allowFree: false },
  });
  assert.throws(() => guobaPatch({ 'permissions.__proto__.owner': true }), /无效字段/);
  const guoba = supportGuoba();
  assert.equal(guoba.pluginInfo.isV3, true);
  assert.ok(guoba.configInfo.schemas.some(field => field.field === 'backend.expectedCommit'));
  assert.ok(guoba.configInfo.schemas.some(field => field.field === 'persona.cards'));
  assert.ok(guoba.configInfo.schemas.some(field => field.field === 'status.backend'));
  assert.deepEqual(guobaPatch({ status: { backend: 'x' } }), {});
  const data = guoba.configInfo.getConfigData();
  assert.equal(typeof data.status.backend, 'string');
  assert.match(data.status.backend, /未配置|@/);
  assert.match(data.status.free, /已允许|已关闭/);
  assert.match(data.status.sessions, /^\d+$/);
  assert.equal(guoba.configInfo.schemas.some(field => field.field === 'permissions.allowOwnerLocalTools'), false);
});
