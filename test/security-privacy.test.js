import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Runtime} from '../lib/runtime.js';
import {loadConfig,mergeConfig} from '../lib/config.js';
import {normalizeEvent} from '../lib/qq-adapter.js';
import {cleanModelText} from '../lib/privacy.js';
import {classifyModel} from '../lib/model.js';
import {validateArguments} from '../mcp/server.js';

const account=JSON.stringify(['deepseek-account','deepseek-flash']);
const free=JSON.stringify(['our-free-model','kilo-auto/free']);
const ids={bot:'987654321',chat:'876543210',sender:'765432109',mention:'654321098',message:'543210987',quoted:'432109876'};
const event=(extra={})=>({message_type:'group',self_id:ids.bot,group_id:ids.chat,user_id:ids.sender,message_id:ids.message,
  sender:{nickname:'普通昵称',role:'member'},source:{message_id:ids.quoted},
  message:[{type:'at',data:{qq:ids.bot}},{type:'at',data:{qq:ids.mention}},{type:'text',data:{text:'请打个招呼'}}],...extra});
class FakeAcp extends EventEmitter {
  constructor(value){super();this.value=value;this.calls=[];this.count=0;this.behavior=null;}
  async start(){}
  async stop(){this.emit('exit',{code:0});}
  options(){return [{id:'model',type:'select',currentValue:this.value,options:[{value:account,name:'账号'},{value:free,name:'免费'}]}];}
  async request(method,params){
    this.calls.push({method,params});
    if(method==='session/new')return {sessionId:`s${++this.count}`,configOptions:this.options()};
    if(method==='session/resume')return {configOptions:this.options()};
    if(method==='session/set_config_option'){this.value=params.value;return {configOptions:this.options()};}
    if(method==='session/prompt')return this.behavior?this.behavior(params):{stopReason:'end_turn'};
    return {};
  }
}
function fixture(t,{value=account,config:patch={}}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-privacy-'));
  const config=mergeConfig(loadConfig(),{scheduler:{enabled:false},permissions:{groupWhitelist:[ids.chat],masters:['10001'],toolCallsPerMinute:100},...patch});
  const sent=[],adapter={fromEvent:e=>normalizeEvent(e,config),sendText:async(chatId,text,options)=>{sent.push({chatId,text,options});return {message_id:ids.message};},capabilities:()=>({qzone:{}})};
  const acp=new FakeAcp(value);const runtime=new Runtime({root,config,adapter,acp});
  t.after(async()=>{await runtime.stop();fs.rmSync(root,{recursive:true,force:true});});
  return {runtime,acp,adapter,sent,config};
}
const prompts=f=>f.acp.calls.filter(c=>c.method==='session/prompt');

for(const source of ['persona','learned','memory','nickname']){
  test(`free full prompt blocks sensitive material injected through ${source}`,async t=>{
    const f=fixture(t,{value:free,config:{models:{allowFree:true,freePromptWarning:false},features:{memory:true},memory:{enabled:true},learning:{enabled:true}}});
    const secret='密码: local-only-credential';
    if(source==='persona')f.config.persona.text=secret;
    if(source==='learned')f.runtime.learning.current=()=>({content:secret});
    if(source==='memory')f.runtime.memory.search=()=>[{id:1,kind:'fact',content:secret}];
    await f.runtime.handleEvent(event(source==='nickname'?{sender:{nickname:secret,role:'member'}}:{}));
    assert.equal(prompts(f).length,0,'组装上下文中的敏感材料不得交给免费模型');
    assert.equal(f.runtime.db.prepare('SELECT status FROM turns').get().status,'failed');
    assert.equal([...f.runtime.mcp.bindings.values()].filter(b=>b.active).length,0);
    assert.ok(f.sent.length>0);assert.ok(f.sent.every(item=>!item.text.includes('local-only-credential')));
  });
}

test('free attachments are rejected before a media download or ACP prompt',async t=>{
  const f=fixture(t,{value:free,config:{models:{allowFree:true,freePromptWarning:false}}});
  f.acp.capabilities={agentCapabilities:{promptCapabilities:{image:true}}};
  let downloads=0;f.runtime.media.image=async()=>{downloads++;throw new Error('下载不应开始');};
  await f.runtime.handleEvent(event({message:[{type:'at',data:{qq:ids.bot}},{type:'image',data:{url:'https://example.invalid/image.png'}}]}));
  assert.equal(downloads,0);assert.equal(prompts(f).length,0);
});

test('an account failure never automatically falls back to a configured free provider',async t=>{
  const f=fixture(t,{config:{models:{allowFree:true,freePromptWarning:false,fallback:['our-free-model/kilo-auto/free']}}});
  f.acp.behavior=async()=>{throw new Error('429 rate limit; account failure');};
  await f.runtime.handleEvent(event());
  assert.equal(prompts(f).length,1);
  assert.equal(f.acp.calls.filter(c=>c.method==='session/set_config_option'&&c.params.value===free).length,0);
  assert.equal(f.runtime.db.prepare('SELECT model FROM sessions').get().model,account);
  assert.ok(!f.sent.some(item=>/免费|备用/.test(item.text)));
});

test('model prompt and whitelisted tool output redact known raw identities and embedded local paths',async t=>{
  const f=fixture(t);const results=[];
  f.adapter.groupInfo=async()=>({group_id:ids.chat,owner_id:ids.sender,group_name:`群 ${ids.chat} ${ids.sender} D:\\private\\identity.txt`,member_count:2,max_member_count:100,credential:'hidden-secret',extra:{path:'/home/private/token'}});
  f.acp.behavior=async()=>{
    const ctx=[...f.runtime.mcp.bindings.values()].find(b=>b.active)?.active;
    results.push(await f.runtime.executeTool('group_info',{},ctx));return {stopReason:'end_turn'};
  };
  await f.runtime.handleEvent(event({sender:{nickname:`昵称 ${ids.sender} /home/private/name.txt`,role:'member'}}));
  assert.equal(prompts(f).length,1);assert.equal(results.length,1);
  const outgoing=JSON.stringify({prompt:prompts(f)[0].params.prompt,tool:results[0]});
  for(const raw of Object.values(ids))assert.ok(!outgoing.includes(raw),`原始身份 ${raw} 不得出站`);
  assert.doesNotMatch(outgoing,/private[\\/]|hidden-secret|group_id|owner_id|credential/);
  assert.match(outgoing,/sender/);assert.match(outgoing,/mention_1/);assert.match(outgoing,/current_message/);assert.match(outgoing,/quoted_message/);
  assert.deepEqual(Object.keys(results[0]).sort(),['group_name','max_member_count','member_count']);
});

test('current turn aliases resolve only to trusted targets and reject raw or invented identifiers',async t=>{
  const f=fixture(t);const deliveries=[],failures=[];let completed=false;
  f.adapter.mention=async(chatId,userId,text,options)=>{deliveries.push({kind:'mention',chatId,id:userId,context:options.context});return {message_id:'raw-result'};};
  f.adapter.reply=async(chatId,messageId,text,options)=>{deliveries.push({kind:'reply',chatId,id:messageId,context:options.context});return {message_id:'raw-result'};};
  f.acp.behavior=async()=>{
    const ctx=[...f.runtime.mcp.bindings.values()].find(b=>b.active)?.active;
    for(const alias of ['sender','mention_1'])await f.runtime.executeTool('qq_mention',{userId:alias,text:'你好'},ctx);
    for(const alias of ['current_message','quoted_message'])await f.runtime.executeTool('qq_reply',{messageId:alias,text:'你好'},ctx);
    for(const [name,args] of [['qq_mention',{userId:ids.sender}],['qq_mention',{userId:'mention_99'}],['qq_reply',{messageId:ids.message,text:'拒绝'}],['qq_reply',{messageId:'other_message',text:'拒绝'}]]){
      try{await f.runtime.executeTool(name,args,ctx);failures.push('allowed');}catch(error){failures.push(error.code);}
    }
    completed=true;return {stopReason:'end_turn'};
  };
  await f.runtime.handleEvent(event());
  assert.equal(completed,true);assert.deepEqual(failures,['INVALID_ARGUMENT','INVALID_ARGUMENT','INVALID_ARGUMENT','INVALID_ARGUMENT']);
  assert.deepEqual(deliveries.map(x=>x.id),[ids.sender,ids.mention,ids.message,ids.quoted]);
  assert.ok(deliveries.every(x=>x.chatId===`group:${ids.chat}`&&x.context.selfId===ids.bot));
  assert.doesNotThrow(()=>validateArguments('qq_mention',{userId:'sender'}));
  assert.throws(()=>validateArguments('qq_mention',{userId:ids.sender}));
  assert.throws(()=>validateArguments('qq_reply',{messageId:ids.message,text:'x'}));
});

for(const quota of ['capacity','hourly']){
  test(`auto collection ${quota} quota refuses before any download`,async t=>{
    const f=fixture(t,{config:{features:{stickers:true},stickers:{enabled:true,autoCollect:true,maxStoreFiles:quota==='capacity'?0:20,maxPerGroupPerHour:quota==='hourly'?0:20}}});
    f.acp.capabilities={agentCapabilities:{promptCapabilities:{image:false}}};
    let downloads=0;f.runtime.media.image=async()=>{downloads++;throw new Error('不应下载');};
    await f.runtime.handleEvent(event({message:[{type:'at',data:{qq:ids.bot}},{type:'mface',data:{url:'https://example.invalid/sticker.png'}}]}));
    assert.equal(downloads,0);assert.equal(prompts(f).length,1);
    assert.equal(f.runtime.db.prepare('SELECT COUNT(*) n FROM sticker_collect_pending').get().n,0);
  });
}

test('unexpected gateway exceptions expose only fixed errors to model and chat',async t=>{
  const f=fixture(t);let error;
  f.adapter.groupInfo=async()=>{throw new Error(`gateway actor=${ids.sender} path=C:\\private\\token.txt secret-token-value`);};
  f.acp.behavior=async()=>{
    const ctx=[...f.runtime.mcp.bindings.values()].find(b=>b.active)?.active;
    try{await f.runtime.executeTool('group_info',{},ctx);}catch(caught){error=caught;throw caught;}
  };
  await f.runtime.handleEvent(event());
  assert.equal(error?.code,'OPERATION_FAILED');
  const output=JSON.stringify({error:error?.message,sent:f.sent.map(x=>x.text)});
  assert.doesNotMatch(output,/secret-token-value|private|765432109/);
  assert.match(output,/操作未完成/);
});


test('legacy sensitive memory tool content is omitted before returning to any model',async t=>{
  const f=fixture(t,{config:{features:{memory:true},memory:{enabled:true}}});
  const secrets=['contact@example.invalid','13800138000','github_pat_abcdefghijklmnop','password=synthetic-password'];
  f.runtime.memory.search=()=>secrets.map((content,index)=>({id:index+1,kind:'fact',content,actor_id:ids.sender}));
  let result;
  f.acp.behavior=async()=>{
    const ctx=[...f.runtime.mcp.bindings.values()].find(b=>b.active)?.active;
    result=await f.runtime.executeTool('memory_search',{query:'历史'},ctx);return {stopReason:'end_turn'};
  };
  // buildPrompt 也会搜索记忆；账号模型允许查看本地上下文，此处验证工具结果出站面。
  await f.runtime.handleEvent(event());
  assert.ok(Array.isArray(result));assert.equal(result.length,secrets.length);
  assert.ok(result.every(row=>row.content==='[敏感内容已省略]'));
  for(const secret of secrets)assert.ok(!JSON.stringify(result).includes(secret));
});

test('model text removes UNC and arbitrary POSIX local paths while preserving HTTPS URLs',()=>{
  const raw=String.raw`local \\server\share\token.txt path=/srv/project/key.txt work=/work/private/config https://example.invalid/public/image.png`;
  const safe=cleanModelText(raw,{});
  assert.doesNotMatch(safe,/server|share|token\.txt|srv|project|key\.txt|work\/private/);
  assert.match(safe,/https:\/\/example\.invalid\/public\/image\.png/);
  assert.equal((safe.match(/\[local path\]/g)||[]).length,3);
});

test('unrecognized provider names stay unknown even when their model or name resembles a free route',()=>{
  for(const route of [['unverified-provider','model/free'],['evilour-free-model','kilo-auto/free'],['our-free-model-evil','model'],['unknown','kilo-auto']]){
    assert.equal(classifyModel(JSON.stringify(route)),'unknown');
  }
  assert.equal(classifyModel(JSON.stringify(['our-free-model','kilo-auto/free'])),'free');
});
