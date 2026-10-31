'use strict';

/**
 * RT1 图片传输的接收端重组器（v0.8.0+ 文件模块·实时拍照）。
 *
 * 协议（RT1 信封解密后的 img 明文，元数据控制层 + 数据层分离）：
 *   begin : {op:'begin', id, n, size, mime}     元数据一次到位，接收端据此一次性预分配
 *   chunk : {op:'chunk', id, i, d}              纯数据块（d = base64 原始字节切片），无元数据开销
 *   end   : {op:'end', id}                      关闭传输；到齐则交剪贴板，未到齐则保留缓冲等续传
 *   abort : {op:'abort', id}                    用户取消，立刻释放缓冲
 *
 * 续传：客户端对每条 chunk 信封独立 ACK；重试时手机端重发 begin(同 id) +
 * 未 ACK 的块 + end，接收端同 id 同元数据则保留已有缓冲——只补缺口。
 * 不完整传输按时间（RETENTION）与数量（MAX_PARTIALS，LRU）双向约束。
 *
 * 事件语义（与 hotkey/mouse 同类）：在 seq 去重之前处理，不碰文本快照
 * 状态机；重复送达的 chunk 是幂等覆写，天然安全。
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

/** 单块原始字节数（手机端分片必须与此严格一致）。信封帧约 64KB，穿过服务端默认 100KB maxPayload。 */
const RT_IMAGE_CHUNK_SIZE = 48 * 1024;
/** 单张图片字节上限（10MB 需求 + 余量；rust 侧剪贴板防御同为 12MB）。 */
const RT_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
/** 单张图片最大块数。 */
const RT_IMAGE_MAX_CHUNKS = Math.ceil(RT_IMAGE_MAX_BYTES / RT_IMAGE_CHUNK_SIZE);
/** 不完整传输的保留时长：超时未续传即 GC。 */
const RT_IMAGE_RETENTION_MS = 10 * 60 * 1000;
/** 同时保留的不完整传输数上限（LRU 淘汰最旧的）。 */
const RT_IMAGE_MAX_PARTIALS = 4;

/** 图片 id 白名单：8 位 hex。 */
function isValidImageId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}$/.test(id);
}

/** 允许的载荷类型（v0.8.0 图片 / v0.9.0 文件上传共用一条 img 通道）。
 * v0.9.2 起接受 image/png：手机图库截图是 PNG（拍摄才是 JPEG）。
 * 注意这只是路由分流声明——引擎解码按字节魔数嗅探真实格式，
 * 声明与实际不符（如 PNG 字节按 jpeg 发来）也能正确落剪贴板。 */
const RT_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'application/octet-stream']);
/** begin.name（文件名）长度上限。 */
const RT_IMAGE_NAME_MAX = 200;

/**
 * 清洗 begin.name：去路径分隔符与控制字符、限长。Windows 落盘命名由
 * Node 侧再做去重，这里只保证「是一个安全的单段文件名」。
 */
function sanitizeFileName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned.length > RT_IMAGE_NAME_MAX ? cleaned.slice(0, RT_IMAGE_NAME_MAX) : cleaned;
}

/**
 * 校验并归一化手机端 img 载荷。非法返回 null（丢弃该信封的 img 部分，
 * 不影响同会话后续信封）——垃圾数据在这里挡住，绝不流向下游。
 */
function normalizeImageOp(img) {
  if (img === null || typeof img !== 'object') return null;
  const op = String(img.op ?? '');
  if (!isValidImageId(img.id)) return null;
  switch (op) {
    case 'begin': {
      const n = Math.floor(Number(img.n));
      const size = Math.floor(Number(img.size));
      const mime = String(img.mime ?? 'image/jpeg');
      if (!Number.isFinite(n) || n < 1 || n > RT_IMAGE_MAX_CHUNKS) return null;
      if (!Number.isFinite(size) || size < 1 || size > RT_IMAGE_MAX_BYTES) return null;
      // 最后一块必须落在 (0, CHUNK] 区间，否则 n/size 自相矛盾
      if (size - (n - 1) * RT_IMAGE_CHUNK_SIZE <= 0) return null;
      if (!RT_IMAGE_MIMES.has(mime)) return null;
      const name = img.name === undefined ? null : sanitizeFileName(img.name);
      if (img.name !== undefined && name === null) return null;
      return { op, id: img.id, n, size, mime, name };
    }
    case 'chunk': {
      const i = Math.floor(Number(img.i));
      if (!Number.isInteger(i) || i < 0 || i >= RT_IMAGE_MAX_CHUNKS) return null;
      if (typeof img.d !== 'string' || img.d.length === 0) return null;
      // base64 长度粗检：解码后不得超过单块上限（精确长度在重组时按 offset 校验）
      if (img.d.length > Math.ceil(RT_IMAGE_CHUNK_SIZE / 3) * 4 + 8) return null;
      return { op, id: img.id, i, d: img.d };
    }
    case 'end':
      return { op, id: img.id };
    case 'abort':
      return { op, id: img.id };
    default:
      return null;
  }
}

/**
 * 图片重组状态机。传输无关：只认归一化 op，不知道 WS / RT1 的存在。
 *
 * 事件：
 *   'image-complete' ({ id, bytes })  end 且到齐
 *   'image-gc'        ({ id, reason })
 */
class RtImageRx extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.logger = opts.logger;
    // id -> { id, n, size, buf, have:Uint8Array(n), got, lastTouchAt }
    this.transfers = new Map();
    this.stats = { begins: 0, chunks: 0, done: 0, incomplete: 0, aborted: 0, gc: 0, rejected: 0 };
  }

  /** begin：新建或续传。返回 {ok, resumed}。 */
  begin(meta) {
    const existing = this.transfers.get(meta.id);
    if (existing) {
      if (existing.n === meta.n && existing.size === meta.size) {
        // 续传：保留缓冲，只刷新保活
        existing.lastTouchAt = Date.now();
        this.logger?.debug('image transfer resume', {
          id: meta.id, got: existing.got, total: meta.n,
        });
        return { ok: true, resumed: true, got: existing.got };
      }
      // 同 id 不同元数据：视为新一轮，丢弃旧缓冲重来
      this._drop(meta.id, 'begin-mismatch');
    }
    if (this.transfers.size >= RT_IMAGE_MAX_PARTIALS) {
      // LRU：淘汰最久未活跃的半成品
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, t] of this.transfers) {
        if (t.lastTouchAt < oldestAt) { oldestAt = t.lastTouchAt; oldestKey = key; }
      }
      if (oldestKey !== null) this._drop(oldestKey, 'lru-evict');
    }
    this.transfers.set(meta.id, {
      id: meta.id,
      n: meta.n,
      size: meta.size,
      mime: meta.mime,
      name: meta.name ?? null,
      buf: Buffer.alloc(meta.size),
      have: new Uint8Array(meta.n),
      got: 0,
      lastTouchAt: Date.now(),
    });
    this.stats.begins += 1;
    return { ok: true, resumed: false, got: 0 };
  }

  /** chunk：按 offset 直填预分配缓冲。返回 {ok, done?}。 */
  chunk(op) {
    const t = this.transfers.get(op.id);
    if (!t) {
      this.stats.rejected += 1;
      this.logger?.warn('chunk for unknown transfer（会话中断过的旧块？）', { id: op.id, i: op.i });
      return { ok: false };
    }
    if (op.i >= t.n) {
      this.stats.rejected += 1;
      return { ok: false };
    }
    const data = Buffer.from(op.d, 'base64');
    const offset = op.i * RT_IMAGE_CHUNK_SIZE;
    const isLast = op.i === t.n - 1;
    const expected = isLast ? t.size - (t.n - 1) * RT_IMAGE_CHUNK_SIZE : RT_IMAGE_CHUNK_SIZE;
    if (data.length !== expected) {
      this.stats.rejected += 1;
      this.logger?.warn('chunk size mismatch', {
        id: op.id, i: op.i, got: data.length, expected,
      });
      return { ok: false };
    }
    if (!t.have[op.i]) {
      data.copy(t.buf, offset);
      t.have[op.i] = 1;
      t.got += 1;
    } else {
      // 重复送达（ACK 丢失后的补发）：幂等，直接覆盖
      data.copy(t.buf, offset);
    }
    t.lastTouchAt = Date.now();
    this.stats.chunks += 1;
    return { ok: true, got: t.got, total: t.n };
  }

  /** end：到齐返回 {ok, complete:true, bytes}；未到齐保留等续传。 */
  end(op) {
    const t = this.transfers.get(op.id);
    if (!t) {
      this.stats.rejected += 1;
      return { ok: false, complete: false };
    }
    t.lastTouchAt = Date.now();
    if (t.got < t.n) {
      this.stats.incomplete += 1;
      const missing = [];
      for (let i = 0; i < t.n; i += 1) if (!t.have[i]) missing.push(i);
      return { ok: true, complete: false, got: t.got, total: t.n, missing };
    }
    const bytes = t.buf;
    const { mime, name } = t;
    this.transfers.delete(op.id);
    this.stats.done += 1;
    this.emit('image-complete', { id: op.id, bytes, mime, name });
    return { ok: true, complete: true, bytes, mime, name };
  }

  /** abort：释放缓冲。 */
  abort(op) {
    if (this.transfers.delete(op.id)) {
      this.stats.aborted += 1;
      this.logger?.info('image transfer aborted', { id: op.id });
    }
  }

  /** 保留期巡检：由 rt-align 的既有 30s 看门狗顺带驱动，不另起定时器。 */
  gc(now = Date.now()) {
    for (const [id, t] of this.transfers) {
      if (now - t.lastTouchAt > RT_IMAGE_RETENTION_MS) this._drop(id, 'expired');
    }
  }

  _drop(id, reason) {
    const t = this.transfers.get(id);
    if (!t) return;
    this.transfers.delete(id);
    this.stats.gc += 1;
    this.emit('image-gc', { id, reason, got: t.got, total: t.n });
  }

  /** 新随机会话 id（8 位 hex，与信封 sid 风格一致）。 */
  static newId() {
    return crypto.randomBytes(4).toString('hex');
  }
}

module.exports = {
  RtImageRx,
  normalizeImageOp,
  RT_IMAGE_CHUNK_SIZE,
  RT_IMAGE_MAX_BYTES,
  RT_IMAGE_MAX_CHUNKS,
  RT_IMAGE_RETENTION_MS,
  RT_IMAGE_MAX_PARTIALS,
};
