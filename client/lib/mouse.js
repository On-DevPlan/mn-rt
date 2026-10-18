'use strict';

/**
 * 鼠标指令泵 —— 高频鼠标事件到 rust agent 的专用通道（v0.6.0+ 触摸板）。
 *
 * 为什么不走 MessageQueue：
 *   * 队列是严格串行 await 的——每条指令等 agent 应答才发下一条。文本注入
 *     一片 25ms+、组合键 60ms+，鼠标移动排在其后会拖出肉眼可见的卡顿；
 *   * 移动指令天然可丢可合并：网络抖动把 3 帧增量同时送到时，合并成 1 条
 *     发给 agent 效果完全等价（相对位移可加），还能给 agent 减负。
 *
 * 时序保证：
 *   * 按键 / 滚轮派发前先冲刷挂起的移动增量——先到位后点击的顺序不能乱；
 *   * 所有 agent.send() 按调用顺序写 stdin，管道 FIFO 保证了 PC 侧执行顺序。
 *
 * agent.send() 不 await（fire-and-forget）：agent 对鼠标指令零延时立即应答，
 * pending 队列会在下一拍排空；失败仅记日志，触摸板语义下重试毫无意义。
 */

class MousePump {
  /**
   * @param {object} opts
   * @param {Function} opts.send            (payload: object) => Promise；调用方负责接住 rejection
   * @param {object} [opts.logger]
   * @param {number} [opts.flushIntervalMs] 移动增量合批窗口，默认 8ms（≈120Hz 上限）
   */
  constructor(opts) {
    this._send = opts.send;
    this._logger = opts.logger;
    this._flushIntervalMs = opts.flushIntervalMs ?? 8;
    this._dx = 0;
    this._dy = 0;
    this._flushTimer = null;
    this.stats = { movesSent: 0, buttonsSent: 0, scrollsSent: 0, failed: 0 };
  }

  /**
   * 派发一条已归一化的鼠标 op（rt-align normalizeMouseOp 的产物）。
   * move 走合批；button / scroll 立即派发（先冲刷移动，保住先后顺序）。
   */
  dispatch(mouse) {
    switch (mouse.a) {
      case 'move':
        this._dx += mouse.dx;
        this._dy += mouse.dy;
        this._scheduleFlush();
        break;
      case 'button':
        this._flushMoves();
        this._dispatchNow({ action: 'mouse_button', button: mouse.button, kind: mouse.kind });
        this.stats.buttonsSent += 1;
        break;
      case 'scroll':
        this._flushMoves();
        if (mouse.dx !== 0 || mouse.dy !== 0) {
          this._dispatchNow({ action: 'mouse_scroll', dx: mouse.dx, dy: mouse.dy });
          this.stats.scrollsSent += 1;
        }
        break;
      default:
        break;
    }
  }

  /** 停止泵：冲刷挂起增量并清掉定时器（上层退出时调用；幂等）。 */
  stop() {
    this._flushMoves();
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushMoves();
    }, this._flushIntervalMs);
    this._flushTimer.unref?.();
  }

  /** 把挂起的移动增量合并成一条指令发出（有增量才发）。 */
  _flushMoves() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    const dx = this._dx;
    const dy = this._dy;
    if (dx === 0 && dy === 0) return;
    this._dx = 0;
    this._dy = 0;
    this._dispatchNow({ action: 'mouse_move', dx, dy });
    this.stats.movesSent += 1;
  }

  _dispatchNow(payload) {
    Promise.resolve(this._send(payload)).catch((e) => {
      this.stats.failed += 1;
      this._logger?.debug('mouse dispatch failed', { action: payload.action, error: e.message });
    });
  }
}

module.exports = { MousePump };
