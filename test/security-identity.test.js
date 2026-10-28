import test from 'node:test';
import assert from 'node:assert/strict';
import {QQAdapter, chatKey} from '../lib/qq-adapter.js';
import {ChatMcpServer} from '../mcp/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ctx = (selfId, turnId) => ({selfId, chatId:'group:123', senderId:'55', role:'master', turnId});
test('internal identity separates accounts and pinned sends ignore newer gateway events', async () => {
  const calls = [];
  const adapter = new QQAdapter();
  const first = {...ctx('99','one'),event:{reply:async text => calls.push(['first',text])}};
  const newer = {...ctx('99','two'),event:{reply:async text => calls.push(['newer',text])}};
  adapter.bindEvent(first); adapter.bindEvent(newer);
  adapter.bindEvent({...ctx('88','other'),event:{reply:async text => calls.push(['other',text])}});
  assert.notEqual(chatKey(first), chatKey(ctx('88','one')));
  assert.throws(() => chatKey({chatId:'group:123'}), /机器人/);
  await adapter.sendText(first.chatId,'hello',{context:first});
  assert.deepEqual(calls,[['first',{type:'text',text:'hello'}]]);
  await assert.rejects(adapter.sendText(first.chatId,'ambiguous'), /多账号/);
});

test('old MCP URL cannot obtain next master turn and bots never share credentials', async () => {
  const calls=[];
  const server = new ChatMcpServer({execute:async (_n,_a,c) => {calls.push(c);return {ok:true};}});
  const clients=[];
  async function connect(spec) {
    const client = new Client({name:'security',version:'1'});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)));return client;
  }
  try {
    const one=ctx('99','one');const first=await server.forChat(one);
    const client=await connect(first);const grant=await server.activate(one);
    assert.ok(!(await client.callTool({name:'group_info',arguments:{}})).isError);
    grant.finish();
    const two=ctx('99','two');const next=await server.forChat(two);const nextGrant=await server.activate(two);
    assert.notEqual(first.url,next.url);
    await assert.rejects(client.callTool({name:'group_info',arguments:{}}));
    const current=await connect(next);
    assert.ok(!(await current.callTool({name:'group_info',arguments:{}})).isError);
    const other=await server.forChat(ctx('88','two'));assert.notEqual(other.url,next.url);
    assert.deepEqual(calls.map(c=>c.turnId),['one','two']);nextGrant.finish();
  } finally {for (const client of clients) await client.close();await server.stop();}
});


test('sendText preserves CQ commands as explicit text across native and OneBot paths',async()=>{
  const text='[CQ:at,qq=all][CQ:image,file=file:///private]';
  const calls=[];
  const native=new QQAdapter({bot:{pickGroup:()=>({sendMsg:async content=>calls.push(content)})}});
  await native.sendText('group:123',text);
  assert.deepEqual(calls,[{type:'text',text}]);
  const onebot=new QQAdapter({bot:{callApi:async (_action,params)=>{calls.push(params.message);return {};}}});
  await onebot.sendText('group:123',text);
  assert.deepEqual(calls[1],[{type:'text',data:{text}}]);
});
