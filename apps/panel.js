import plugin from '../../../lib/plugins/plugin.js';
import { getRuntime } from '../lib/runtime.js';

export class DshPanel extends plugin {
  constructor() {
    super({
      name: 'DSH-Chat 面板',
      dsc: 'Guoba 配置入口与状态',
      event: 'message',
      priority: 99,
      rule: [{ reg: '^#[dD][sS][hH]\\s*(?:面板|panel)\\s*$', fnc: 'panel' }],
    });
  }

  async panel(event) {
    const runtime = await getRuntime();
    return runtime.handleCommand(event);
  }
}
