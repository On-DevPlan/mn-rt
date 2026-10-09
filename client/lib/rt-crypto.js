'use strict';

/**
 * RT1 协议加密层 —— 密钥派生 + AEAD 信封（relay 模式专用）。
 *
 * 与 fr 侧 lib/lab/demos/remotetype/rt_crypto.dart 逐字节对齐（跨语言对拍向量见
 * client/test/vectors/rt1-vectors.json，两边单测各自钉死同一组期望值）。
 *
 * 设计要点：
 *   - 一个用户 key 派生三样东西：房间号 / 配对盐 / 双方向加密密钥；
 *   - 过 relay 的一切（房间号可以被视为公开）都不是密钥本体；
 *   - 每条消息 AES-256-GCM，随机 96-bit nonce，AAD 绑定 room+方向+seq 防重放/搬移；
 *   - key 先归一化（大写、去非字母数字）再派生，两端输入习惯差异不影响结果。
 */

const crypto = require('crypto');

/** 协议版本前缀，进 AAD，防不同代协议互串。 */
const RT1_PREFIX = 'RT1';

/** PBKDF2 参数（key 预期是高熵随机串，迭代次数只求抹平实现差异）。 */
const PBKDF2_ITERATIONS = 10000;
const PBKDF2_SALT = 'RT1-pair';
const KEY_LEN = 32;

/** 房间号字母表：与 relay requested_code 规则对齐（4-6 位、排 0/O/1/I/l）。 */
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LEN = 5;

/** HKDF info 标签（两端必须逐字节一致）。 */
const INFO = {
  room: 'RT1-room',
  salt: 'RT1-salt',
  keyPhoneToPc: 'RT1-key-phone-pc',
  keyPcToPhone: 'RT1-key-pc-phone',
};

/** key 归一化：大写 + 只留字母数字（中横线/空格随用户输入习惯）。 */
function normalizeKey(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** hkdf 的薄封装：返回 Buffer。 */
function hkdf(ikm, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, length));
}

/**
 * 从用户 key 派生全部会话材料。
 *
 * @param {string} rawKey 用户输入的配对 key（未归一化原文即可）
 * @returns {{
 *   room: string,                    // 5 位房间号（[A-HJ-NP-Z2-9]，满足 relay 规则）
 *   pairSalt: Buffer,                // 配对挑战应答的 HMAC 盐（16B）
 *   keyPhoneToPc: Buffer,            // 手机→PC 方向 AES-256 密钥
 *   keyPcToPhone: Buffer,            // PC→手机 方向 AES-256 密钥
 * }}
 */
function deriveFromKey(rawKey) {
  const key = normalizeKey(rawKey);
  if (!key) throw new Error('pairing key is empty');

  const master = crypto.pbkdf2Sync(
    key, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LEN, 'sha256',
  );

  // 房间号： rejection sampling 消除取模偏置
  const raw = hkdf(master, INFO.room, 32);
  let room = '';
  for (let i = 0; i < raw.length && room.length < ROOM_CODE_LEN; i += 1) {
    const b = raw[i];
    if (b < 248) { // 31 * 8 = 248，丢弃尾部有偏字节
      room += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
    }
  }
  if (room.length < ROOM_CODE_LEN) throw new Error('room derive failed'); // 概率 ~2^-60

  return {
    room,
    pairSalt: hkdf(master, INFO.salt, 16),
    keyPhoneToPc: hkdf(master, INFO.keyPhoneToPc, 32),
    keyPcToPhone: hkdf(master, INFO.keyPcToPhone, 32),
  };
}

/** 配对应答：proof = HMAC-SHA256(pairSalt, nonce)，hex 编码。 */
function pairProof(pairSalt, nonce) {
  return crypto.createHmac('sha256', pairSalt).update(String(nonce)).digest('hex');
}

/** 构造 AAD：绑定 协议版本|房间|方向|序号，防密文跨房/跨向/乱序搬移。 */
function buildAad(room, direction, seq) {
  return `${RT1_PREFIX}|${room}|${direction}|${seq}`;
}

/**
 * 加密一条业务明文。
 *
 * @param {Buffer} key 方向密钥
 * @param {string} aad  buildAad() 产物
 * @param {object} plaintext 业务对象（序列化为 UTF-8 JSON）
 * @returns {{sid: string, seq: number, nonce: string, ct: string}} relay 信封
 */
function seal(key, aad, plaintext, envelopeMeta = {}) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const head = Buffer.from(JSON.stringify(plaintext), 'utf8');
  const ct = Buffer.concat([cipher.update(head), cipher.final(), cipher.getAuthTag()]);
  return {
    sid: envelopeMeta.sid || crypto.randomBytes(4).toString('hex'),
    seq: envelopeMeta.seq || 0,
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * 解密一条 relay 信封。tag 校验失败 / AAD 不匹配抛 Error。
 *
 * @param {Buffer} key 方向密钥
 * @param {string} aad  buildAad() 产物
 * @param {{nonce: string, ct: string}} envelope
 * @returns {object} 业务明文对象
 */
function open(key, aad, envelope) {
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const body = Buffer.from(envelope.ct, 'base64');
  if (nonce.length !== 12 || body.length < 16) {
    throw new Error('malformed envelope');
  }
  const tag = body.subarray(body.length - 16);
  const head = body.subarray(0, body.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(head), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * 生成人类可输入的强随机 key（20 位，[A-HJ-NP-Z2-9]）。
 * relay 模式未传 --key 时由 PC 端生成并打印，用户复制到手机。
 */
function generateKey() {
  const raw = crypto.randomBytes(64);
  let out = '';
  for (let i = 0; i < raw.length && out.length < 20; i += 1) {
    if (raw[i] < 248) out += ROOM_ALPHABET[raw[i] % ROOM_ALPHABET.length];
  }
  return out;
}

module.exports = {
  RT1_PREFIX,
  ROOM_ALPHABET,
  INFO,
  normalizeKey,
  deriveFromKey,
  pairProof,
  buildAad,
  seal,
  open,
  generateKey,
};
