import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, publicConfig, PLUGIN_ROOT } from './lib/config.js';
import { schemas } from './guoba/schema.js';

const editable = new Set(schemas.map(schema => schema.field).filter(Boolean));
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

/** 面板展示当前人格卡；只读打开数据库，不触发建表或迁移。 */
function personaCardsJson() {
  const file = path.join(PLUGIN_ROOT, 'data', 'dsh-chat.sqlite');
  if (!fs.existsSync(file)) return '';
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare('SELECT name,prompt,model FROM persona_cards ORDER BY id').all();
      return JSON.stringify(rows.map(row => ({ name: row.name, prompt: row.prompt, ...(row.model ? { model: row.model } : {}) })), null, 2);
    } finally { db.close(); }
  } catch { return ''; }
}

export function guobaPatch(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('配置数据格式无效');
  const patch = {};
  const visit = (object, prefix = '') => {
    for (const [key, value] of Object.entries(object)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (field.split('.').some(part => forbidden.has(part))) throw new Error('配置包含无效字段');
      if (!editable.has(field) && value && typeof value === 'object' && !Array.isArray(value)) {
        visit(value, field);
        continue;
      }
      if (!editable.has(field) || field.startsWith('status.')) continue; // Guoba can submit fields hidden from this schema.
      const keys = field.split('.');
      let target = patch;
      for (const part of keys.slice(0, -1)) target = target[part] ??= {};
      target[keys.at(-1)] = value;
    }
  };
  visit(data);
  return patch;
}

/** 锅巴顶部只读状态：后端构建、会话数、免费模型开关。 */
function statusInfo(config) {
  let backend = '未配置';
  try {
    if (config.backend?.path && path.isAbsolute(config.backend.path)) {
      const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(config.backend.path), 'dsh-chat-backend.json'), 'utf8'));
      backend = `${manifest.version ?? '?'} @ ${String(manifest.commit ?? 'local').slice(0, 12)}`;
    }
  } catch { /* 构建清单缺失时保持未配置 */ }
  let sessions = 0;
  const file = path.join(PLUGIN_ROOT, 'data', 'dsh-chat.sqlite');
  if (fs.existsSync(file)) {
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try { sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n; } finally { db.close(); }
    } catch { /* 数据库暂不可读 */ }
  }
  return { backend, sessions: String(sessions), free: config.models?.allowFree ? '已允许' : '已关闭' };
}

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'dsh-chat',
      title: 'DSH-Chat',
      author: 'DSH-Chat contributors',
      description: 'Yunzai + NapCat + 本地 DSH 后端的 QQ 聊天插件',
      isV3: true,
      isV2: false,
    },
    configInfo: {
      schemas,
      getConfigData() {
        const data = publicConfig(loadConfig());
        data.persona.cards = personaCardsJson();
        data.status = statusInfo(data);
        return data;
      },
      async setConfigData(data, { Result } = {}) {
        try {
          const patch = guobaPatch(data);
          const { getRuntime } = await import('./lib/runtime.js');
          const runtime = await getRuntime();
          await runtime.updateConfig(patch);
          return Result ? Result.ok({}, 'DSH-Chat 配置已保存') : { success: true, message: '配置已保存' };
        } catch (error) {
          return Result ? Result.error(error.message) : { success: false, message: error.message };
        }
      },
    },
  };
}

export default supportGuoba;
