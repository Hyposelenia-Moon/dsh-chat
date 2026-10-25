import { getRuntime } from './lib/runtime.js';

/** Start local persistent services; the ACP child remains lazy. */
export const apps = {};

for (const [name, exportName] of [['chat', 'DshChat'], ['admin', 'DshAdmin'], ['panel', 'DshPanel']]) {
  try {
    const module = await import(`./apps/${name}.js`);
    apps[name] = module[exportName];
  } catch (error) {
    const log = globalThis.logger ?? console;
    log.error(`[DSH-Chat] 无法加载 apps/${name}.js：${error.message}`);
    throw error;
  }
}

try {
  getRuntime();
} catch (error) {
  (globalThis.logger ?? console).error(`[DSH-Chat] 本地服务初始化失败：${error.message}`);
  throw error;
}

export { getRuntime };
export { supportGuoba } from './guoba.support.js';
