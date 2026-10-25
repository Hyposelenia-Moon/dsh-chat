import { loadConfig, publicConfig } from './lib/config.js';
import { schemas } from './guoba/schema.js';

const editable = new Set(schemas.map(schema => schema.field).filter(Boolean));
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

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
      if (!editable.has(field)) continue; // Guoba can submit fields hidden from this schema.
      const keys = field.split('.');
      let target = patch;
      for (const part of keys.slice(0, -1)) target = target[part] ??= {};
      target[keys.at(-1)] = value;
    }
  };
  visit(data);
  return patch;
}

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'dsh-chat',
      title: 'DSH-Chat',
      author: 'DSH-Chat contributors',
      description: 'Yunzai + NapCat + 固定 DSH fork 的 QQ 聊天插件',
      isV3: true,
      isV2: false,
    },
    configInfo: {
      schemas,
      getConfigData() { return publicConfig(loadConfig()); },
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
