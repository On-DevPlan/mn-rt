'use strict';

/**
 * FIFO 消息队列：串行消费，保证「一条输入完成再处理下一条」（需求文档 4.2.2 第 2 条）。
 *
 * 要点：
 *   * 严格 FIFO，绝不并发下发，避免字符交叉乱序；
 *   * 有界队列，超出容量时丢弃新消息并告警（丢弃新消息而非旧消息，
 *     因为旧消息已经在途、语义上更接近用户已完成的操作）；
 *   * 对外暴露 pause / resume，便于断线或重启子进程时挂起消费。
 */

class MessageQueue {
  /**
   * @param {object} opts
   * @param {number} [opts.maxSize]          最大排队条数
   * @param {Function} opts.handler          消费函数 async (item, meta) => void
   * @param {object} opts.logger
   */
  constructor(opts) {
    this.maxSize = opts.maxSize ?? 100;
    this.handler = opts.handler;
    this.logger = opts.logger;

    this._queue = [];
    this._running = false;
    this._paused = false;
    this._idleWaiters = [];

    this.stats = { enqueued: 0, processed: 0, failed: 0, dropped: 0, maxDepthSeen: 0 };
  }

  /** 当前排队深度（不含正在处理的那条）。 */
  get depth() {
    return this._queue.length;
  }

  get busy() {
    return this._running;
  }

  /**
   * 入队一条消息。
   * @returns {boolean} true=已入队，false=因队列满被丢弃
   */
  push(item, meta = {}) {
    if (this._queue.length >= this.maxSize) {
      this.stats.dropped += 1;
      this.logger?.warn('message queue overflow, dropping new message', {
        maxSize: this.maxSize,
        textLen: typeof item?.text === 'string' ? item.text.length : 0,
      });
      return false;
    }
    this._queue.push({ item, meta });
    this.stats.enqueued += 1;
    if (this._queue.length > this.stats.maxDepthSeen) {
      this.stats.maxDepthSeen = this._queue.length;
    }
    this.logger?.debug('message enqueued', { depth: this._queue.length });
    // 触发消费（不 await，避免调用方被阻塞）
    this._drain();
    return true;
  }

  /** 暂停消费：已在途的那条会跑完，后续不再取新消息。 */
  pause() {
    this._paused = true;
    this.logger?.debug('queue paused');
  }

  /** 恢复消费。 */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this.logger?.debug('queue resumed', { depth: this._queue.length });
    this._drain();
  }

  /** 清空队列，返回被清掉的条数。 */
  clear(reason = 'cleared') {
    const n = this._queue.length;
    this._queue = [];
    if (n > 0) this.logger?.warn('queue cleared', { count: n, reason });
    return n;
  }

  /** 等待队列彻底空闲（含正在处理的那条）。 */
  async waitIdle(timeoutMs = 30000) {
    if (!this._running && this._queue.length === 0) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      this._idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  _notifyIdle() {
    if (this._running || this._queue.length > 0) return;
    const waiters = this._idleWaiters;
    this._idleWaiters = [];
    for (const w of waiters) w();
  }

  /** 串行消费主循环。 */
  async _drain() {
    if (this._running) return;      // 已有消费者在跑，保证只有一条在途
    if (this._paused) return;
    if (this._queue.length === 0) {
      this._notifyIdle();
      return;
    }

    this._running = true;
    try {
      while (!this._paused && this._queue.length > 0) {
        const { item, meta } = this._queue.shift();
        try {
          // 顺序 await：这是「串行」的关键
          await this.handler(item, meta);
          this.stats.processed += 1;
        } catch (e) {
          this.stats.failed += 1;
          this.logger?.error('queue handler failed', {
            error: e.message,
            textLen: typeof item?.text === 'string' ? item.text.length : 0,
          });
          // 单条失败不影响后续消息
        }
      }
    } finally {
      this._running = false;
    }
    this._notifyIdle();
  }
}

module.exports = { MessageQueue };
