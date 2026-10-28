import {redact} from './logger.js';
import {sensitive} from './feature-utils.js';

/** 规则检查只是减少已知敏感模式，不能替代用户对模型提供方的信任决策。 */
export const sensitiveMaterial = value => sensitive(value) || /密码|密钥|隐私|商业机密|身份证|银行卡|(?:\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token)\b)/i.test(String(value));

/** 真实目标只保存在宿主内存，模型仅获得本轮可用别名。 */
export function turnAliases(ctx) {
  const users = new Map([['sender', String(ctx.senderId)]]);
  for (const id of ctx.mentions ?? []) {
    if (String(id) !== String(ctx.selfId) && ![...users.values()].includes(String(id))) users.set(`mention_${users.size}`, String(id));
  }
  const messages = new Map();
  if (ctx.messageId) messages.set('current_message', String(ctx.messageId));
  if (ctx.replyTo) messages.set('quoted_message', String(ctx.replyTo));
  return {users, messages};
}

export function cleanModelText(value, ctx = {}) {
  let text = redact(String(value));
  // 过滤字符串中间的绝对路径，而非只检查字符串开头。
  text = text.replace(/\b[A-Za-z]:[\\/][^\s"'<>，。；]+/g, '[local path]')
    .replace(/(^|[\s("'=])\\\\[^\s"'<>，。；]+/g, '$1[local path]')
    .replace(/(^|[\s("'=])\/(?!\/)[^\s"'<>，。；]+/g, '$1[local path]');
  const aliases = turnAliases(ctx);
  const ids = new Map([[String(ctx.selfId ?? ''), 'bot'], [String(ctx.chatId?.split(':')[1] ?? ''), 'current_chat']]);
  for (const [alias, id] of aliases.users) ids.set(id, alias);
  for (const [alias, id] of aliases.messages) ids.set(id, alias);
  for (const [id, alias] of [...ids].sort((a,b) => b[0].length-a[0].length)) {
    if (!id) continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(?<![0-9])${escaped}(?![0-9])`, 'g'), alias);
  }
  return text;
}

const FIELDS = {
  group_info: ['group_name','member_count','max_member_count'],
  memory_search: ['id','kind','content','subject','importance','score'],
  memory_write: ['id','kind','content','duplicate'], memory_forget: ['id','forgotten_at'],
  letter_write: ['id','title','body','format','scheduled_at','created_at'],
  schedule_task: ['id','kind','status','run_at','created_at'],
  qq_send_sticker: ['id','tags','emotion','usage_count','delivery'],
  qzone_post: ['supported','action'], qzone_comment: ['supported','action'], qzone_like: ['supported','action'],
  qq_send_text: ['ok'], qq_send_image: ['ok'], qq_mention: ['ok'], qq_reply: ['ok'], qq_send_voice: ['ok'], qq_send_file: ['ok'],
};
/** 每个工具显式选择模型可见字段，默认不返回网关原始结果。 */
export function modelToolResult(name, value, ctx) {
  const allowed = new Set(FIELDS[name] ?? []);
  const clean = (item, depth = 0) => {
    if (depth > 8) return '[omitted]';
    if (Array.isArray(item)) return item.slice(0,50).map(row => clean(row, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => allowed.has(key)).map(([key,v]) => [key, clean(v,depth+1)]));
    return typeof item === 'string' ? sensitive(item) ? '[敏感内容已省略]' : cleanModelText(item,ctx) : item;
  };
  if (!value || !allowed.size) return {ok:true};
  const result = clean(value);
  return result && typeof result === 'object' && !Array.isArray(result) && !Object.keys(result).length ? {ok:true} : result;
}

export function publicError(error) {
  const codes = new Set(['PERMISSION_DENIED','FEATURE_DISABLED','RATE_LIMIT','FORBIDDEN','QUOTA_EXCEEDED','SENSITIVE_CONTENT','INVALID_ARGUMENT','INVALID_MEDIA','NOT_FOUND','UNSUPPORTED','ABORT_ERR','ACP_DEGRADED','ACP_OFFLINE','PRIVATE_REQUIRED']);
  const code = codes.has(error?.code) ? error.code : 'OPERATION_FAILED';
  const messages = {PRIVATE_REQUIRED:'请在主人私聊中使用此操作，避免链接外泄',PERMISSION_DENIED:'当前身份没有操作权限',FORBIDDEN:'当前身份没有操作权限',FEATURE_DISABLED:'该功能尚未启用',RATE_LIMIT:'操作过于频繁，请稍后重试',QUOTA_EXCEEDED:'操作额度已用完或请求过于频繁',SENSITIVE_CONTENT:'内容包含敏感信息，已拒绝处理',INVALID_ARGUMENT:'参数格式无效',INVALID_MEDIA:'媒体格式或大小无效',NOT_FOUND:'未找到当前聊天可用的记录',UNSUPPORTED:'当前适配器不支持此操作',ABORT_ERR:'操作已取消'};
  return {code,message:messages[code] ?? '操作未完成，请主人在本机检查状态与配置'};
}
