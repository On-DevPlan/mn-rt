'use strict';

/**
 * RT1 直连对齐引擎 —— 密文信封 → 按键计划 → ACK 的完整状态机。
 *
 * 传输无关：本类不知道 WS / relay / HTTP 的存在。
 *   - 上层把「手机端发来的信封」（JSON 对象）喂给 handleIncoming()；
 *   - 本类发出 'op' 事件（type / backspace / commit），上层经队列注入；
 *   - 注入成功后上层回调 commitApplied()，本类构造 ACK 信封并调用
 *     构造时注入的 sendAck 回调（由传输层决定发到哪、怎么发）。
 *
 * 与 fr 侧 rt_session.dart / rt_crypto.dart 构成 RT1 协议两端，
 * 跨语言契约由两侧向量测试钉死（client/test/vectors/rt1-vectors.json）。
 *
 * 与 relay 模式的差异（直连简化）：
 *   - 无配对握手：没有广播房间要保护，「第一个能通过 GCM tag 校验的信封」
 *     即会话确立——tag 本身就是持钥证明；
 *   - 房间号不再是路由地址，但仍从 key 派生并用作 AAD 上下文标签
 *     （AAD = RT1|<派生room>|<方向>|<seq>，两端一致即可，向量保持不变）。
 *
 * 明文格式（信封解密后）：
 *   快照：{ text: string, ts: number, phoneId: string, enterMode?: string }
 *   事件：{ hotkey: string[], ts, phoneId } | { mouse: object, ts, phoneId }
 *   phoneId 用于 PC → 手机的 ACK 反向路由（经 server.js 转发，明文元数据，不敏感）。
 *   事件（hotkey / mouse）在 seq 去重之前处理：重复应重复生效，且不碰快照状态机。
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const { deriveFromKey, buildAad, seal, open } = require('./rt-crypto');
const { planTransition } = require('./rt-diff');

const DIR_P2C = 'p2c';
const DIR_C2P = 'c2p';

/** 同一批按键计划注入失败后的立即重试上限（超过则挂起等下一条快照） */
const PLAN_RETRIES = 3;

/**
 * 手机端可携带的 enterMode 白名单（随快照明文传输，指示 '\n' 在 PC 侧的注入方式）。
 * 'raw' 不在列——它只是老手机（不带该字段）在 PC 侧的兜底，不是手机端的合法选择。
 */
const ENTER_MODES = new Set(['enter', 'shift_enter']);

/** mouse_move 单轴增量的绝对值上限（手机端合批后的单帧量级远小于此） */
const MOUSE_MOVE_MAX = 2000;
/** mouse_scroll 单轴格数上限 */
const MOUSE_SCROLL_MAX = 30;
/** mouse_button 键名白名单 */
const MOUSE_BUTTONS = new Set(['left', 'right', 'middle']);
/** mouse_button 动作白名单 */
const MOUSE_KINDS = new Set(['click', 'press', 'release']);

/** vpad_* action 白名单（与 rust/input-agent/src/vpad.rs dispatch 对齐） */
const VPAD_ACTIONS = new Set([
  'vpad_init', 'vpad_release', 'vpad_release_all',
  'vpad_button', 'vpad_axis', 'vpad_trigger', 'vpad_dpad',
]);
/** vpad_button 键名白名单（面键/肩键/back/start/l3/r3/guide） */
const VPAD_BUTTONS = new Set(['a', 'b', 'x', 'y', 'lb', 'rb', 'back', 'start', 'l3', 'r3', 'guide']);
/** vpad_axis 轴名白名单 */
const VPAD_AXES = new Set(['lx', 'ly', 'rx', 'ry']);
/** vpad_trigger 扳机名白名单 */
const VPAD_TRIGGERS = new Set(['lt', 'rt']);
/** vpad_dpad 方向白名单（none = 回中；斜向为两个方向位并置，需 v0.7.12+ agent） */
const VPAD_DIRS = new Set(['up', 'down', 'left', 'right', 'up_left', 'up_right', 'down_left', 'down_right', 'none']);

/**
 * 校验并归一化手机端 mouse 载荷（v0.6.0+ 触摸板协议）。
 *
 * 返回归一化后的 op 载荷；非法返回 null（丢弃该信封的 mouse 部分，不影响
 * 同会话后续信封）。这里挡在 rt-align 一层，垃圾数据绝不流向 rust agent：
 *   - {a:'move',   dx, dy}        相对移动（像素）
 *   - {a:'button', button, kind}  按键（left|right|middle × click|press|release）
 *   - {a:'scroll', dx, dy}        滚轮（格，正数 = 向下/向右，与 enigo 一致）
 */
function normalizeMouseOp(m) {
  const int32 = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : 0;
  };
  const clamp = (v, max) => Math.max(-max, Math.min(max, v));

  switch (m.a) {
    case 'move':
      return { a: 'move', dx: clamp(int32(m.dx), MOUSE_MOVE_MAX), dy: clamp(int32(m.dy), MOUSE_MOVE_MAX) };
    case 'button': {
      const button = String(m.button ?? '');
      const kind = String(m.kind ?? '');
      if (!MOUSE_BUTTONS.has(button) || !MOUSE_KINDS.has(kind)) return null;
      return { a: 'button', button, kind };
    }
    case 'scroll':
      return { a: 'scroll', dx: clamp(int32(m.dx), MOUSE_SCROLL_MAX), dy: clamp(int32(m.dy), MOUSE_SCROLL_MAX) };
    default:
      return null;
  }
}

/**
 * 校验并归一化手机端 vpad_* 指令（v0.7.0+ 虚拟手柄协议）。
 *
 * 返回白名单化后的 payload（可直接作为 agent.send 的 body）；非法返回 null。
 * 字段名与语义照搬 rust/input-agent/src/vpad.rs 的 parse_*：
 *   - {action:'vpad_init', vpad_slot:1..4}
 *   - {action:'vpad_release', vpad_handle} / {action:'vpad_release_all'}
 *   - {action:'vpad_button', vpad_handle, vpad_button, vpad_value_bool}
 *   - {action:'vpad_axis',   vpad_handle, vpad_axis, vpad_value:-1..1}
 *   - {action:'vpad_trigger',vpad_handle, vpad_trigger, vpad_value:0..1}
 *   - {action:'vpad_dpad',   vpad_handle, vpad_dir:up|down|left|right|up_left|up_right|down_left|down_right|none}
 * rust 端按 handle 维护「上一次」累积状态，客户端只发变化字段即可。
 */
function normalizeVpadOp(cmd) {
  if (cmd === null || typeof cmd !== 'object') return null;
  const action = String(cmd.action ?? '').toLowerCase();
  if (!VPAD_ACTIONS.has(action)) return null;
  const handle =
    typeof cmd.vpad_handle === 'string' ? cmd.vpad_handle.trim().slice(0, 32) : '';
  const out = { action };
  switch (action) {
    case 'vpad_init': {
      const slot = Math.round(Number(cmd.vpad_slot ?? 1));
      if (!(slot >= 1 && slot <= 4)) return null;
      out.vpad_slot = slot;
      return out;
    }
    case 'vpad_release':
      if (!handle) return null;
      out.vpad_handle = handle;
      return out;
    case 'vpad_release_all':
      return out;
    case 'vpad_button': {
      const button = String(cmd.vpad_button ?? '').trim().toLowerCase();
      if (!VPAD_BUTTONS.has(button) || typeof cmd.vpad_value_bool !== 'boolean') return null;
      if (!handle) return null;
      return { ...out, vpad_handle: handle, vpad_button: button, vpad_value_bool: cmd.vpad_value_bool };
    }
    case 'vpad_axis': {
      const axis = String(cmd.vpad_axis ?? '').trim().toLowerCase();
      const v = Number(cmd.vpad_value);
      if (!VPAD_AXES.has(axis) || !Number.isFinite(v)) return null;
      if (!handle) return null;
      return { ...out, vpad_handle: handle, vpad_axis: axis, vpad_value: Math.max(-1, Math.min(1, v)) };
    }
    case 'vpad_trigger': {
      const trigger = String(cmd.vpad_trigger ?? '').trim().toLowerCase();
      const v = Number(cmd.vpad_value);
      if (!VPAD_TRIGGERS.has(trigger) || !Number.isFinite(v)) return null;
      if (!handle) return null;
      return { ...out, vpad_handle: handle, vpad_trigger: trigger, vpad_value: Math.max(0, Math.min(1, v)) };
    }
    case 'vpad_dpad': {
      const dir = String(cmd.vpad_dir ?? '').trim().toLowerCase();
      if (!VPAD_DIRS.has(dir) || !handle) return null;
      return { ...out, vpad_handle: handle, vpad_dir: dir };
    }
    default:
      return null;
  }
}

/** 判断一段 text 是否形如 RT1 信封（直连模式区分加密/明文流量用）。 */
function looksLikeEnvelope(text) {
  if (typeof text !== 'string') return false;
  try {
    const o = JSON.parse(text);
    return o !== null && typeof o === 'object' &&
      typeof o.sid === 'string' &&
      typeof o.seq === 'number' &&
      typeof o.nonce === 'string' &&
      typeof o.ct === 'string';
  } catch {
    return false;
  }
}

class RtAlignSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.key        配对 key（与手机端一致）
   * @param {object} opts.logger
   * @param {Function} opts.sendAck  (envelope: object) => void
   *                                 ACK 信封外发回调；传输层负责路由到手机
   *                                 （信封明文里有 applied_seq，phoneId 由上层记录）
   */
  constructor(opts) {
    super();
    this.logger = opts.logger;
    this._sendAckTransport = opts.sendAck;

    const derived = deriveFromKey(opts.key);
    this.key = opts.key;           // setKey() 用它判断是否真的要换
    this.room = derived.room; // 仅作 AAD 上下文标签，不再用于路由
    this.keyPhoneToPc = derived.keyPhoneToPc;
    this.keyPcToPhone = derived.keyPcToPhone;

    // 同步状态机
    this.mirror = '';          // 已注入内容模型（commit 后推进）
    this.desiredText = null;   // 最新解密全文
    this.desiredSeq = 0;
    this.lastSyncSid = '';     // 手机端会话号（换会话 = seq 域重置）
    this.phoneId = '';         // 最近一次解密信封里的手机路由标识
    this.enterMode = '';       // 最近一次快照携带的换行方式（'' = 未携带）
    this.busy = false;         // 按键计划已发出、未 commit
    this.busySince = 0;
    this.pendingFails = 0;     // 当前 desired 连续注入失败次数（成功 commit 或新快照归零）
    this.ackSeq = 0;
    this.sid = crypto.randomBytes(4).toString('hex');

    this.stats = {
      envelopesOk: 0, envelopesBad: 0, syncsApplied: 0, acksSent: 0, plaintextRejected: 0,
      mouseEvents: 0, mouseDropped: 0,
      vpadEvents: 0,
    };

    // 看门狗自驱动：commit 事件若因队列溢出等丢失，busy 会卡死（relay-client 时代由
    // 快照拉取定时器顺带驱动，独立成引擎后自备 30s 巡检）
    this._watchdogTimer = setInterval(() => this.busyWatchdog(), 30000);
    this._watchdogTimer.unref?.();
  }

  /**
   * 换一把配对 key（统一登录下服务端会在 registered 帧里下发权威 sessionKey）。
   *
   * 只重推导密钥、不动同步状态：mirror / desiredSeq / busy 描述的是"注入了什么"，
   * 与"用哪把 key 解密"无关；换 key 时把状态清零反而会让已注入内容被重复补打。
   * 与对端 key 不一致的表现为紧接着的 decrypt-error，日志会直说。
   */
  setKey(key) {
    if (!key || key === this.key) return false;
    const derived = deriveFromKey(key);
    this.key = key;
    this.room = derived.room;
    this.keyPhoneToPc = derived.keyPhoneToPc;
    this.keyPcToPhone = derived.keyPcToPhone;
    this.logger?.info('align 会话密钥已切换为服务端下发值');
    return true;
  }

  /** 停止内部定时器（上层优雅退出时调用；unref 下不调也不阻塞进程退出）。 */
  dispose() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // ================= 入向 =================

  /**
   * 喂入手机端发来的一条 text。
   * 返回 'envelope'（已受理）| 'plaintext'（非信封，直连模式拒绝）| 'duplicate'。
   */
  handleIncoming(text) {
    if (!looksLikeEnvelope(text)) {
      this.stats.plaintextRejected += 1;
      this.logger?.warn('align 模式拒绝非信封文本', { len: String(text ?? '').length });
      return 'plaintext';
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      this.stats.envelopesBad += 1;
      return 'duplicate';
    }
    return this._handleEnvelope(envelope);
  }

  _handleEnvelope(envelope) {
    const seq = Number(envelope.seq) || 0;
    const sid = String(envelope.sid ?? '');

    let plain;
    try {
      plain = open(this.keyPhoneToPc, buildAad(this.room, DIR_P2C, seq), envelope);
    } catch (e) {
      this.stats.envelopesBad += 1;
      // 解密失败 = 对端 key 不一致或密文被动过；不崩溃，交给统计与事件
      this.logger?.error('input decrypt failed', { seq, error: e.message });
      this.emit('decrypt-error', { seq });
      return 'duplicate';
    }

    // 快捷键指令（v0.5.4+）：hotkey 是「事件」而非「快照」，在 seq 去重
    // 之前处理——重复点击应该重复生效，且不得碰快照状态机（不更新
    // lastSyncSid / desiredSeq / desiredText，不设 busy、不进 _dispatch）。
    // 协议：hotkey 数组末位是主键、其余是修饰键（['win','r'] = Win+R）。
    if (Array.isArray(plain.hotkey) && plain.hotkey.length > 0) {
      const main = String(plain.hotkey[plain.hotkey.length - 1]);
      const modifiers = plain.hotkey.slice(0, -1).map(String);
      this.phoneId = typeof plain.phoneId === 'string' ? plain.phoneId : '';
      this.stats.envelopesOk += 1;
      this._sendAck(seq); // 直接回「已受理」：无按键计划需要 commit
      this.emit('op', { op: 'hotkey', key: main, modifiers, seq });
      return 'envelope';
    }

    // 鼠标事件（v0.6.0+ 触摸板）：与 hotkey 同属「事件」语义——seq 去重之前
    // 处理、不碰快照状态机。与 hotkey 的差异：
    //   * 高频（移动 30-60Hz），不回 ACK——ACK 流量会翻倍且手机端不依赖
    //     逐笔确认（连接级 e2eConfirmed 由文字/快捷键的 ACK 建立）；
    //   * 载荷先过 normalizeMouseOp 白名单，垃圾数据在这里丢弃，绝不流向
    //     rust agent。
    if (plain.mouse !== null && typeof plain.mouse === 'object') {
      const mouse = normalizeMouseOp(plain.mouse);
      if (mouse === null) {
        this.stats.envelopesBad += 1;
        this.logger?.warn('align 丢弃非法 mouse 载荷', { seq });
        return 'duplicate';
      }
      this.phoneId = typeof plain.phoneId === 'string' ? plain.phoneId : '';
      this.stats.envelopesOk += 1;
      this.stats.mouseEvents += 1;
      this.emit('op', { op: 'mouse', mouse, seq });
      return 'envelope';
    }

    // 虚拟手柄指令（v0.7.0+ vpad_* 通道）：与 mouse 同属「事件」语义——
    // seq 去重之前处理、不碰快照状态机、不回 ACK（按键/扳机/十字键都是
    // 状态型指令，rust 端按 handle 维护累积状态，重放同值无副作用，但
    // 保序由执行器的串行链保证）。载荷先过 normalizeVpadOp 白名单
    // （字段集与 rust vpad.rs parse_* 一致），垃圾数据绝不流向 agent。
    if (plain.vpad !== null && typeof plain.vpad === 'object') {
      const cmd = normalizeVpadOp(plain.vpad);
      if (cmd === null) {
        this.stats.envelopesBad += 1;
        this.logger?.warn('align 丢弃非法 vpad 载荷', { seq });
        return 'duplicate';
      }
      this.phoneId = typeof plain.phoneId === 'string' ? plain.phoneId : '';
      this.stats.envelopesOk += 1;
      this.stats.vpadEvents += 1;
      this.emit('op', { op: 'vpad', cmd, seq });
      return 'envelope';
    }

    // 手机端重启会换 sid 且 seq 归零：新会话无条件接受
    if (sid !== this.lastSyncSid) {
      this.logger?.info('input session detected', { sid, prev: this.lastSyncSid });
      this.lastSyncSid = sid;
      this.desiredSeq = 0;
    } else if (seq <= this.desiredSeq && this.desiredText !== null) {
      return 'duplicate';
    }

    if (typeof plain.text !== 'string') return 'duplicate';

    this.stats.envelopesOk += 1;
    this.phoneId = typeof plain.phoneId === 'string' ? plain.phoneId : '';
    this.enterMode = ENTER_MODES.has(plain.enterMode) ? plain.enterMode : '';
    this.desiredText = plain.text;
    this.desiredSeq = seq;
    this.pendingFails = 0; // 新快照 = 新的尝试机会
    this._dispatch();
    return 'envelope';
  }

  /**
   * 把 mirror → desiredText 的按键计划发出去。
   * busy 期间只更新 desiredText，commit 后自动续跑（全文快照语义下永远收敛）。
   */
  _dispatch() {
    if (this.busy || this.desiredText === null) return;
    const plan = planTransition(this.mirror, this.desiredText);
    if (plan.backspaces === 0 && plan.insert === '') {
      // 目标已达成（重复快照），仍需补 ACK 推进手机端确认
      this._sendAck(this.desiredSeq);
      return;
    }
    this.busy = true;
    this.busySince = Date.now();
    const seq = this.desiredSeq;
    const text = this.desiredText;
    this.stats.syncsApplied += 1;
    if (plan.backspaces > 0) {
      this.emit('op', { op: 'backspace', count: plan.backspaces, seq });
    }
    if (plan.insert !== '') {
      // enterMode 随最新快照切换：busy 期间来了新快照，commit 后的续跑用新模式
      const op = { op: 'type', text: plan.insert, seq };
      if (this.enterMode) op.enterMode = this.enterMode;
      this.emit('op', op);
    }
    // commit 是「本批计划完成」的界碑：上层在注入成功后回调 commitApplied
    this.emit('op', { op: 'commit', seq, text });
  }

  // ================= 出向 / 推进 =================

  /**
   * 上层确认某批按键已成功注入。推进 mirror、发 ACK、续跑剩余 desired。
   *
   * 发送模式（enter）下快照以 '\n' 结尾 = 手机端「发送」：目标 IM 发出消息后
   * 输入框清空，mirror 必须归零与手机端的清空对齐——否则下一条会先回删整条
   * 已发送内容。归零时若没有更新的快照在途，同时清 desiredText：否则
   * 「mirror 归零 vs desired 仍是刚发文本」会触发重打，造成重复发送。
   */
  commitApplied(seq, text) {
    if (!this.busy) return;
    this.mirror = text;
    if (this.enterMode === 'enter' && typeof text === 'string' && text.endsWith('\n')) {
      this.mirror = '';
      if (this.desiredText === text) this.desiredText = null;
    }
    this.busy = false;
    this.busySince = 0;
    this.pendingFails = 0;
    this._sendAck(seq);
    if (this.desiredText !== null && this.desiredText !== this.mirror) this._dispatch();
  }

  /**
   * 上层报告本批按键注入失败（如 rust agent 拒绝 backspace）。
   * mirror 必须保持不动——它代表屏幕真实状态，假推进会造成永久错位。
   * 立即重试至多 PLAN_RETRIES 次（agent 可能只是瞬时故障），超过后挂起，
   * 等下一条快照到来时按真实 mirror 重新 diff 自愈。
   */
  commitFailed(seq) {
    if (!this.busy) return;
    this.busy = false;
    this.busySince = 0;
    this.pendingFails += 1;
    if (this.pendingFails <= PLAN_RETRIES) {
      this.logger?.warn('按键计划注入失败，重试', { seq, attempt: this.pendingFails });
      this._dispatch();
      return;
    }
    this.logger?.error('按键计划连续注入失败，挂起等待下一条快照', {
      seq,
      attempts: this.pendingFails,
    });
    this.emit('plan-stalled', { seq, attempts: this.pendingFails });
  }

  _sendAck(appliedSeq) {
    if (typeof this._sendAckTransport !== 'function') return;
    this.ackSeq += 1;
    const envelope = seal(
      this.keyPcToPhone,
      buildAad(this.room, DIR_C2P, this.ackSeq),
      { applied_seq: appliedSeq, ts: Date.now() },
      { sid: this.sid, seq: this.ackSeq },
    );
    try {
      this._sendAckTransport(envelope);
      this.stats.acksSent += 1;
      this.emit('ack-sent', { appliedSeq });
    } catch (e) {
      this.logger?.warn('ack send failed', { appliedSeq, error: e.message });
    }
  }

  /**
   * busy 看门狗：commit 事件若因队列溢出等原因丢失，busy 会永久卡住。
   * 超过 2 分钟未 commit 就强制复位，按 mirror → 最新 desired 重新 diff（自愈）。
   */
  busyWatchdog() {
    if (!this.busy || !this.busySince) return;
    if (Date.now() - this.busySince < 120000) return;
    this.logger?.warn('busy watchdog fired, resetting pending ops', {
      seq: this.desiredSeq,
      stuckMs: Date.now() - this.busySince,
    });
    this.busy = false;
    this.busySince = 0;
    this._dispatch();
  }
}

module.exports = { RtAlignSession, looksLikeEnvelope, normalizeMouseOp, normalizeVpadOp };
