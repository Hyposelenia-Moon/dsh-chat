export class ChatQueue {
  constructor({concurrency = 2, maxPendingPerChat = 10, maxPendingTotal = 100} = {}) {
    Object.assign(this, {concurrency, maxPendingPerChat, maxPendingTotal});
    this.queues = new Map(); this.active = new Map(); this.closed = false;
  }
  add(chatId, fn) {
    if (this.closed) return Promise.reject(new Error('队列已关闭'));
    const queue = this.queues.get(chatId) || [];
    if (queue.length >= this.maxPendingPerChat || this.pending >= this.maxPendingTotal) return Promise.reject(new Error('消息较多，请稍后再试'));
    return new Promise((resolve, reject) => {
      queue.push({fn, resolve, reject}); this.queues.set(chatId, queue); this.pump();
    });
  }
  get pending() { return [...this.queues.values()].reduce((n, q) => n + q.length, 0); }
  status() { return {active: this.active.size, pending: this.pending}; }
  pump() {
    for (const [chatId, queue] of this.queues) {
      if (this.active.size >= this.concurrency) break;
      if (!queue.length || this.active.has(chatId)) continue;
      const task = queue.shift();
      if (!queue.length) this.queues.delete(chatId);
      const controller = new AbortController(); this.active.set(chatId, controller);
      Promise.resolve().then(() => task.fn({signal: controller.signal})).then(task.resolve, task.reject).finally(() => { this.active.delete(chatId); this.pump(); });
    }
  }
  cancel(chatId) {
    this.active.get(chatId)?.abort(new Error('用户取消'));
    for (const task of this.queues.get(chatId) || []) task.reject(new Error('用户取消'));
    this.queues.delete(chatId);
  }
  async close() {
    this.closed = true;
    for (const chatId of new Set([...this.queues.keys(), ...this.active.keys()])) this.cancel(chatId);
    while (this.active.size) await new Promise(resolve => setTimeout(resolve, 10));
  }
}
