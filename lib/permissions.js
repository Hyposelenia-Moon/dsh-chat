export class PolicyError extends Error {
  constructor(message, code = 'PERMISSION_DENIED') { super(message); this.code = code; }
}
export const TOOL_POLICY = {
  qq_send_text: {}, qq_send_image: {feature: 'images'}, qq_send_sticker: {feature: 'stickers'},
  qq_mention: {group: true}, qq_reply: {}, qq_send_voice: {feature: 'voice'},
  qq_send_file: {role: 'admin', feature: 'files'}, group_info: {group: true},
  qzone_post: {role: 'master', feature: 'qzone'}, qzone_comment: {role: 'master', feature: 'qzone'}, qzone_like: {role: 'master', feature: 'qzone'},
  letter_write: {role: 'master', feature: 'letters'}, schedule_task: {role: 'master'},
  memory_search: {feature: 'memory'}, memory_write: {feature: 'memory'}, memory_forget: {role: 'master', feature: 'memory'}
};
const rank = {member: 0, admin: 1, master: 2};
export class Permissions {
  constructor(config) { this.config = config; this.calls = new Map(); }
  normalize(ctx) {
    const role = ctx.isMaster || this.config.permissions.masters.includes(String(ctx.senderId)) ? 'master' : ctx.isAdmin ? 'admin' : 'member';
    return {...ctx, role};
  }
  assertChat(ctx) {
    if (!this.config.enabled || !this.config.chat.enabled) throw new PolicyError('聊天功能已关闭');
    const group = ctx.chatId.startsWith('group:');
    if (group && !this.config.permissions.allowAllGroups && !this.config.permissions.groupWhitelist.includes(ctx.chatId.slice(6))) throw new PolicyError('该群未启用聊天');
    if (!group && !this.config.chat.privateEnabled) throw new PolicyError('私聊功能已关闭');
  }
  feature(name, ctx) {
    const override = this.config.permissions.groupOverrides?.[ctx.chatId]?.[name];
    return override === undefined ? this.config.features[name] === true : override === true;
  }
  assertMaster(ctx) { if (ctx.role !== 'master') throw new PolicyError('此操作需要主人权限'); }
  assertTool(name, args, ctx) {
    this.assertChat(ctx);
    const policy = TOOL_POLICY[name];
    if (!policy) throw new PolicyError('工具未注册');
    if (policy.feature && !this.feature(policy.feature, ctx)) throw new PolicyError('该功能尚未启用', 'FEATURE_DISABLED');
    if (policy.role && (rank[ctx.role] ?? -1) < rank[policy.role]) throw new PolicyError('当前身份无权执行此工具');
    if (policy.group && !ctx.chatId.startsWith('group:')) throw new PolicyError('此工具仅限群聊');
    if (args.chatId && args.chatId !== ctx.chatId) throw new PolicyError('工具只能访问当前会话');
    if (args.scope === 'global' && ctx.role !== 'master') throw new PolicyError('全局记忆需要主人权限');
    if (args.scopeId && ![ctx.chatId, ctx.senderId, ctx.chatId.split(':')[1]].includes(String(args.scopeId)) && ctx.role !== 'master') throw new PolicyError('不能访问其他人的记忆');
    const now = Date.now(), key = `${ctx.chatId}:${ctx.senderId}`;
    const recent = (this.calls.get(key) || []).filter(t => t > now - 60000);
    if (recent.length >= this.config.permissions.toolCallsPerMinute) throw new PolicyError('工具调用过于频繁', 'RATE_LIMIT');
    recent.push(now); this.calls.set(key, recent);
    if (this.calls.size > 2000) for (const [k, times] of this.calls) if (times.at(-1) < now - 60000) this.calls.delete(k);
  }
}
