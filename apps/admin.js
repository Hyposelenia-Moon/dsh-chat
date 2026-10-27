import plugin from '../../../lib/plugins/plugin.js';
import { getRuntime } from '../lib/runtime.js';
import { HELP_GROUPS, VERSION, helpText } from '../lib/help.js';

const HELP_RULE = /^#dsh\s*(?:帮助|help)?\s*$/i;

export class DshAdmin extends plugin {
  constructor() {
    super({
      name: 'DSH-Chat 管理',
      dsc: '模型、会话、记忆、反馈、人格卡与帮助',
      event: 'message',
      priority: 100,
      rule: [{ reg: '^#(?:[dD][sS][hH]|好(?:\\s|$)|不好(?:\\s|$))', fnc: 'command' }],
    });
  }

  async command(event) {
    if (HELP_RULE.test(String(event.msg ?? ''))) return this.sendHelp(event);
    const runtime = await getRuntime();
    return runtime.handleCommand(event);
  }

  /** 帮助优先出图；渲染后端不可用时回退为文本。 */
  async sendHelp(event) {
    try {
      const { default: puppeteer } = await import('../../../lib/puppeteer/puppeteer.js');
      const img = await puppeteer.screenshot('dsh-chat/help', {
        tplFile: './plugins/dsh-chat/resources/help/help.html',
        groups: HELP_GROUPS,
        version: VERSION,
        imgType: 'jpeg',
        saveId: `help_${Date.now().toString(36)}`,
      });
      if (img) { await event.reply(img); return true; }
    } catch (error) {
      globalThis.logger?.error?.('[DSH-Chat] 帮助图渲染失败，已回退文本', error);
    }
    await event.reply(helpText());
    return true;
  }
}
