'use strict';

/**
 * RT1 加密核心（WebCrypto 版）—— 浏览器网页控制台专用。
 *
 * 与两端逐字节对齐（跨语言契约）：
 *   - mn-rt client/lib/rt-crypto.js   （Node crypto，向量源）
 *   - fr   lib/lab/demos/remotetype/rt_crypto.dart （Dart cryptography）
 *   - 本文件                            （浏览器 WebCrypto，第三实现）
 *
 * 三实现共同钉死同一组向量：client/test/vectors/rt1-vectors.json，
 * 由 test/webclient-e2e.js 在 Node 的 webcrypto 上校验（与浏览器同 API）。
 *
 * 直连模式：无配对握手，房间号仅作 AAD 上下文标签。
 * UMD：浏览器挂 window.RT1，Node 直接 require（测试用）。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RT1 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RT1_PREFIX = 'RT1';
  const PBKDF2_ITERATIONS = 10000;
  const PBKDF2_SALT = 'RT1-pair';
  const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ROOM_CODE_LEN = 5;
  const INFO = {
    room: 'RT1-room',
    salt: 'RT1-salt',
    keyPhoneToPc: 'RT1-key-phone-pc',
    keyPcToPhone: 'RT1-key-pc-phone',
  };
  const DIR_P2C = 'p2c';
  const DIR_C2P = 'c2p';

  function cryptoImpl() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto;
    }
    if (typeof require !== 'undefined') {
      return require('crypto').webcrypto; // 旧 Node 兜底；≥19 有全局 crypto
    }
    throw new Error('WebCrypto unavailable');
  }

  const subtle = cryptoImpl().subtle;
  const te = (s) => new TextEncoder().encode(s);

  /** key 归一化：大写 + 只留字母数字（与两端一致）。 */
  function normalizeKey(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function randomBytes(n) {
    const u = new Uint8Array(n);
    cryptoImpl().getRandomValues(u);
    return u;
  }

  function randomHex(bytes) {
    let s = '';
    for (const b of randomBytes(bytes)) s += b.toString(16).padStart(2, '0');
    return s;
  }

  async function deriveFromKey(rawKey) {
    const key = normalizeKey(rawKey);
    if (!key) throw new Error('pairing key is empty');

    const baseKey = await subtle.importKey('raw', te(key), 'PBKDF2', false, ['deriveBits']);
    const masterBits = await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: te(PBKDF2_SALT), iterations: PBKDF2_ITERATIONS },
      baseKey,
      256,
    );
    const master = new Uint8Array(masterBits);

    const hkdf = async (info, lengthBytes) => {
      const k = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
      const bits = await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te(info) },
        k,
        lengthBytes * 8,
      );
      return new Uint8Array(bits);
    };

    const roomRaw = await hkdf(INFO.room, 32);
    let room = '';
    for (let i = 0; i < roomRaw.length && room.length < ROOM_CODE_LEN; i += 1) {
      const b = roomRaw[i];
      if (b < 248) room += ROOM_ALPHABET[b % ROOM_ALPHABET.length]; // 31*8=248 去偏
    }
    if (room.length < ROOM_CODE_LEN) throw new Error('room derive failed');

    return {
      room,
      pairSalt: await hkdf(INFO.salt, 16),
      keyPhoneToPc: await hkdf(INFO.keyPhoneToPc, 32),
      keyPcToPhone: await hkdf(INFO.keyPcToPhone, 32),
    };
  }

  function buildAad(room, direction, seq) {
    return `${RT1_PREFIX}|${room}|${direction}|${seq}`;
  }

  const b64 = (u8) => {
    let s = '';
    for (const b of u8) s += String.fromCharCode(b);
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function aesKey(bytes) {
    return subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  /** 加密业务明文 → relay/信封 {sid, seq, nonce, ct}（ct 含 128-bit tag，与两端一致）。 */
  async function seal(keyBytes, aad, plaintextObj, meta) {
    const m = meta || {};
    const nonce = randomBytes(12);
    const k = await aesKey(keyBytes);
    const ct = new Uint8Array(
      await subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: te(aad), tagLength: 128 },
        k,
        te(JSON.stringify(plaintextObj)),
      ),
    );
    return {
      sid: m.sid || randomHex(4),
      seq: m.seq || 0,
      nonce: b64(nonce),
      ct: b64(ct),
    };
  }

  /** 解信封；tag/AAD 不符时 WebCrypto 直接 reject。 */
  async function open(keyBytes, aad, envelope) {
    const nonce = unb64(envelope.nonce);
    const body = unb64(envelope.ct);
    if (nonce.length !== 12 || body.length < 16) throw new Error('malformed envelope');
    const k = await aesKey(keyBytes);
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: te(aad), tagLength: 128 },
      k,
      body, // WebCrypto 约定：密文尾部自带 tag，body 整体传入即可
    );
    return JSON.parse(new TextDecoder().decode(pt));
  }

  return {
    RT1_PREFIX,
    ROOM_ALPHABET,
    INFO,
    DIR_P2C,
    DIR_C2P,
    normalizeKey,
    deriveFromKey,
    buildAad,
    seal,
    open,
    randomHex,
    randomBytes,
  };
});
