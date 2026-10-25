import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Runtime} from '../lib/runtime.js';
import {loadConfig,mergeConfig} from '../lib/config.js';
import {normalizeEvent} from '../lib/qq-adapter.js';
const model = JSON.stringify(['deepseek-account','deepseek-flash']);
function options() { return [{id:'model',type:'select',currentValue:model,options:[{value:model,name:'DeepSeek Flash'}]}]; }
class FakeAcp extends EventEmitter {
  constructor() { super(); this.count=0; this.prompts=0; this.calls=[]; this.behavior=null; }
  async start() { this.active=true; return {protocolVersion:1}; }
  async stop() { this.active=false; this.emit('exit',{code:0}); }
  async request(method,params,opts={}) {
    this.calls.push({method,params});
    if (method==='session/new') return {sessionId:`s${++this.count}`,configOptions:options()};
    if (method==='session/resume') return {configOptions:options()};
    if (method==='session/set_config_option') return {configOptions:options()};
    if (method==='session/prompt') { this.prompts++; if (this.behavior) return this.behavior(params,opts); this.emit('update',{sessionId:params.sessionId,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE THOUGHT'}}}); this.emit('update',{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'你好，已收到。'}}}); return {stopReason:'end_turn'}; }
    return {};
  }
}
function fixture(extra={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-runtime-'));
  const config=mergeConfig(loadConfig(),{scheduler:{enabled:false},permissions:{groupWhitelist:['123'],masters:['10001']},...extra});
  const sent=[]; const adapter={fromEvent:e=>normalizeEvent(e,config),sendText:async(chatId,text)=>{sent.push({chatId,text}); return {message_id:sent.length};},capabilities:()=>({qzone:{post:false,comment:false,like:false}})};
  const acp=new FakeAcp(); const runtime=new Runtime({root,config,adapter,acp});
  return {root,config,sent,acp,runtime,async close(){await runtime.stop(); fs.rmSync(root,{recursive:true,force:true});}};
}
const event=(text,id=1,overrides={})=>({message_type:'group',group_id:123,user_id:55,self_id:99,message_id:id,message:[{type:'at',data:{qq:'99'}},{type:'text',data:{text}}],sender:{role:'member',nickname:'tester'},...overrides});
test('OneBot event → queue → persistent ACP session → QQ reply; duplicate events ignored',async()=>{
  const f=fixture(); try {
    assert.equal(await f.runtime.handleEvent(event('你好')),true); assert.equal(f.acp.prompts,1); assert.equal(f.sent[0].text,'你好，已收到。');
    assert.ok(!f.sent.some(s=>s.text.includes('THOUGHT')));
    assert.equal(await f.runtime.handleEvent(event('你好')),false); assert.equal(f.acp.prompts,1);
    await f.runtime.handleEvent(event('再聊',2)); assert.equal(f.acp.count,1);
    assert.equal(f.runtime.db.prepare('SELECT COUNT(*) n FROM messages').get().n,4);
  } finally {await f.close();}
});
test('other Yunzai commands and groups outside whitelist do not call ACP',async()=>{
  const f=fixture(); try { assert.equal(await f.runtime.handleEvent(event('#其他插件')),false); assert.equal(await f.runtime.handleEvent(event('你好',2,{group_id:999})),false); assert.equal(f.acp.prompts,0); } finally {await f.close();}
});
test('persisted session resumes after ACP exit and receives a current MCP endpoint',async()=>{
  const f=fixture(); try {await f.runtime.handleEvent(event('一')); f.acp.emit('exit',{code:1}); await f.runtime.handleEvent(event('二',2)); const resume=f.acp.calls.find(c=>c.method==='session/resume'); assert.ok(resume); assert.match(resume.params.mcpServers[0].url,/^http:\/\/127\.0\.0\.1:/); assert.equal(f.acp.count,1);} finally {await f.close();}
});
test('non-owner cannot change models or clear session; model cannot forge role',async()=>{
  const f=fixture(); try { await f.runtime.handleCommand(event('#dsh 清空')); assert.match(f.sent.at(-1).text,/主人权限/); assert.equal(f.acp.calls.length,0); const ctx=f.runtime.context(event('x')); assert.equal(ctx.role,'member'); await assert.rejects(f.runtime.executeTool('qzone_post',{text:'x'},{...ctx,turnId:'fake'})); } finally {await f.close();}
});
test('scheduler reevaluates owner permissions and passes trusted stored context',async()=>{
  const f=fixture({scheduler:{enabled:true,intervalMs:60000}}); try {
    const ctx={chatId:'group:123',senderId:'10001',role:'master'};
    f.runtime.scheduler.schedule({kind:'text_send',runAt:Date.now(),payload:{text:'定时消息'}},ctx); await f.runtime.scheduler.tick(); assert.equal(f.sent.at(-1).text,'定时消息');
    f.runtime.scheduler.schedule({kind:'text_send',runAt:Date.now(),payload:{text:'不应发送'}},ctx); f.config.permissions.masters=[]; await f.runtime.scheduler.tick(); assert.ok(!f.sent.some(s=>s.text==='不应发送'));
  } finally {await f.close();}
});
test('unsupported image capability falls back to text without fetching or sending image blocks',async()=>{
  const f=fixture(); try {
    f.acp.capabilities={agentCapabilities:{promptCapabilities:{image:false}}};
    f.runtime.media.image=()=>assert.fail('unsupported attachment should not be fetched');
    await f.runtime.handleEvent(event('看看图片',1,{message:[{type:'at',data:{qq:'99'}},{type:'image',data:{url:'https://example.com/a.png'}}]}));
    const prompt=f.acp.calls.find(c=>c.method==='session/prompt').params.prompt;
    assert.equal(prompt.length,1); assert.match(prompt[0].text,/没有声明图片输入能力/);
  } finally {await f.close();}
});
test('a failed turn insert still releases the MCP grant for the next message',async()=>{
  const f=fixture(); try {
    const prepare=f.runtime.db.prepare.bind(f.runtime.db);
    let failed=false;
    f.runtime.db.prepare=sql=>{
      if(!failed && sql.includes('INSERT INTO turns')){failed=true;throw new Error('disk full');}
      return prepare(sql);
    };
    await f.runtime.handleEvent(event('第一句'));
    assert.match(f.sent.at(-1).text,/disk full/);
    await f.runtime.handleEvent(event('第二句',2));
    assert.match(f.sent.at(-1).text,/你好，已收到/);
  } finally {await f.close();}
});
test('free model sensitive-input guard remains active when its warning is disabled',async()=>{
  const f=fixture({models:{allowFree:true,freePromptWarning:false}}); try {
    f.runtime.sessions.ensure=async()=>{
      f.runtime.db.prepare('INSERT INTO sessions(chat_id,chat_type,session_id,model,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('group:123','group','free',JSON.stringify(['our-free-model','kilo-auto/free']),Date.now(),Date.now());
      return {sessionId:'free',configOptions:options()};
    };
    await f.runtime.handleEvent(event('密码: abcdefghijk'));
    assert.equal(f.acp.prompts,0); assert.match(f.sent.at(-1).text,/不能使用免费模型/);
  } finally {await f.close();}
});
