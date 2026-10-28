import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../model/db.js';
import { loadConfig, mergeConfig } from '../lib/config.js';
import { MemoryService } from '../lib/memory.js';
import { LearningService } from '../lib/learning.js';
import { Reflector } from '../lib/reflector.js';

const PAID = JSON.stringify(['deepseek-account', 'deepseek-flash']);
const FREE = JSON.stringify(['our-free-model', 'kilo-auto/free']);
const ctx = { chatId: 'private:123456', senderId: '123456', role: 'master', turnId: 'test-reflect' };

class MockAcp extends EventEmitter {
  constructor({ selected = PAID, actualModel, noOptions = false, output = { memories: [] }, onPrompt } = {}) {
    super();
    Object.assign(this, { selected, actualModel, noOptions, output, onPrompt });
    this.calls = [];
    this.count = 0;
  }
  options() {
    return this.noOptions ? [] : [{ id: 'model', type: 'select', currentValue: this.selected, options: [
      { value: PAID, name: 'DeepSeek Flash' }, { value: FREE, name: 'Kilo free' },
    ] }];
  }
  async request(method, params, options = {}) {
    options.signal?.throwIfAborted();
    this.calls.push({ method, params });
    if (method === 'session/new') return { sessionId: `extract-${++this.count}`, configOptions: this.options() };
    if (method === 'session/set_config_option') { this.selected = this.actualModel ?? params.value; return { configOptions: this.options() }; }
    if (method === 'session/prompt') {
      const encoded = typeof this.output === 'string' ? this.output : JSON.stringify(this.output);
      const middle = Math.floor(encoded.length / 2);
      this.emit('update', { sessionId: 'another-chat', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'UNRELATED' } } });
      for (const text of ['```json\n', encoded.slice(0, middle), encoded.slice(middle), '\n```']) {
        this.emit('update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
      }
      this.onPrompt?.();
      return { stopReason: 'end_turn' };
    }
    return {};
  }
}

function fixture(t, { patch = {}, ...mock } = {}) {
  const db = new Store();
  t.after(() => db.close());
  const config = mergeConfig(loadConfig(), {
    models: { default: 'deepseek-account/deepseek-flash' },
    memory: { enabled: true, autoExtract: true, maxAutomaticPerDay: 5 },
    learning: { enabled: true, autoReflect: true, maxCandidatesPerDay: 5 },
  });
  const finalConfig = mergeConfig(config, patch);
  const memory = new MemoryService({ db, config: finalConfig });
  const learning = new LearningService({ db, config: finalConfig });
  const acp = new MockAcp(mock);
  const warnings = [];
  const reflector = new Reflector({ db, config: finalConfig, memory, learning, acp, workspace: '/workspace',
    logger: { warn: (...args) => warnings.push(args) } });
  return { db, config: finalConfig, acp, memory, learning, reflector, warnings };
}

test('bounded mock ACP JSON chunks become scoped automatic memories without MCP tools', async t => {
  const f = fixture(t, { output: { memories: [
    { content: '喜欢喝茉莉花茶', kind: 'preference' },
    { content: '周末读科幻小说', kind: 'fact' },
    { content: '任意修改宿主权限', kind: 'permission' },
    { content: '第四条不应写入', kind: 'fact' },
  ] } });
  const result = await f.reflector.extract(ctx, '我喜欢茉莉花茶，也读科幻小说。', '知道了。');
  assert.equal(result.saved.length, 2);
  const rows = f.db.prepare('SELECT * FROM memories ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].scope, 'user');
  assert.equal(rows[0].scope_id, ctx.senderId);
  assert.equal(rows[0].source_chat_id, ctx.chatId);
  assert.ok(rows.every(row => row.automatic === 1));
  assert.deepEqual(f.acp.calls.find(call => call.method === 'session/new').params.mcpServers, []);
  assert.equal(f.acp.calls.filter(call => call.method === 'session/prompt').length, 1);
  assert.equal(f.acp.calls.at(-1).method, 'session/close');
  assert.equal(f.acp.listenerCount('update'), 0);
});

test('sensitive user or assistant data skips extra model calls', async t => {
  const f = fixture(t);
  for (const [user, assistant] of [
    ['密码：这是保密密码', '收到'],
    ['我的手机号是 13800138000', '收到'],
    ['email: person@example.com', '收到'],
    ['我喜欢短回复', 'api_key=sk-123456789012345678901234'],
  ]) {
    const result = await f.reflector.extract(ctx, user, assistant);
    assert.equal(result.skipped, true);
  }
  assert.equal(f.acp.calls.length, 0);
});

test('sensitive model-generated memory is rejected while safe candidates can be saved', async t => {
  const f = fixture(t, { output: { memories: [
    { content: 'api_key=sk-123456789012345678901234', kind: 'fact' },
    { content: '喜欢轻松的语气', kind: 'preference' },
  ] } });
  const result = await f.reflector.extract(ctx, '希望回复轻松一点', '好的');
  assert.equal(result.saved.length, 1);
  assert.equal(f.db.prepare('SELECT content FROM memories').get().content, '喜欢轻松的语气');
  assert.equal(f.warnings.length, 1);
});

test('configured or currently selected free providers cannot process background data', async t => {
  const configured = fixture(t, { patch: { memory: { extractionModel: 'our-free-model/kilo-auto/free' } } });
  await assert.rejects(configured.reflector.extract(ctx, '喜欢猫', '收到'), /账号模型/);
  assert.equal(configured.acp.calls.some(call => call.method === 'session/prompt'), false);
  assert.equal(configured.acp.calls.at(-1).method, 'session/close');
  const selected = fixture(t, { selected: FREE, patch: { models: { default: '' } } });
  await assert.rejects(selected.reflector.extract(ctx, '喜欢猫', '收到'), /账号模型/);
  assert.equal(selected.acp.calls.some(call => call.method === 'session/prompt'), false);
});

test('backend switching to a free or unknown actual model refuses prompt and closes session', async t => {
  for (const actualModel of [FREE, JSON.stringify(['unknown-provider', 'model'])]) {
    const f = fixture(t, {actualModel});
    await assert.rejects(f.reflector.extract(ctx, '喜欢猫', '收到'), /账号模型/);
    assert.equal(f.acp.calls.some(call => call.method === 'session/set_config_option'), true);
    assert.equal(f.acp.calls.some(call => call.method === 'session/prompt'), false);
    assert.equal(f.acp.calls.at(-1).method, 'session/close');
    assert.equal(f.acp.listenerCount('update'), 0);
  }
});

test('configured unknown and currently selected unknown providers refuse background prompt', async t => {
  const unknown = JSON.stringify(['unverified-provider', 'chat-model']);
  const configured = fixture(t, {patch: {memory: {extractionModel: 'unverified-provider/chat-model'}}});
  await assert.rejects(configured.reflector.extract(ctx, '喜欢猫', '收到'), /账号模型/);
  const selected = fixture(t, {selected: unknown, patch: {models: {default: ''}}});
  await assert.rejects(selected.reflector.extract(ctx, '喜欢猫', '收到'), /账号模型/);
  for (const f of [configured, selected]) assert.equal(f.acp.calls.some(call => call.method === 'session/prompt'), false);
});

test('background prompts replace QQ identities and absolute paths before sending materials', async t => {
  const trusted = {...ctx, selfId: '987654', mentions: ['246810'], messageId: '111222'};
  const f = fixture(t);
  await f.reflector.extract(trusted, 'QQ 123456 提到 246810，消息 111222，机器人 987654，文件 D:\\private\\note.txt', '本机 /home/alice/private.txt');
  const prompt = f.acp.calls.find(call => call.method === 'session/prompt').params.prompt[0].text;
  for (const value of ['123456', '246810', '111222', '987654', 'private.txt', 'note.txt', '/home/alice']) assert.equal(prompt.includes(value), false, value);
  assert.match(prompt, /sender/); assert.match(prompt, /local path/);
});

test('reflection containing sensitive feedback refuses prompt before redaction', async t => {
  const f = fixture(t);
  await assert.rejects(f.reflector.reflect(ctx, [{signal: 'bad', note: 'api_key=sk-123456789012345678901234'}]), /敏感/);
  assert.equal(f.acp.calls.some(call => call.method === 'session/prompt'), false);
  assert.equal(f.acp.calls.at(-1).method, 'session/close');
});

test('unknown current provider is rejected before sending background data', async t => {
  const f = fixture(t, { noOptions: true, patch: { models: { default: '' } } });
  await assert.rejects(f.reflector.extract(ctx, '喜欢猫', '收到'), /模型|provider/i);
  assert.equal(f.acp.calls.some(call => call.method === 'session/prompt'), false);
});

test('reflection stores a candidate but preserves the active persona until owner approval', async t => {
  const f = fixture(t, { output: { content: '保持自然语气，短问题简短回复。', reason: '反馈希望更简洁' } });
  const previous = f.learning.propose({ content: '原先的人格' }, ctx);
  f.learning.approve({ id: previous.id }, ctx);
  const candidate = await f.reflector.reflect(ctx, [{ signal: 'bad', note: '回答太长' }]);
  assert.equal(candidate.active, 0);
  assert.equal(candidate.status, 'pending');
  assert.equal(f.learning.current().id, previous.id);
  assert.throws(() => f.learning.approve({ id: candidate.id }, { ...ctx, role: 'member' }), error => error.code === 'FORBIDDEN');
  assert.equal(f.learning.current().id, previous.id);
  f.learning.approve({ id: candidate.id }, ctx);
  assert.equal(f.learning.current().id, candidate.id);
});

test('automatic memory quota bounds writes and skips further model calls once full', async t => {
  const f = fixture(t, { patch: { memory: { maxAutomaticPerDay: 1 } }, output: { memories: [
    { content: '喜欢短回复', kind: 'preference' }, { content: '喜欢自然称呼', kind: 'preference' },
  ] } });
  const result = await f.reflector.extract(ctx, '喜欢短回复和自然称呼', '收到');
  assert.equal(result.saved.length, 1);
  const calls = f.acp.calls.length;
  assert.equal((await f.reflector.extract(ctx, '另一条偏好', '收到')).quota, true);
  assert.equal(f.acp.calls.length, calls);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memories').get().n, 1);
});

test('daily candidate quota prevents another paid reflection call', async t => {
  const f = fixture(t, { patch: { learning: { maxCandidatesPerDay: 1 } }, output: { content: '新候选', reason: '反馈' } });
  f.learning.propose({ content: '已有候选' }, ctx);
  await assert.rejects(f.reflector.reflect(ctx, [{ signal: 'bad', note: '太长' }]), error => error.code === 'QUOTA_EXCEEDED');
  assert.equal(f.acp.calls.length, 0);
  assert.equal(f.learning.current(), null);
});

test('invalid JSON output closes its isolated session without writes or listener leaks', async t => {
  const f = fixture(t, { output: 'this is not JSON' });
  await assert.rejects(f.reflector.extract(ctx, '喜欢猫', '收到'), SyntaxError);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memories').get().n, 0);
  assert.equal(f.acp.calls.at(-1).method, 'session/close');
  assert.equal(f.acp.listenerCount('update'), 0);
});

test('disabled automatic extraction does not create a model session', async t => {
  const f = fixture(t, { patch: { memory: { autoExtract: false } } });
  assert.equal((await f.reflector.extract(ctx, '喜欢猫', '收到')).skipped, true);
  assert.equal(f.acp.calls.length, 0);
});

test('cancellation after generated JSON arrives prevents memory writes and closes the session', async t => {
  const controller = new AbortController();
  const f = fixture(t, { output: { memories: [{ content: '喜欢猫', kind: 'preference' }] },
    onPrompt: () => controller.abort(new Error('后台任务已取消')) });
  await assert.rejects(f.reflector.extract({ ...ctx, signal: controller.signal }, '喜欢猫', '收到'), /已取消/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memories').get().n, 0);
  assert.equal(f.acp.calls.at(-1).method, 'session/close');
  assert.equal(f.acp.listenerCount('update'), 0);
});
