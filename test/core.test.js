import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatQueue} from '../lib/queue.js';
import {Permissions} from '../lib/permissions.js';
import {loadConfig,mergeConfig,validateConfig} from '../lib/config.js';
import {MediaStore,isPublicAddress} from '../lib/media.js';
import {redact} from '../lib/logger.js';
import {Store} from '../model/db.js';
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
test('queue serializes each chat and allows different chats concurrently',async () => {
  const queue = new ChatQueue({concurrency:2}); let running=0,peak=0; const order=[];
  await Promise.all(['a','a','b'].map((chat,i) => queue.add(chat,async () => { peak=Math.max(peak,++running); order.push(`start${i}`); await delay(10); order.push(`end${i}`); running--; })));
  assert.equal(peak,2); assert.ok(order.indexOf('end0') < order.indexOf('start1')); await queue.close();
});
test('cancel rejects pending tasks and aborts the active task',async () => {
  const queue = new ChatQueue();
  const a = queue.add('a',({signal}) => new Promise((_,reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true})));
  const b = queue.add('a',() => assert.fail('queued task ran'));
  const rejected = Promise.all([assert.rejects(a),assert.rejects(b)]); await delay(5); queue.cancel('a'); await rejected; await queue.close();
});
test('permissions bind tools to the trusted current chat and server-derived role',() => {
  const config = mergeConfig(loadConfig(),{permissions:{groupWhitelist:['123']},features:{files:true}}), policy = new Permissions(config);
  const ctx = policy.normalize({chatId:'group:123',senderId:'55',isAdmin:false,role:'master'});
  assert.equal(ctx.role,'member'); assert.throws(() => policy.assertTool('qq_send_file',{path:'x'},ctx));
  assert.throws(() => policy.assertTool('qq_send_text',{chatId:'group:456',text:'x'},ctx));
  assert.doesNotThrow(() => policy.assertTool('qq_send_text',{text:'x'},ctx));
  assert.throws(() => policy.assertChat({...ctx,chatId:'group:456'}));
});
test('config rejects prototype pollution and unsafe local-tool mode',() => {
  assert.throws(() => mergeConfig({},JSON.parse('{"__proto__":{"polluted":true}}')));
  assert.equal({}.polluted,undefined);
  assert.throws(() => validateConfig(mergeConfig(loadConfig(),{permissions:{allowOwnerLocalTools:true}})));
  assert.throws(() => validateConfig(mergeConfig(loadConfig(),{persona:{cards:'not json'}})));
});
test('media paths cannot escape the controlled root and local networks are rejected',() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'dsh-media-')); const media = path.join(root,'media'); fs.mkdirSync(media); fs.writeFileSync(path.join(root,'secret'),'private');
  const store = new MediaStore({root:media,config:loadConfig()});
  assert.throws(() => store.local('../secret'));
  for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','::1','fc00::1','::ffff:8.8.8.8','2002:7f00:1::']) assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true); fs.rmSync(root,{recursive:true,force:true});
});
test('audit redaction masks credentials and opaque MCP URLs',() => {
  const output=JSON.stringify(redact({authorization:'Bearer abc',note:'sk-abcdefghijk https://127.0.0.1/mcp/secret api_key=secret'}));
  assert.ok(!output.includes('abcdefghijk')); assert.ok(!output.includes('/mcp/secret')); assert.ok(!output.includes('=secret'));
});
test('local media authorization prevents reading another chat letter or private image',() => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-owned-media-')),db=new Store();
  const store=new MediaStore({root,config:loadConfig(),db});
  const file=path.join(root,'letter.txt'); fs.writeFileSync(file,'private letter');
  const owner={chatId:'private:1',senderId:'1',selfId:'999',storageKey:'bot:999:private:1'};
  const group={chatId:'group:123',senderId:'1',selfId:'999',storageKey:'bot:999:group:123'};
  store.register(file,owner);
  assert.equal(store.local(file,owner),file);
  assert.throws(()=>store.local(file,group),/未授权/);
  const upload=path.join(root,'uploads','999','group_123'); fs.mkdirSync(upload,{recursive:true}); fs.writeFileSync(path.join(upload,'a.txt'),'group file');
  assert.equal(store.local(path.join(upload,'a.txt'),group),path.join(upload,'a.txt'));
  assert.throws(()=>store.local(path.join(upload,'a.txt'),{...group,chatId:'group:456',storageKey:'bot:999:group:456'}));
  store.stop(); db.close(); fs.rmSync(root,{recursive:true,force:true});
});
