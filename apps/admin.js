import plugin from '../../../lib/plugins/plugin.js';
import { getRuntime } from '../lib/runtime.js';

export class DshAdmin extends plugin {
  constructor() {
    super({
      name: 'DSH-Chat 管理',
      dsc: '模型、会话、记忆、反馈和人格审批',
      event: 'message',
      priority: 100,
      rule: [{ reg: '^#(?:[dD][sS][hH](?:\\s|$)|好(?:\\s|$)|不好(?:\\s|$))', fnc: 'command' }],
    });
  }

  async command(event) {
    const runtime = await getRuntime({ event });
    return runtime.handleCommand(event);
  }
}
