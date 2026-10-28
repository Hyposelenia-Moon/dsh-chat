import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function safeObject(value, depth = 0) {
  if (depth > 12) throw new Error('配置嵌套过深');
  if (Array.isArray(value)) return value.map(v => safeObject(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (forbidden.has(k)) throw new Error('配置包含无效字段');
      out[k] = safeObject(v, depth + 1);
    }
    return out;
  }
  return value;
}
export function mergeConfig(base, patch) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(safeObject(patch))) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v)
      ? mergeConfig(base?.[k] && typeof base[k] === 'object' ? base[k] : {}, v) : v;
  }
  return out;
}
export function validateConfig(c) {
  for (const section of ['backend','chat','permissions','models','persona','queue','features','memory','learning','stickers','letters','qzone','scheduler','media','logging']) {
    if (!c[section] || typeof c[section] !== 'object' || Array.isArray(c[section])) throw new Error(`配置 ${section} 必须为对象`);
  }
  const bools = ['enabled','chat.enabled','chat.privateEnabled','chat.atEnabled','chat.quoteReply','permissions.allowAllGroups','permissions.allowOwnerLocalTools','models.allowFree','models.freePromptWarning','memory.enabled','memory.autoExtract','learning.enabled','learning.autoReflect','learning.requireApproval','stickers.enabled','stickers.autoCollect','letters.enabled','qzone.enabled','scheduler.enabled','logging.includeContent'];
  for (const key of [...bools,...Object.keys(c.features).map(k=>`features.${k}`)]) {
    const value=key.split('.').reduce((v,k)=>v?.[k],c);
    if (typeof value !== 'boolean') throw new Error(`${key} 必须为布尔值`);
  }
  for (const [k, lo, hi] of [['concurrency', 1, 16], ['maxPendingPerChat', 1, 100], ['maxPendingTotal', 1, 1000], ['timeoutMs', 1000, 900000]]) {
    if (!Number.isInteger(c.queue[k]) || c.queue[k] < lo || c.queue[k] > hi) throw new Error(`queue.${k} 必须在 ${lo}–${hi} 之间`);
  }
  if (!['split', 'merged'].includes(c.chat.outputMode)) throw new Error('chat.outputMode 必须为 split 或 merged');
  if (!Number.isInteger(c.chat.maxMessageLength) || c.chat.maxMessageLength < 100 || c.chat.maxMessageLength > 10000) throw new Error('消息长度必须在 100–10000 之间');
  if (typeof c.persona.text !== 'string' || c.persona.text.length > 16000) throw new Error('人格文本过长或格式无效');
  if (typeof c.persona.cards !== 'string' || c.persona.cards.length > 200000) throw new Error('人格卡导入内容必须是字符串且不超过 200000 字符');
  if (c.persona.cards.trim()) {
    let cards;
    try { cards = JSON.parse(c.persona.cards); } catch { throw new Error('人格卡导入内容必须是 JSON 数组'); }
    if (!Array.isArray(cards)) throw new Error('人格卡导入内容必须是 JSON 数组');
  }
  if (typeof c.chat.prefix !== 'string' || c.chat.prefix.length > 30) throw new Error('触发前缀格式无效');
  if (!Array.isArray(c.models.fallback) || c.models.fallback.some(v=>typeof v !== 'string')) throw new Error('备用模型需要字符串数组');
  for (const key of ['maxInputLength']) if (!Number.isInteger(c.chat[key]) || c.chat[key]<1 || c.chat[key]>100000) throw new Error(`chat.${key} 无效`);
  for (const [section,key,lo,hi] of [['permissions','toolCallsPerMinute',1,1000],['memory','maxInjected',1,20],['memory','maxAutomaticPerDay',0,1000],['learning','maxCandidatesPerDay',0,100],['learning','feedbackCooldownMs',0,3600000],['learning','maxFeedbackPerChatPerDay',0,100000],['learning','feedbackRetentionDays',1,3650],['stickers','maxStoreBytes',0,10*1024**3],['stickers','maxStoreFiles',0,100000],['scheduler','intervalMs',100,60000],['media','timeoutMs',1000,60000],['media','ttlHours',1,720],['media','maxCacheBytes',0,10*1024**3],['media','maxDownloadsPerChatPerHour',0,100000],['media','cleanupIntervalMs',10,86400000]]) if (!Number.isInteger(c[section][key]) || c[section][key]<lo || c[section][key]>hi) throw new Error(`${section}.${key} 无效`);
  for (const k of ['masters', 'groupWhitelist']) {
    if (!Array.isArray(c.permissions[k]) || c.permissions[k].some(id => !/^\d+$/.test(String(id)))) throw new Error(`${k} 应填写 QQ 号数组`);
    c.permissions[k] = c.permissions[k].map(String);
  }
  if (c.learning.requireApproval !== true) throw new Error('人格候选必须经过主人审批');
  if (c.permissions.allowOwnerLocalTools) throw new Error('本版只开放受控 MCP 工具，请保持 allowOwnerLocalTools=false');
  if (!Number.isInteger(c.media.maxBytes) || c.media.maxBytes < 1024 || c.media.maxBytes > 50 * 1024 * 1024) throw new Error('媒体大小限制无效');
  return c;
}
export function loadConfig({root = PLUGIN_ROOT} = {}) {
  const defaults = YAML.parse(fs.readFileSync(path.join(root, 'config/default_config.yaml'), 'utf8'));
  const local = path.join(root, 'config/config.yaml');
  return validateConfig(mergeConfig(defaults, fs.existsSync(local) ? YAML.parse(fs.readFileSync(local, 'utf8'), {maxAliasCount: 0}) || {} : {}));
}
export function saveConfig(patch, {root = PLUGIN_ROOT} = {}) {
  const config = validateConfig(mergeConfig(loadConfig({root}), patch));
  const target = path.join(root, 'config/config.yaml');
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, YAML.stringify(config), {mode: 0o600});
  fs.renameSync(temporary, target);
  return config;
}
export function publicConfig(config) {
  const copy = structuredClone(config);
  if (copy.media.proxyUrl) copy.media.proxyUrl = '[configured]';
  return copy;
}
