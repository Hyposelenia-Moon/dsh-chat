import http from 'node:http';
import {publicError} from '../lib/privacy.js';
import {chatKey} from '../lib/qq-adapter.js';
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
  tool('qq_mention', '在当前群提及指定 QQ 用户', {userId: str('本轮用户别名', {pattern:'^(?:sender|mention_[1-9][0-9]*)$'}), text: str('附加文本')}, ['userId']),
  tool('qq_reply', '引用当前聊天中的消息回复', {messageId: str('本轮消息别名', {pattern:'^(?:current_message|quoted_message)$'}), text: str('文本')}, ['messageId','text']),
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
  start() {
    if (this.starting) return this.starting;
    if (this.http) return Promise.resolve();
    const pending = this._start();
    this.starting = pending;
    pending.then(() => { this.starting = null; }, () => { this.starting = null; this.http = null; });
    return pending;
  }
  async _start() {
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
        } catch (e) { return {isError:true, content:[{type:'text',text:JSON.stringify({error:publicError(e)})}]}; }
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
      } catch (e) { this.logger?.warn('mcp_request_failed',{error:publicError(e).code}); if (!res.headersSent) res.writeHead(400).end(); }
    });
    this.http.requestTimeout = 30000; this.http.headersTimeout = 10000;
    await new Promise((resolve,reject) => { this.http.once('error',reject); this.http.listen(0,'127.0.0.1',resolve); });
    this.port = this.http.address().port;
  }
  async forChat(ctx) {
    await this.start();
    const key = chatKey(ctx);
    let entry = [...this.bindings.entries()].find(([,v]) => v.key === key);
    if (entry && entry[1].turnId !== ctx.turnId) {
      if (entry[1].active) throw new Error('同一会话不能同时授权两个工具轮次');
      this.bindings.delete(entry[0]);
      entry = null;
    }
    if (!entry) {
      entry = [`/mcp/${randomBytes(32).toString('hex')}`, {key, turnId:ctx.turnId, active:null, finished:false}];
      this.bindings.set(...entry);
    }
    return {type:'http',name:'dsh-chat',url:`http://127.0.0.1:${this.port}${entry[0]}`,headers:[]};
  }
  async activate(ctx) {
    if (!ctx.turnId) throw new Error('工具授权必须指定消息轮次');
    const spec = await this.forChat(ctx), binding = this.bindings.get(new URL(spec.url).pathname);
    if (binding.active || binding.finished) throw new Error('同一会话不能同时授权两个工具轮次或复用旧轮次');
    binding.active = Object.freeze({...ctx});
    return {finish:() => { binding.active = null; binding.finished = true; }};
  }
  async stop() {
    for (const b of this.bindings.values()) b.active = null;
    for (const transport of this.transports) await transport.close();
    if (this.http) { this.http.closeAllConnections(); await new Promise(resolve => this.http.close(resolve)); }
    this.http = null; this.bindings.clear();
  }
}
