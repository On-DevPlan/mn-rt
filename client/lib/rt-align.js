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
 * 明文格式（信封解密后）：{ text: string, ts: number, phoneId: string }
 *   phoneId 用于 PC → 手机的 ACK 反向路由（经 server.js 转发，明文元数据，不敏感）。
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const { deriveFromKey, buildAad, seal, open } = require('./rt-crypto');
const { planTransition } = require('./rt-diff');

const DIR_P2C = 'p2c';
const DIR_C2P = 'c2p';

/** 同一批按键计划注入失败后的立即重试上限（超过则挂起等下一条快照） */
const PLAN_RETRIES = 3;

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
    this.room = derived.room; // 仅作 AAD 上下文标签，不再用于路由
    this.keyPhoneToPc = derived.keyPhoneToPc;
    this.keyPcToPhone = derived.keyPcToPhone;

    // 同步状态机
    this.mirror = '';          // 已注入内容模型（commit 后推进）
    this.desiredText = null;   // 最新解密全文
    this.desiredSeq = 0;
    this.lastSyncSid = '';     // 手机端会话号（换会话 = seq 域重置）
    this.phoneId = '';         // 最近一次解密信封里的手机路由标识
    this.busy = false;         // 按键计划已发出、未 commit
    this.busySince = 0;
    this.pendingFails = 0;     // 当前 desired 连续注入失败次数（成功 commit 或新快照归零）
    this.ackSeq = 0;
    this.sid = crypto.randomBytes(4).toString('hex');

    this.stats = {
      envelopesOk: 0, envelopesBad: 0, syncsApplied: 0, acksSent: 0, plaintextRejected: 0,
    };

    // 看门狗自驱动：commit 事件若因队列溢出等丢失，busy 会卡死（relay-client 时代由
    // 快照拉取定时器顺带驱动，独立成引擎后自备 30s 巡检）
    this._watchdogTimer = setInterval(() => this.busyWatchdog(), 30000);
    this._watchdogTimer.unref?.();
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
    // 手机端重启会换 sid 且 seq 归零：新会话无条件接受
    if (sid !== this.lastSyncSid) {
      this.logger?.info('input session detected', { sid, prev: this.lastSyncSid });
      this.lastSyncSid = sid;
      this.desiredSeq = 0;
    } else if (seq <= this.desiredSeq && this.desiredText !== null) {
      return 'duplicate';
    }

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
    if (typeof plain.text !== 'string') return 'duplicate';

    this.stats.envelopesOk += 1;
    this.phoneId = typeof plain.phoneId === 'string' ? plain.phoneId : '';
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
      this.emit('op', { op: 'type', text: plan.insert, seq });
    }
    // commit 是「本批计划完成」的界碑：上层在注入成功后回调 commitApplied
    this.emit('op', { op: 'commit', seq, text });
  }

  // ================= 出向 / 推进 =================

  /** 上层确认某批按键已成功注入。推进 mirror、发 ACK、续跑剩余 desired。 */
  commitApplied(seq, text) {
    if (!this.busy) return;
    this.mirror = text;
    this.busy = false;
    this.busySince = 0;
    this.pendingFails = 0;
    this._sendAck(seq);
    if (this.desiredText !== this.mirror) this._dispatch();
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

module.exports = { RtAlignSession, looksLikeEnvelope };
