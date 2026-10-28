import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runtime } from '../lib/runtime.js';
import { loadConfig, mergeConfig } from '../lib/config.js';
import { normalizeEvent } from '../lib/qq-adapter.js';
import { OfficialWebUi } from '../lib/webui.js';

const model = JSON.stringify(['deepseek-account', 'deepseek-flash']);
class FakeAcp extends EventEmitter {
  async start() { return { protocolVersion: 1 }; }
  async stop() { this.emit('exit', { code: 0 }); }
  async request(method) {
    if (method === 'session/new') return { sessionId: 's1', configOptions: [{ id: 'model', type: 'select', currentValue: model, options: [{ value: model, name: 'F' }] }] };
    return { configOptions: [] };
  }
}
class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.exitCode = null; this.killed = false; }
  kill() { this.killed = true; this.exitCode = 0; this.emit('exit', 0); }
}

function dirs(t, { web = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-webui-'));
  const backend = path.join(base, 'backend');
  fs.mkdirSync(path.join(backend, 'apps', 'cli', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(backend, 'dsh.cmd'), '');
  fs.writeFileSync(path.join(backend, 'apps', 'cli', 'lib', 'bin.js'), '');
  const home = path.join(base, 'home');
  for (const profile of ['qq', 'web']) fs.mkdirSync(path.join(home, 'profiles', profile), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'qq', 'package.json'), '{}');
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify(web ? { dependencies: { '@deepseek-ai/dsh-web-app': '0.2.1-rc.3' } } : {}));
  return { base, backend, home };
}

function fixture(t, opts = {}) {
  const dir = dirs(t, opts);
  const config = mergeConfig(loadConfig(), {
    scheduler: { enabled: false },
    permissions: { groupWhitelist: ['123'], masters: ['10001'] },
    backend: { path: path.join(dir.backend, 'dsh.cmd'), dshHome: dir.home, profile: 'qq' },
  });
  const sent = [];
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    setTimeout(() => child.stdout.write('dsh web: http://127.0.0.1:5555/?token=test-token\n'), 0);
    return child;
  };
  const adapter = { fromEvent: event => normalizeEvent(event, config), sendText: async (chatId, text) => { sent.push({ chatId, text }); return {}; }, capabilities: () => ({ qzone: {} }) };
  const runtime = new Runtime({ root: dir.base, config, adapter, acp: new FakeAcp(), spawn });
  t.after(async () => { await runtime.stop(); fs.rmSync(dir.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { runtime, sent, calls, dir };
}

const event = (text, extra = {}) => ({
  message_type: 'private', user_id: 10001, self_id: 99, message_id: 1,
  message: [{ type: 'text', data: { text } }], sender: { nickname: 'owner' }, ...extra,
});

test('official web UI launches the backend web profile and stops with the plugin', async t => {
  const { runtime, calls } = fixture(t);
  const url = await runtime.startWebUi();
  assert.match(url, /^http:\/\/127\.0\.0\.1:5555\/\?token=test-token$/);
  const launched = calls[0];
  assert.deepEqual(launched.args.slice(1), ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open']);
  await runtime.stopWebUi();
  assert.equal(launched.child.killed, true);
});

test('web profile without the official bundle is reported instead of spawning', async t => {
  const { runtime, calls } = fixture(t, { web: false });
  await assert.rejects(runtime.startWebUi(), /web profile 未安装官方界面/);
  assert.equal(calls.length, 0);
});

test('web UI command is private-only and can stop the launcher', async t => {
  const { runtime, sent } = fixture(t);
  await runtime.handleCommand(event('#dshwebui'));
  assert.match(sent.at(-1).text, /DSH WebUI：http:\/\/127\.0\.0\.1:5555\//);
  await runtime.handleCommand(event('#dshwebui', { message_type: 'group', group_id: 123 }));
  assert.match(sent.at(-1).text, /私聊/);
  await runtime.handleCommand(event('#dshwebui stop'));
  assert.match(sent.at(-1).text, /已关闭/);
  assert.equal(runtime.webui, null);
});


test('concurrent launcher starts share one promise and stop rejects an in-flight launch',async t=>{
  const {runtime}=fixture(t);const children=[];
  const ui=new OfficialWebUi({runtime,spawn:()=>{const child=new FakeChild();children.push(child);return child;},timeoutMs:1000});
  const a=ui.start();const b=ui.start();assert.equal(a,b);
  await Promise.resolve();assert.equal(children.length,1);
  const rejected=assert.rejects(a,/停止/);ui.stop();await rejected;
  assert.equal(ui.child,null);assert.equal(ui.url,null);assert.equal(children[0].killed,true);
  const retry=ui.start();await Promise.resolve();
  children[1].stdout.write('http://127.0.0.1:5555/?token=retry-token');
  assert.match(await retry,/retry-token/);ui.stop();
});

test('failed launcher clears state and never copies stderr capability tokens into errors',async t=>{
  const {runtime}=fixture(t);const children=[];
  const ui=new OfficialWebUi({runtime,spawn:()=>{const child=new FakeChild();children.push(child);return child;},timeoutMs:1000});
  const pending=ui.start();await Promise.resolve();
  children[0].stderr.write('http://127.0.0.1:5555/?tok');children[0].stderr.write('en=secret-credential');
  const rejected=assert.rejects(pending,error=>!error.message.includes('secret-credential') && !error.message.includes('token='));
  children[0].emit('exit',1);await rejected;assert.equal(ui.child,null);assert.equal(ui.url,null);
  const retry=ui.start();await Promise.resolve();children[1].stdout.write('http://127.0.0.1:5555/?token=retry');await retry;ui.stop();
});
