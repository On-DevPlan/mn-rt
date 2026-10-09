'use strict';

/**
 * 网页控制台（WebCrypto 第三实现）端到端联调 —— 全离线，自起 server.js。
 *
 * 验证三件事：
 *   1. rt1-core.js（浏览器同款 WebCrypto 代码）KDF 与向量逐字节一致
 *      ——三实现对拍：Node rt-crypto（源）/ Dart rt_crypto / Web rt1-core
 *   2. server.js 托管静态页（GET / 与 /rt1-core.js）
 *   3. 网页客户端全链路：注册 → 密文同步 → PC diff 计划 → ACK 回流解密（端到端闭环）
 *
 * 运行：node test/webclient-e2e.js
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const WebSocket = require('../client/node_modules/ws');
const rtCrypto = require('../client/lib/rt-crypto'); // 向量源实现
const RT1 = require('../server/public/rt1-core.js'); // 待测的 Web 实现
const { ServeClient } = require('../client/lib/ws-client');
const { RtAlignSession } = require('../client/lib/rt-align');

const PORT = 18991;
const URL_WS = `ws://127.0.0.1:${PORT}/ws`;
const URL_HTTP = `http://127.0.0.1:${PORT}`;
const KEY = rtCrypto.generateKey();
const PC_CLIENT_ID = 'web-e2e-pc';
const PHONE_ID = 'web-e2e-phone';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get(`${URL_HTTP}/health`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error('server did not become healthy');
}

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get(URL_HTTP + p, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'client', 'test', 'vectors', 'rt1-vectors.json'), 'utf8'),
);

function hex(u8) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 1) 第三实现向量对拍 ----------

async function vectorChecks() {
  assert.strictEqual(RT1.normalizeKey(vectors.input_key), vectors.normalized_key, 'normalizeKey');
  const d = await RT1.deriveFromKey(vectors.input_key);
  assert.strictEqual(d.room, vectors.room, 'room');
  assert.strictEqual(hex(d.pairSalt), vectors.pair_salt_hex, 'pairSalt');
  assert.strictEqual(hex(d.keyPhoneToPc), vectors.key_phone_to_pc_hex, 'keyPhoneToPc');
  assert.strictEqual(hex(d.keyPcToPhone), vectors.key_pc_to_phone_hex, 'keyPcToPhone');
  // Web 实现能解 Node 预密封的向量信封
  const plain = await RT1.open(
    d.keyPhoneToPc,
    RT1.buildAad(vectors.room, vectors.envelope.direction, vectors.envelope.seq),
    vectors.envelope,
  );
  assert.deepStrictEqual(plain, vectors.envelope_plaintext, 'open vector envelope');
  // Node 实现能解 Web 密封的信封（反向互开）
  const env = await RT1.seal(
    d.keyPhoneToPc,
    rtCrypto.buildAad(d.room, 'p2c', 41),
    { text: 'web→node 互开', ts: 42, phoneId: 'web' },
    { sid: 'web01', seq: 41 },
  );
  const back = rtCrypto.open(d.keyPhoneToPc, rtCrypto.buildAad(d.room, 'p2c', 41), env);
  assert.strictEqual(back.text, 'web→node 互开');
  console.log('✓ 向量对拍：WebCrypto 实现 KDF/信封与 Node 源双向互开');
}

// ---------- 网页客户端仿真（走 rt1-core，即浏览器将执行的同一段代码） ----------

class WebClientSim {
  constructor(key, phoneId) {
    this.phoneId = phoneId;
    this.seq = 0;
    this.sid = RT1.randomHex(4);
    this.ready = null; // set after derive
    this.ws = null;
    this.inbox = [];
    this.waiters = [];
    this.e2eOk = false;
    this.appliedSeq = 0;
  }

  async connect(serverBase, targetClientId) {
    this.derived = await RT1.deriveFromKey(KEY);
    this.target = targetClientId;
    this.ws = new WebSocket(serverBase.replace(/^http/, 'ws') + '/ws');
    this.ws.on('message', (raw) => this.onFrame(JSON.parse(raw.toString())));
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({ type: 'register', role: 'phone', phoneId: this.phoneId }));
    });
    await new Promise((resolve, reject) => {
      // 注意：不能 once('message')——服务器连接即发 welcome 帧，会把 once 消耗掉
      const check = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'registered') { cleanup(); resolve(m); }
        if (m.type === 'error') { cleanup(); reject(new Error(m.error)); }
      };
      const t = setTimeout(() => { cleanup(); reject(new Error('register timeout')); }, 5000);
      const cleanup = () => {
        clearTimeout(t);
        this.ws.removeListener('message', check);
      };
      this.ws.on('message', check);
    });
  }

  onFrame(m) {
    this.inbox.push(m);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      if (this.waiters[i].probe(m)) {
        this.waiters[i].resolve(m);
        this.waiters.splice(i, 1);
      }
    }
    if (m.type === 'ack' && m.ack && m.ack.ct) this.tryOpenAck(m.ack);
  }

  waitFor(probe, timeoutMs, desc) {
    const hit = this.inbox.find(probe);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { probe, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`webclient waitFor timeout: ${desc}`));
      }, timeoutMs);
    });
  }

  /** 网页 textarea 变更 → 全文信封（与 index.html syncNow 相同调用序列）。 */
  async syncText(text) {
    this.seq += 1;
    const envelope = await RT1.seal(
      this.derived.keyPhoneToPc,
      RT1.buildAad(this.derived.room, RT1.DIR_P2C, this.seq),
      { text, ts: Date.now(), phoneId: this.phoneId },
      { sid: this.sid, seq: this.seq },
    );
    this.ws.send(JSON.stringify({ clientId: this.target, text: JSON.stringify(envelope) }));
  }

  async tryOpenAck(ack) {
    const ackSeq = Number(ack.seq) || 0;
    if (ackSeq <= this.appliedSeq) return;
    try {
      const plain = await RT1.open(
        this.derived.keyPcToPhone,
        RT1.buildAad(this.derived.room, RT1.DIR_C2P, ackSeq),
        ack,
      );
      this.appliedSeq = plain.applied_seq;
      this.e2eOk = true;
    } catch (_) { /* key 不符由断言暴露 */ }
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// ---------- 主流程 ----------

async function main() {
  // 1) 向量（不依赖 server）
  await vectorChecks();

  // 2) 起 server，验证静态托管
  const child = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--log-level', 'error'], {
    cwd: path.join(__dirname, '..', 'server'),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await waitHealth(8000);

    const index = await httpGet('/');
    assert.strictEqual(index.status, 200, 'GET / must serve the console');
    assert.ok(index.body.includes('REMOTE'), 'console page marker');
    const core = await httpGet('/rt1-core.js');
    assert.strictEqual(core.status, 200, 'GET /rt1-core.js must serve');
    console.log('✓ 静态托管：/ 与 /rt1-core.js');

    // 3) 全链路：WebClientSim(浏览器同款加密) → server → RtAlignSession
    const phone = new WebClientSim(KEY, PHONE_ID);
    await phone.connect(URL_HTTP, PC_CLIENT_ID);
    console.log('✓ 网页客户端注册');

    const serve = new ServeClient({ url: URL_WS, clientId: PC_CLIENT_ID, logger: null });
    const align = new RtAlignSession({
      key: KEY,
      logger: null,
      sendAck: (envelope) => serve.send({ type: 'ack', phoneId: align.phoneId, ack: envelope }),
    });
    const applied = [];
    let pending = [];
    let busy = false;
    align.on('op', (op) => {
      pending.push(op);
      if (!busy) drain();
    });
    function drain() {
      busy = true;
      while (pending.length > 0) {
        const op = pending.shift();
        if (op.op === 'type') applied.push({ op: 'type', text: op.text });
        else if (op.op === 'backspace') applied.push({ op: 'backspace', count: op.count });
        else if (op.op === 'commit') {
          align.commitApplied(op.seq, op.text);
          continue;
        }
      }
      busy = false;
    }
    serve.on('text', (msg) => { align.handleIncoming(msg.text); });
    serve.connect();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('PC connected timeout')), 5000);
      serve.on('connected', () => { clearTimeout(t); resolve(); });
    });
    console.log('✓ PC 侧（ServeClient + RtAlignSession）就绪');

    async function expectOps(desc, text, expected) {
      applied.length = 0;
      await phone.syncText(text);
      const deadline = Date.now() + 8000;
      while (align.mirror !== text && Date.now() < deadline) await sleep(100);
      assert.strictEqual(align.mirror, text, `${desc}: mirror 未推进`);
      assert.deepStrictEqual(applied, expected, `${desc}: 注入序列不符`);
      console.log(`✓ ${desc}`);
    }

    await expectOps('追加「你好」', '你好', [{ op: 'type', text: '你好' }]);
    await expectOps('续写', '你好，世界', [{ op: 'type', text: '，世界' }]);
    await expectOps('删除同步退格', '你好', [{ op: 'backspace', count: 3 }]);
    await expectOps('中段编辑', '你X', [{ op: 'backspace', count: 1 }, { op: 'type', text: 'X' }]);
    await expectOps('清空', '', [{ op: 'backspace', count: 2 }]);

    // 4) ACK 回流：网页端用自己的 WebCrypto 解开 → e2e 置位
    const deadline = Date.now() + 8000;
    while (!phone.e2eOk && Date.now() < deadline) await sleep(100);
    assert.ok(phone.e2eOk, 'web client must confirm E2E via decryptable ACK');
    assert.ok(phone.appliedSeq >= 1, 'applied_seq advanced');
    console.log(`✓ ACK 回流可解密（applied_seq=${phone.appliedSeq}），网页端到端闭环`);

    phone.close();
    serve.close();
  } finally {
    child.kill();
    await sleep(200);
  }

  console.log('\n全部场景通过 ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nE2E 失败：${e.message}`);
  process.exit(1);
});
