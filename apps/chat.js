import plugin from '../../../lib/plugins/plugin.js';
import { getRuntime } from '../lib/runtime.js';

export class DshChat extends plugin {
  constructor() {
    super({
      name: 'DSH-Chat 对话',
      dsc: 'DSH ACP 群聊与私聊入口',
      event: 'message',
      priority: 5000,
      rule: [{ reg: '^[\\s\\S]*$', fnc: 'chat', log: false }],
    });
  }

  async chat(event) {
    // Runtime performs trigger, deduplication, whitelist, role and queue checks.
    // Returning false keeps unrelated messages available to other Yunzai plugins.
    const runtime = await getRuntime({ event });
    return runtime.handleEvent(event);
  }
}
