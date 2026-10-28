import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * 帮助图只承担「部署 + 状态」两件事，不再罗列指令：
 * 复杂操作走官方 DSH WebUI，其余命令保留但不在帮助里展开。
 */
export const HELP_GROUPS = [
  {
    title: '部署',
    items: [
      { cmd: '1. 安装插件依赖', desc: '在插件目录执行 npm ci --ignore-scripts' },
      { cmd: '2. 准备后端', desc: 'node scripts/backend-prepare.mjs，把 qq profile 装进 DSH_HOME' },
      { cmd: '3. 安装官方界面', desc: 'dsh plugin --profile web add @deepseek-ai/dsh-web-app@0.2.1-rc.3' },
      { cmd: '4. 配置并重启', desc: '锅巴填 backend.path / dshHome，重启 Yunzai' },
    ],
  },
  {
    title: '状态',
    items: [
      { cmd: '官方界面', desc: '主人私聊 #dshwebui 打开；#dshwebui stop 关闭' },
      { cmd: '运行状态', desc: '#dsh状态 查看 ACP、队列、会话数' },
      { cmd: '版本', desc: `v${VERSION}` },
      { cmd: '更新', desc: '主人私聊 #dsh更新，只做 fast-forward' },
    ],
  },
];

/** 文本回退：渲染后端不可用时使用。 */
export function helpText() {
  const lines = ['DSH-Chat 帮助'];
  for (const group of HELP_GROUPS) {
    lines.push(`【${group.title}】`);
    for (const item of group.items) lines.push(`· ${item.cmd} — ${item.desc}`);
  }
  lines.push('复杂操作在官方 WebUI 完成；命令仍可用，但不再逐条列出。');
  lines.push('模型安全限制：仅确认的账号模型自动备用；免费模型需显式开启，拒绝敏感内容与图片，规则检查不保证覆盖全部隐私。');
  return lines.join('\n');
}
