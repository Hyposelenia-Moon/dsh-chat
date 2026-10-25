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
    if(method==='session/resume'){if(this.resumeError)throw this.resumeError;return{configOptions:this.configOptions};}
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
const ctx={chatId:'group:123',chatType:'group',senderId:'456'};

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

test('cancelled session waits for drain before resume, reset deletes only mapping',async t=>{
  const {sessions,acp,db}=setup(t);const initial=await sessions.ensure(ctx);
  let finish;const draining=new Promise(resolve=>{finish=resolve;});
  acp.emit('session-invalidated',{sessionId:initial.sessionId,draining});
  const waiting=sessions.ensure(ctx);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(acp.calls.filter(c=>c.method==='session/resume').length,0);
  finish();await waiting;assert.equal(acp.calls.filter(c=>c.method==='session/resume').length,1);
  await sessions.reset(ctx.chatId);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
});
