import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../model/db.js';
import { SessionMap } from '../lib/session-map.js';
import { normalizeModelOptions, resolveModelValue } from '../lib/model.js';

const main=JSON.stringify(['deepseek-account','deepseek-flash']);
const free=JSON.stringify(['our-free-model','kilo-auto/free']);
const options = () => [{id:'model',type:'select',currentValue:main,options:[
  {group:'deepseek-account',name:'DeepSeek',options:[{value:main,name:'Flash'}]},
  {group:'our-free-model',name:'OFM',options:[{value:free,name:'Free'}]},
]},{id:'reasoning_effort',type:'select',currentValue:'',options:[{value:'',name:'Default'},{value:'high',name:'High'}]}];
class Fake extends EventEmitter {
  constructor(){super();this.calls=[];this.configOptions=options();this.count=0;}
  start(){return Promise.resolve();}
  async request(method,params){this.calls.push({method,params});
    if(method==='session/new')return{sessionId:`session-${++this.count}`,configOptions:this.configOptions};
    if(method==='session/resume'){if(this.resumeError)throw this.resumeError;return this.resumeResult ?? {configOptions:this.configOptions};}
    if(method==='session/set_config_option') {
      if(this.optionError)throw this.optionError;
      this.configOptions=this.configOptions.map(o=>o.id===params.configId?{...o,currentValue:params.value}:o);
      return {configOptions:this.configOptions};
    }
    return {};
  }
}
function setup(t, config={}) {
  const dir=mkdtempSync(join(tmpdir(),'dsh-session-'));const db=new Store();const acp=new Fake();
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const server={type:'http',name:'dsh-chat',url:'http://127.0.0.1:54321/mcp/new-token',headers:[]};
  const sessions=new SessionMap({db,acp,config:{models:{allowFree:false},...config},workspace:dir,mcp:{forChat:()=>server}});
  return{db,acp,sessions,dir,server};
}
const ctx={selfId:'99',chatId:'group:123',chatType:'group',senderId:'456'};

test('opaque ACP model values survive slash-containing model names',()=>{
  assert.equal(resolveModelValue(options(),'our-free-model/kilo-auto/free'),free);
  assert.equal(normalizeModelOptions(options())[1].model,'kilo-auto/free');
});

test('per-chat concurrent ensure creates once and persists workspace',async t=>{
  const {sessions,acp,db,dir}=setup(t);
  const [a,b]=await Promise.all([sessions.ensure(ctx),sessions.ensure(ctx)]);
  assert.equal(a.sessionId,b.sessionId);assert.equal(acp.calls.filter(c=>c.method==='session/new').length,1);
  assert.equal(db.prepare('SELECT cwd FROM sessions').get().cwd,dir);
  await sessions.setOption(ctx,'reasoning_effort','high');
  assert.equal(db.prepare('SELECT reasoning_effort FROM sessions').get().reasoning_effort,'high');
});

test('resume uses current MCP endpoint and only missing-session errors permit replacement',async t=>{
  const {sessions,acp,server}=setup(t);await sessions.ensure(ctx);acp.emit('exit',{});
  await sessions.ensure(ctx);
  assert.deepEqual(acp.calls.find(c=>c.method==='session/resume').params.mcpServers,[server]);
  acp.emit('exit',{});acp.resumeError=Object.assign(new Error('MCP connect failure'),{code:-32603});
  await assert.rejects(sessions.ensure(ctx),/MCP/);
  assert.equal(acp.count,1);
  acp.resumeError=Object.assign(new Error('session is not resumable: old'),{code:-32602});
  await sessions.ensure(ctx);assert.equal(acp.count,2);
});

test('free default and group override obey allowFree, failed model switch keeps previous selection',async t=>{
  const {sessions,db,acp}=setup(t,{models:{allowFree:false,groupDefaults:{'group:123':'our-free-model/kilo-auto/free'}}});
  await assert.rejects(sessions.ensure(ctx),/免费模型/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
  sessions.config.models.groupDefaults={};await sessions.ensure(ctx);
  await assert.rejects(sessions.setOption(ctx,'model',free),/免费模型/);
  acp.optionError=new Error('model unavailable');
  await assert.rejects(sessions.setOption(ctx,'model',main),/unavailable/);
  assert.equal(db.prepare('SELECT model FROM sessions').get().model,main);
});

test('backend-selected free model is rejected when no explicit default is configured',async t=>{
  const {sessions,acp,db}=setup(t);
  acp.configOptions=acp.configOptions.map(o=>o.id==='model'?{...o,currentValue:free}:o);
  await assert.rejects(sessions.ensure(ctx),/免费模型/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
});

test('resume without configOptions refuses unverified backend defaults and preserves stored selection',async t=>{
  const {sessions,acp,db}=setup(t,{models:{default:'deepseek-account/deepseek-flash'}});
  await sessions.ensure(ctx);acp.emit('exit',{});acp.resumeResult={};
  await assert.rejects(sessions.ensure(ctx),/实际模型/);
  assert.equal(sessions.active.size,0);
  assert.equal(db.prepare('SELECT model FROM sessions WHERE chat_id=?').get('99:'+ctx.chatId).model,main);
});

test('model set rejects free unknown missing and different account actual values before reuse',async t=>{
  const alternate=JSON.stringify(['deepseek-account','other-account-model']);
  for(const actual of [free,JSON.stringify(['unknown-provider','model']),null,alternate]) {
    const {sessions,acp,db}=setup(t,{models:{allowFree:true}});
    const initial=await sessions.ensure(ctx),request=acp.request.bind(acp);
    acp.request=async(method,params)=>{
      if(method==='session/set_config_option') {
        acp.calls.push({method,params});
        const configOptions=actual===null?undefined:options().map(o=>o.id==='model'?{...o,currentValue:actual,options:[...o.options,{value:actual,name:'Actual'}]}:o);
        return {configOptions};
      }
      return request(method,params);
    };
    await assert.rejects(sessions.setOption(ctx,'model',main),/^Error: ACP 返回的实际模型未通过确认，已关闭会话$/);
    assert.equal(sessions.active.size,0);
    assert.equal(acp.calls.at(-1).method,'session/close');
    assert.equal(acp.calls.at(-1).params.sessionId,initial.sessionId);
    assert.equal(acp.calls.some(call=>call.method==='session/prompt'),false);
    assert.equal(db.prepare('SELECT model FROM sessions').get().model,main);
  }
});

test('effort set cannot silently change actual model even to another account provider route',async t=>{
  const {sessions,acp}=setup(t,{models:{allowFree:true}});
  const initial=await sessions.ensure(ctx),request=acp.request.bind(acp);
  const alternate=JSON.stringify(['deepseek-account','other-account-model']);
  acp.request=async(method,params)=>{
    if(method==='session/set_config_option')return {configOptions:options().map(o=>o.id==='model'?{...o,currentValue:alternate,options:[{value:alternate,name:'Other'}]}:o)};
    if(method==='session/close'){acp.calls.push({method,params});throw new Error('raw close failure');}
    return request(method,params);
  };
  await assert.rejects(sessions.setOption(ctx,'reasoning_effort','high'),/^Error: ACP 返回的实际模型未通过确认，已关闭会话$/);
  assert.equal(sessions.active.size,0);
  assert.equal(acp.calls.at(-1).params.sessionId,initial.sessionId);
});

test('validated same-trust model switch and effort settings preserve the active session',async t=>{
  const {sessions,acp,db}=setup(t),alternate=JSON.stringify(['deepseek-account','other-account-model']);
  acp.configOptions=options().map(o=>o.id==='model'?{...o,options:[...o.options,{value:alternate,name:'Other account model'}]}:o);
  const initial=await sessions.ensure(ctx);
  await sessions.setOption(ctx,'model',alternate);
  await sessions.setOption(ctx,'reasoning_effort','high');
  assert.equal((await sessions.ensure(ctx)).sessionId,initial.sessionId);
  assert.equal(db.prepare('SELECT model FROM sessions').get().model,alternate);
  assert.equal(db.prepare('SELECT reasoning_effort FROM sessions').get().reasoning_effort,'high');
  assert.equal(acp.calls.some(call=>call.method==='session/close'),false);
});

test('cancelled session waits for drain before resume, reset deletes only mapping',async t=>{
  const {sessions,acp,db}=setup(t);const initial=await sessions.ensure(ctx);
  let finish;const draining=new Promise(resolve=>{finish=resolve;});
  acp.emit('session-invalidated',{sessionId:initial.sessionId,draining});
  const waiting=sessions.ensure(ctx);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(acp.calls.filter(c=>c.method==='session/resume').length,0);
  finish();await waiting;assert.equal(acp.calls.filter(c=>c.method==='session/resume').length,1);
  await sessions.reset(ctx);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
});


test('turn endpoint changes close then resume and failures never return stale active sessions',async t=>{
  const {sessions,acp,server}=setup(t);const first=await sessions.ensure({...ctx,turnId:'one'});
  server.url='http://127.0.0.1:54321/mcp/second-token';
  const next=await sessions.ensure({...ctx,turnId:'two'});
  assert.equal(next.sessionId,first.sessionId);
  const lifecycle=acp.calls.filter(c=>['session/new','session/close','session/resume'].includes(c.method));
  assert.deepEqual(lifecycle.map(c=>c.method),['session/new','session/close','session/resume']);
  assert.equal(lifecycle[2].params.mcpServers[0].url,server.url);
  server.url='http://127.0.0.1:54321/mcp/third-token';
  acp.resumeError=Object.assign(new Error('MCP remount failed'),{code:-32603});
  await assert.rejects(sessions.ensure({...ctx,turnId:'three'}),/remount/);
  assert.equal(sessions.active.size,0);assert.equal(acp.count,1);
});

test('legacy bare chat records are never resumed by either bot',async t=>{
  const {sessions,db,acp,dir}=setup(t);
  db.prepare('INSERT INTO sessions(chat_id,chat_type,session_id,preset,cwd,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(ctx.chatId,'group','legacy','qq-host',dir,1,1);
  const a=await sessions.ensure(ctx);const b=await sessions.ensure({...ctx,selfId:'88'});
  assert.notEqual(a.sessionId,b.sessionId);
  assert.equal(acp.calls.filter(c=>c.method==='session/resume').length,0);
  assert.equal(db.prepare('SELECT session_id FROM sessions WHERE chat_id=?').get(ctx.chatId).session_id,'legacy');
});


test('cross-trust model switch starts a fresh session instead of retaining account history',async t=>{
  const {sessions,acp,db}=setup(t,{models:{allowFree:true}});
  const first=await sessions.ensure(ctx);
  await sessions.setOption(ctx,'model',free);
  const second=await sessions.ensure(ctx);
  assert.notEqual(first.sessionId,second.sessionId);
  assert.equal(db.prepare('SELECT model FROM sessions WHERE chat_id=?').get('99:'+ctx.chatId).model,free);
  assert.equal(acp.calls.filter(c=>c.method==='session/resume').length,0);
  assert.deepEqual(acp.calls.filter(c=>['session/new','session/close'].includes(c.method)).map(c=>c.method),['session/new','session/close','session/new']);
});

test('unknown backend model provider is rejected',async t=>{
  const {sessions,acp}=setup(t,{models:{allowFree:true}});
  const unknown=JSON.stringify(['unverified-provider','opaque-model']);
  acp.configOptions=[{id:'model',type:'select',currentValue:unknown,options:[{value:unknown,name:'Unknown'}]}];
  await assert.rejects(sessions.ensure(ctx),/信任/);
  assert.equal(sessions.active.size,0);
});


test('close failure removes active reference before returning the error',async t=>{
  const {sessions,acp,server}=setup(t);await sessions.ensure(ctx);
  server.url='http://127.0.0.1:54321/mcp/changed';
  const request=acp.request.bind(acp);
  acp.request=async(method,params)=>{if(method==='session/close')throw new Error('close failed');return request(method,params);};
  await assert.rejects(sessions.ensure({...ctx,turnId:'next'}),/close failed/);
  assert.equal(sessions.active.size,0);
});

test('persisted unknown model cannot be resumed for a prompt turn',async t=>{
  const {sessions,acp,db}=setup(t);await sessions.ensure(ctx);acp.emit('exit',{});
  db.prepare('UPDATE sessions SET model=?').run(JSON.stringify(['unknown-provider','model']));
  await assert.rejects(sessions.ensure({...ctx,turnId:'next'}),/信任|模型/);
  assert.equal(acp.calls.filter(c=>c.method==='session/resume').length,0);
});

test('resumed account default cannot receive the persisted free choice on old history',async t=>{
  const {sessions,acp}=setup(t,{models:{allowFree:true}});
  const initial=await sessions.ensure(ctx);await sessions.setOption(ctx,'model',free);
  const freeSession=await sessions.ensure(ctx);assert.notEqual(freeSession.sessionId,initial.sessionId);
  acp.emit('exit',{});acp.configOptions=options();
  const fresh=await sessions.ensure({...ctx,turnId:'next'});
  assert.notEqual(fresh.sessionId,freeSession.sessionId);
  assert.equal(acp.calls.filter(c=>c.method==='session/new').length,3);
  const lastResume=acp.calls.findLastIndex(c=>c.method==='session/resume');
  assert.ok(lastResume>=0);
  assert.ok(!acp.calls.slice(lastResume+1).some(c=>c.method==='session/set_config_option'&&c.params.sessionId===freeSession.sessionId));
});
