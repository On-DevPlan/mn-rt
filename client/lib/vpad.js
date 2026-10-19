'use strict';

/**
 * vpad_* 协议 SDK —— 把 9 个 vpad_* 指令封装成面向业务的类方法。
 *
 * 设计要点：
 *   * input-agent 端已经在 lazy-init / 多 handle 共享 Rc<Client> / 单次 install
 *     防护上把低层逻辑做完了，本 SDK 只是 wrapping（业务层不该直接摸
 *     `agent.send({action:'vpad_*', ...})`）。
 *   * 高频 axis / trigger（Xbox 摇杆 60Hz+ 流）走 `*Now` 方法—— fire-and-
 *     forget，与 mouse.js 的 MousePump 同一套哲学；失败的 axis 丢一帧
 *     没人感知，Promise 链回溯反而徒增。
 *   * 低频 button / release / init 走 `async` 方法，await 业务要看见错。
 *   * 句柄缓存：rust 端发 `pad1` `pad2` 这种「服务器命名」；客户端可选
 *     提供用户友好的 label（`p1` `gamepad` 都行），Map 双向索引。
 *   * 自动初始化：业务首次操作未先 init 时，按 defaultSlot 自动分配一
 *     个手柄并缓存，避免每个调用方都得 `await init()`。
 *
 * 平台：仅 Windows 有真实驱动（ViGEmBus）；macOS / Linux 上所有方法
 * 走通到 rust，但 rust 端返 `vpad requires Windows`——按本 SDK 的 `ok`
 * 字段透传，调用方视作失败。
 */

class VPadClient {
  /**
   * @param {object} opts
   * @param {Function} opts.send         agent.send-like：(payload) => Promise<{ok, msg, ...}>
   * @param {object} [opts.logger]
   * @param {number} [opts.defaultSlot=1] 默认 slot（1..=4），auto-init 与未指定 slot 的 init 都用这个
   * @param {boolean} [opts.autoInit=true]首次 button/axis/dpad/trigger 时若 state 空则自动 init
   */
  constructor(opts) {
    if (!opts || typeof opts.send !== 'function') {
      throw new TypeError('VPadClient requires opts.send (function)');
    }
    this._send = opts.send;
    this._logger = opts.logger;
    this._defaultSlot = opts.defaultSlot ?? 1;
    if (!(this._defaultSlot >= 1 && this._defaultSlot <= 4)) {
      throw new RangeError('defaultSlot must be in 1..=4');
    }
    this._autoInit = opts.autoInit !== false;

    // handle 字符串（rust 端给的 pad1/pad2/...）→ 元数据
    this._handles = new Map();
    // 用户友好 label → handle
    this._labels = new Map();
    // 已分配下一个 auto-init handle 时的默认 label
    this._autoLabelIdx = 0;

    this.stats = {
      inits: 0,
      releases: 0,
      buttons: 0,
      axes: 0,
      triggers: 0,
      dpad: 0,
      listQueries: 0,
      statusQueries: 0,
      failed: 0,
    };
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 分配一个虚拟手柄。
   * @param {object} [opts]
   * @param {number} [opts.slot]         1..=4；缺省用 constructor 的 defaultSlot
   * @param {string} [opts.label]        可选用户友好标识（同标签再调 init 返同一 handle）
   * @returns {Promise<{handle:string, slot:number, label:?string, alreadyExisting?:boolean}>}
   */
  async init({ slot, label = null } = {}) {
    const useSlot = slot ?? this._defaultSlot;
    if (label && this._labels.has(label)) {
      const handle = this._labels.get(label);
      return { handle, slot: useSlot, label, alreadyExisting: true };
    }
    const res = await this._send({ action: 'vpad_init', vpad_slot: useSlot });
    if (!res.ok) {
      this._bumpFailed();
      throw new Error(res.msg);
    }
    this._handles.set(res.handle, { slot: res.slot });
    if (label) this._labels.set(label, res.handle);
    this.stats.inits += 1;
    return { handle: res.handle, slot: res.slot, label };
  }

  /**
   * 释放单个手柄。
   * @param {string} handleOrLabel
   */
  async release(handleOrLabel) {
    const h = this._resolveHandle(handleOrLabel);
    if (!h) {
      this._bumpFailed();
      throw new Error(`unknown handle or label: ${handleOrLabel}`);
    }
    const res = await this._send({ action: 'vpad_release', vpad_handle: h });
    if (!res.ok) {
      this._bumpFailed();
      throw new Error(res.msg);
    }
    this._dropHandle(h);
    this.stats.releases += 1;
    return res;
  }

  /**
   * 释放所有该客户端管理的手柄。rust 端 release_all 是 no-op（无 state）也不报错。
   */
  async releaseAll() {
    const res = await this._send({ action: 'vpad_release_all' });
    if (!res.ok) {
      this._bumpFailed();
      throw new Error(res.msg);
    }
    this._handles.clear();
    this._labels.clear();
    this.stats.releases += 1;
    return res;
  }

  /**
   * 优雅关闭（推荐在进程退出 / 取消 stream 时调用）。
   * 与 releaseAll 区别：失败不会抛，仅记日志。
   */
  async dispose() {
    if (this._handles.size === 0) return;
    try {
      await this.releaseAll();
    } catch (err) {
      this._logger?.warn('vpad.dispose releaseAll failed', { error: err.message });
    }
  }

  // ============================================================
  // 输入动作——可以 await 也可走 *Now 高频路径
  // ============================================================

  /**
   * 按下 / 释放一个按钮。低频但需要确认结果——走 await。
   * @param {string} handleOrLabel
   * @param {string} button         a / b / x / y / lb / rb / back / start / l3 / r3 / guide
   * @param {boolean} value
   */
  async button(handleOrLabel, button, value) {
    const h = await this._ensureHandle(handleOrLabel);
    const res = await this._send({
      action: 'vpad_button',
      vpad_handle: h,
      vpad_button: button,
      vpad_value_bool: Boolean(value),
    });
    if (!res.ok) {
      this._bumpFailed();
      throw new Error(res.msg);
    }
    this.stats.buttons += 1;
    return res;
  }

  /** 走 fire-and-forget：摇杆 / 扳机高频流。失败仅记日志。 */
  buttonNow(handleOrLabel, button, value) {
    this._ensureHandleAsync(handleOrLabel, (h) => {
      this._fireNow(
        'button',
        { action: 'vpad_button', vpad_handle: h, vpad_button: button, vpad_value_bool: Boolean(value) },
        'buttons',
      );
    });
  }

  /**
   * 设置摇杆轴值。value ∈ [-1, 1]。
   */
  async axis(handleOrLabel, axis, value) {
    const h = await this._ensureHandle(handleOrLabel);
    const res = await this._send({
      action: 'vpad_axis',
      vpad_handle: h,
      vpad_axis: axis,
      value,
    });
    if (!res.ok) {
      this._bumpFailed();
      throw new Error(res.msg);
    }
    this.stats.axes += 1;
    return res;
  }

  axisNow(handleOrLabel, axis, value) {
    this._ensureHandleAsync(handleOrLabel, (h) => {
      this._fireNow(
        'axis',
        { action: 'vpad_axis', vpad_handle: h, vpad_axis: axis, value },
        'axes',
      );
    });
  }

  /**
   * 设置扳机值。value ∈ [0, 1]。
   */
  async trigger(handleOrLabel, trigger, value) {
    const h = await this._ensureHandle(handleOrLabel);
    const res = await this._send({
      action: 'vpad_trigger',
      vpad_handle: h,
      vpad_trigger: trigger,
      value,
    });
    if (!res.ok) {
      this._bumpFailed();
      throw new Error(res.msg);
    }
    this.stats.triggers += 1;
    return res;
  }

  triggerNow(handleOrLabel, trigger, value) {
    this._ensureHandleAsync(handleOrLabel, (h) => {
      this._fireNow(
        'trigger',
        { action: 'vpad_trigger', vpad_handle: h, vpad_trigger: trigger, value },
        'triggers',
      );
    });
  }

  /**
   * 设置方向键方向。`up`/`down`/`left`/`right`/`none`。
   */
  async dpad(handleOrLabel, dir) {
    const h = await this._ensureHandle(handleOrLabel);
    const res = await this._send({
      action: 'vpad_dpad',
      vpad_handle: h,
      vpad_dir: dir,
    });
    if (!res.ok) {
      this._bumpFailed();
      throw new Error(res.msg);
    }
    this.stats.dpad += 1;
    return res;
  }

  dpadNow(handleOrLabel, dir) {
    this._ensureHandleAsync(handleOrLabel, (h) => {
      this._fireNow(
        'dpad',
        { action: 'vpad_dpad', vpad_handle: h, vpad_dir: dir },
        'dpad',
      );
    });
  }

  // ============================================================
  // 查询
  // ============================================================

  /** 返回 `{ok, driver, bus, slots_used, platform, handles, count, ...}` 透传。 */
  async status() {
    const res = await this._send({ action: 'vpad_status' });
    if (!res.ok) this._bumpFailed();
    else this.stats.statusQueries += 1;
    return res;
  }

  /** 返回 `{ok, handles:[...], count}`。 */
  async list() {
    const res = await this._send({ action: 'vpad_list' });
    if (!res.ok) this._bumpFailed();
    else this.stats.listQueries += 1;
    return res;
  }

  // ============================================================
  // 内部
  // ============================================================

  /** 解析 handle 字符串：先看精确匹配 handle，再看 label 映射。 */
  _resolveHandle(target) {
    if (typeof target !== 'string') return null;
    if (this._handles.has(target)) return target;
    return this._labels.get(target) ?? null;
  }

  /** 删除 handle 之后所有镜像它的 label 一起删。 */
  _dropHandle(handle) {
    this._handles.delete(handle);
    for (const [l, h] of this._labels) {
      if (h === handle) this._labels.delete(l);
    }
  }

  /** auto-init 同步版：抛错。async 操作前调用，没 handle 就申请一个。 */
  async _ensureHandle(handleOrLabel) {
    let h = this._resolveHandle(handleOrLabel);
    if (h) return h;
    if (!this._autoInit) {
      throw new Error(
        `no active vpad handle for ${JSON.stringify(handleOrLabel)}; ` +
        'call vpad.init() first or pass autoInit:true'
      );
    }
    const { handle } = await this.init({ label: handleOrLabel ?? this._nextAutoLabel() });
    return handle;
  }

  /** auto-init 异步版：触发 init 后再调 onReady；init 失败则 swallow + warn。 */
  _ensureHandleAsync(handleOrLabel, onReady) {
    let h = this._resolveHandle(handleOrLabel);
    if (h) {
      onReady(h);
      return;
    }
    if (!this._autoInit) return;
    this.init({ label: handleOrLabel ?? this._nextAutoLabel() })
      .then(({ handle }) => onReady(handle))
      .catch((err) => {
        this._bumpFailed();
        this._logger?.warn('vpad auto-init failed', { error: err.message });
      });
  }

  _nextAutoLabel() {
    // 业务未指定 label 时，生成可猜测的名字让 `_resolveHandle` 之后能找回
    this._autoLabelIdx += 1;
    return `auto${this._autoLabelIdx}`;
  }

  /**
   * fire-and-forget 派发：send resolve 一个 `{ok:false}` 或 reject 都算失败。
   * **注意** agent.send 是 resolve-风格——`{ok:false}` 不会走 catch，
   * 必须显式检查 res.ok，否则失败永远不计入 stats。
   * send 是**同步调用**的（与 mouse.js 的 _dispatchNow 一致）：调用方能
   * 预期「buttonNow 返回时指令已写入 stdin 缓冲」，不引入 microtask 延迟。
   */
  _fireNow(actionLabel, payload, statsKey) {
    Promise.resolve(this._send(payload))
      .then((res) => {
        if (!res || res.ok !== true) {
          this._bumpFailed();
          this._logger?.debug(`${actionLabel}Now failed`, {
            action: payload.action,
            error: res?.msg ?? 'not ok',
          });
          return;
        }
        this.stats[statsKey] += 1;
      })
      .catch((err) => {
        this._bumpFailed();
        this._logger?.debug(`${actionLabel}Now failed`, {
          action: payload.action,
          error: err.message,
        });
      });
  }

  _bumpFailed() {
    this.stats.failed += 1;
  }
}

module.exports = { VPadClient };
