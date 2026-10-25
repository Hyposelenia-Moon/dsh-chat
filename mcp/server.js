import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';

const str = (description, extra = {}) => ({type: 'string', description, minLength: 1, maxLength: 20000, ...extra});
const id = {type: 'integer', minimum: 1};
const tool = (name, description, properties = {}, required = []) => ({name, description, inputSchema: {type:'object', properties, required, additionalProperties:false}});
export const TOOLS = [
  tool('qq_send_text', '向当前聊天发送文本', {text: str('文本')}, ['text']),
  tool('qq_send_image', '发送公开 HTTPS 图片或插件媒体目录内图片', {path: str('受控媒体路径'), url: str('公开图片 HTTPS URL')}),
  tool('qq_send_sticker', '从本群表情库选择表情', {stickerId: id, tag: str('标签')}),
  tool('qq_mention', '在当前群提及指定 QQ 用户', {userId: str('QQ号', {pattern:'^\\d+$'}), text: str('附加文本')}, ['userId']),
  tool('qq_reply', '引用当前聊天中的消息回复', {messageId: str('QQ消息ID'), text: str('文本')}, ['messageId','text']),
  tool('qq_send_voice', '使用 QQ TTS 或受控音频文件发语音', {text: str('TTS文本'), audio: str('受控音频路径')}),
  tool('qq_send_file', '发送插件媒体目录内文件，需要主人或群管', {path: str('文件路径')}, ['path']),
  tool('group_info', '查询当前群的群资料'),
  tool('qzone_post', '通过明确注入的 QQ 空间适配器发说说', {text: str('正文'), images:{type:'array',items:str('插件媒体路径'),maxItems:9}}, ['text']),
  tool('qzone_comment', '评论空间动态', {postId: str('动态ID'), text: str('评论')}, ['postId','text']),
  tool('qzone_like', '赞空间动态', {postId: str('动态ID')}, ['postId']),
  tool('letter_write', '写入文本或文件信件，可安排发送', {title: str('标题'), body: str('正文'), format:{type:'string',enum:['text','file','image']}, scheduledAt: {type:'integer',minimum:0}}, ['title','body']),
  tool('memory_search', '检索当前用户和本群的相关记忆', {query:str('检索词'), scope:{type:'string',enum:['user','group','global']}}, ['query']),
  tool('memory_write', '写入本人或本群记忆', {content:str('内容'), kind:{type:'string',enum:['fact','preference','event','relation','rule']}, scope:{type:'string',enum:['user','group','global']}}, ['content','kind','scope']),
  tool('memory_forget', '标记记忆已过时，保留恢复能力', {id}, ['id']),
  tool('schedule_task', '预约发送文本、信件、空间动态或生成反思材料', {kind:{type:'string',enum:['text_send','letter_send','qzone_post','reflection']}, runAt:{type:'integer',minimum:0}, payload:{type:'object',additionalProperties:true}}, ['kind','runAt','payload'])
];
function checkValue(value, schema, name) {
  if (schema.type === 'string' && (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) throw new Error(`参数 ${name} 格式无效`);
  if (schema.type === 'integer' && (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity))) throw new Error(`参数 ${name} 格式无效`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`参数 ${name} 不在可用范围内`);
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`参数 ${name} 需要对象`);
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) throw new Error(`参数 ${name} 需要数组`);
    for (const v of value) checkValue(v, schema.items, name);
  }
}
export function validateArguments(name, args) {
  const spec = TOOLS.find(t => t.name === name)?.inputSchema;
  if (!spec || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具或参数无效');
  for (const key of spec.required) if (args[key] === undefined) throw new Error(`缺少参数 ${key}`);
  for (const [key,value] of Object.entries(args)) {
    if (!Object.hasOwn(spec.properties,key)) throw new Error(`不接受参数 ${key}`);
    checkValue(value,spec.properties[key],key);
  }
  if (JSON.stringify(args).length > 64000) throw new Error('工具参数过长');
}
export class ChatMcpServer {
  constructor({execute, logger}) { this.execute = execute; this.logger = logger; this.bindings = new Map(); this.transports = new Set(); }
  async start() {
    if (this.http) return;
    this.http = http.createServer(async (req,res) => {
      const host = req.headers.host;
      if (host !== `127.0.0.1:${this.port}` || req.headers.origin) { res.writeHead(403).end(); return; }
      const binding = this.bindings.get(req.url);
      if (!binding) { res.writeHead(404).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, {Allow:'POST'}).end(); return; }
      const server = new Server({name:'dsh-chat',version:'0.1.0'}, {capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: TOOLS}));
      server.setRequestHandler(CallToolRequestSchema, async request => {
        try {
          if (!binding.active || binding.active.signal?.aborted) throw new Error('当前会话没有有效的消息轮次');
          const ctx = binding.active;
          const args = request.params.arguments || {};
          validateArguments(request.params.name, args);
          const result = await this.execute(request.params.name,args,ctx);
          return {content:[{type:'text',text:JSON.stringify(result ?? {ok:true})}]};
        } catch (e) { return {isError:true, content:[{type:'text',text:JSON.stringify({error:{code:e.code || 'TOOL_FAILED',message:e.message}})}]}; }
      });
      const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      this.transports.add(transport);
      res.on('close', () => { this.transports.delete(transport); transport.close().catch(() => {}); server.close().catch(() => {}); });
      try {
        await server.connect(transport);
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 128000) { res.writeHead(413).end(); return; } chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        await transport.handleRequest(req,res,body);
      } catch (e) { this.logger?.warn('mcp_request_failed',{error:e.message}); if (!res.headersSent) res.writeHead(400).end(); }
    });
    this.http.requestTimeout = 30000; this.http.headersTimeout = 10000;
    await new Promise((resolve,reject) => { this.http.once('error',reject); this.http.listen(0,'127.0.0.1',resolve); });
    this.port = this.http.address().port;
  }
  async forChat(ctx) {
    await this.start();
    let entry = [...this.bindings.entries()].find(([,v]) => v.chatId === ctx.chatId);
    if (!entry) { entry = [`/mcp/${randomBytes(32).toString('hex')}`,{chatId:ctx.chatId,active:null}]; this.bindings.set(...entry); }
    return {type:'http',name:'dsh-chat',url:`http://127.0.0.1:${this.port}${entry[0]}`,headers:[]};
  }
  async activate(ctx) {
    const spec = await this.forChat(ctx), binding = this.bindings.get(new URL(spec.url).pathname);
    if (binding.active) throw new Error('同一会话不能同时授权两个工具轮次');
    binding.active = Object.freeze({...ctx});
    return {finish:() => { if (binding.active?.turnId === ctx.turnId) binding.active = null; }};
  }
  async stop() {
    for (const b of this.bindings.values()) b.active = null;
    for (const transport of this.transports) await transport.close();
    if (this.http) { this.http.closeAllConnections(); await new Promise(resolve => this.http.close(resolve)); }
    this.http = null; this.bindings.clear();
  }
}
