import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ChatMcpServer,validateArguments} from '../mcp/server.js';
test('MCP official client handshake, tool calls, scoped context and expired grant',async () => {
  const calls=[]; const server=new ChatMcpServer({execute:async(name,args,ctx) => { calls.push({name,args,ctx}); return {ok:true,chatId:ctx.chatId}; }});
  const spec=await server.forChat({selfId:'99',chatId:'group:123',turnId:'one'});
  const client=new Client({name:'contract-test',version:'1.0.0'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)));
    const list=await client.listTools(); assert.ok(list.tools.some(t => t.name==='qq_send_text'));
    const before=await client.callTool({name:'qq_send_text',arguments:{text:'hello'}}); assert.equal(before.isError,true);
    const grant=await server.activate({selfId:'99',chatId:'group:123',senderId:'55',role:'member',turnId:'one'});
    const result=await client.callTool({name:'qq_send_text',arguments:{text:'hello'}}); assert.ok(!result.isError); assert.equal(calls[0].ctx.senderId,'55');
    const spoof=await client.callTool({name:'qq_send_text',arguments:{text:'hello',role:'master'}}); assert.equal(spoof.isError,true); assert.equal(calls.length,1);
    grant.finish(); const after=await client.callTool({name:'qq_send_text',arguments:{text:'late'}}); assert.equal(after.isError,true);
    const response=await fetch(spec.url,{method:'POST',headers:{origin:'https://attacker.example','content-type':'application/json'},body:'{}'}); assert.equal(response.status,403);
  } finally { await client.close(); await server.stop(); }
});
test('MCP contexts for concurrent chats never share role or sender',async () => {
  const server=new ChatMcpServer({execute:async(_n,_a,ctx) => ({chat:ctx.chatId,role:ctx.role})});
  const one=await server.forChat({selfId:'99',chatId:'private:1',turnId:'a'}),two=await server.forChat({selfId:'99',chatId:'group:2',turnId:'b'});
  const a=await server.activate({selfId:'99',chatId:'private:1',role:'master',turnId:'a'}),b=await server.activate({selfId:'99',chatId:'group:2',role:'member',turnId:'b'});
  async function call(url) { const client=new Client({name:'test',version:'1'}); try { await client.connect(new StreamableHTTPClientTransport(new URL(url))); return await client.callTool({name:'group_info',arguments:{}}); } finally { await client.close(); } }
  try { const [x,y]=await Promise.all([call(one.url),call(two.url)]); assert.equal(JSON.parse(x.content[0].text).role,'master'); assert.equal(JSON.parse(y.content[0].text).role,'member'); }
  finally { a.finish(); b.finish(); await server.stop(); }
});
test('MCP rejects invalid types, unknown keys and oversized inputs',() => {
  assert.throws(() => validateArguments('qq_mention',{userId:'@all'}));
  assert.throws(() => validateArguments('memory_forget',{id:'1'}));
  assert.throws(() => validateArguments('qq_send_text',{text:'a',senderId:'1'}));
  assert.throws(() => validateArguments('qq_send_text',{text:'a'.repeat(20001)}));
});
