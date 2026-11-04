'use strict';

/**
 * 虚拟手柄指令泵 —— vpad_* 指令到 rust agent 的专用串行链（v0.7.0+）。
 *
 * 为什么专用串行链（不走 MessageQueue / 不走 MousePump）：
 *   * 按键 press/release 必须保序且不丢（丢 release = 手柄键卡死）；
 *   * 当前控制面（按钮/扳机/十字键）都是低频状态型指令，串行链足够；
 *   * 与文本注入的共享队列分离，互不拖延迟（轴流合批接入时再评估）。
 *
 * unknown-handle 自愈（v0.9.4）：
 *   rust 端 agent 重启、手机端任一页面实例退出时 release 掉 pad1、手机端
 *   bootstrap 链失效——任何一种都会让手机后续指令撞 "unknown handle: pad1"，
 *   此前表现为手柄整体失灵，直到用户重进画布 / 重连才恢复（records.jsonl
 *   里成串的 vpad_failed 即此）。本泵在链内检测该错误，自动 release_all +
 *   init 重建句柄并重放原指令一次；自愈失败按原失败上报。init/release/
 *   release_all 自身的 unknown-handle 不触发自愈（释放路径没有可重建的
 *   东西，自愈反而会凭空造出一个手柄）。
 *
 * 句柄学习：引擎记住 init 应答里的真实句柄名，后续命令一律重写到它；
 * release 成功后清空，下次 init 重新学。rust 端 next_index 单调自增，
 * fr 端把句柄写死 pad1（rt_page.dart 的 _vpadHandle，依赖「release_all →
 * init 必得 pad1」契约）——学习只为兜住 drift，不改变协议语义。
 */

class VpadPump {
  /**
   * @param {object} opts
   * @param {Function} opts.send            (payload) => Promise<{ok, msg, handle,...}>；rejection 由本泵接住记日志
   * @param {object} [opts.logger]
   * @param {Function} [opts.record]        (entry) => void，结果落盘（LocalStore.append 的形状）
   * @param {number} [opts.slot=1]          自愈重建句柄用的 slot（1..=4）
   */
  constructor(opts) {
    this._send = opts.send;
    this._logger = opts.logger;
    this._record = opts.record ?? (() => {});
    this._slot = opts.slot ?? 1;
    // init 应答里学到的真实句柄名；null = 未学（命令按手机端写的原样透传）。
    this._handle = null;
    this._chain = Promise.resolve();
    this.stats = { sent: 0, failed: 0, healed: 0 };
  }

  /** agent/引擎重启后可显式清掉句柄学习（不清也安全：自愈兜底）。 */
  resetHandle() {
    this._handle = null;
  }

  /**
   * 派发一条已归一化的 vpad 指令（rt-align normalizeVpadOp 的产物）。
   * 串行入链、同步返回（不等执行）——与 MousePump.dispatch 调用约定一致。
   */
  dispatch(cmd, seq) {
    this._chain = this._chain.then(() => this._exec(cmd, seq));
  }

  /** 等待链上已入队的指令全部执行完（测试 / 优雅关闭用）。 */
  idle() {
    return this._chain;
  }

  async _exec(cmd, seq) {
    try {
      const payload = this._handle && cmd.vpad_handle
        ? { ...cmd, vpad_handle: this._handle }
        : cmd;
      let res = await this._send(payload);
      // unknown-handle 自愈：仅状态型指令；init/release/release_all 不触发。
      if (
        res && res.ok !== true && SELF_HEAL_ACTIONS.has(cmd.action) &&
        /unknown handle/i.test(String(res.msg ?? ''))
      ) {
        this.stats.healed += 1;
        this._logger?.warn('vpad 句柄失效，自动重建（release_all + init）', {
          action: cmd.action, seq,
        });
        const initRes = await this._heal();
        if (initRes && initRes.ok) {
          res = await this._send({ ...payload, vpad_handle: this._handle });
        }
      }
      if (res?.ok) {
        if (cmd.action === 'vpad_init' && res.handle) this._handle = res.handle;
        if (cmd.action === 'vpad_release' || cmd.action === 'vpad_release_all') {
          this._handle = null;
        }
        // init / release 是一次性节点走 info（「手柄已插上/拔下」一眼可见）；
        // 按键/轴/扳机高频走 debug，避免游戏时刷屏。
        const log = (cmd.action === 'vpad_init' || cmd.action === 'vpad_release')
          ? 'info' : 'debug';
        this._logger?.[log]('vpad 指令成功', { action: cmd.action, msg: res?.msg, seq });
        this._record({ status: 'vpad_sent', action: cmd.action, source: 'align', seq });
        this.stats.sent += 1;
      } else {
        this._logger?.warn('vpad 指令失败', { action: cmd.action, msg: res?.msg, seq });
        this._record({
          status: 'vpad_failed', action: cmd.action,
          errorMsg: res?.msg ?? 'unknown', source: 'align', seq,
        });
        this.stats.failed += 1;
      }
    } catch (e) {
      this._logger?.warn('vpad 指令异常', { action: cmd.action, error: e.message, seq });
      this._record({
        status: 'vpad_failed', action: cmd.action,
        errorMsg: e.message, source: 'align', seq,
      });
      this.stats.failed += 1;
    }
  }

  /** 自愈：release_all 清残留 → init 重建 → 学句柄。返回 init 应答。 */
  async _heal() {
    const rel = await this._send({ action: 'vpad_release_all' });
    if (rel && rel.ok) this._handle = null;
    const initRes = await this._send({ action: 'vpad_init', vpad_slot: this._slot });
    if (initRes && initRes.ok && initRes.handle) this._handle = initRes.handle;
    return initRes;
  }
}

/** 触发 unknown-handle 自愈的指令集（状态型；生命周期指令不触发）。 */
const SELF_HEAL_ACTIONS = new Set(['vpad_button', 'vpad_axis', 'vpad_trigger', 'vpad_dpad']);

module.exports = { VpadPump };
