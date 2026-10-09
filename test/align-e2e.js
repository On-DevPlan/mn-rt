'use strict';

/**
 * 直连对齐模式端到端联调（全离线：本机自起 server.js）。
 *
 * 链路：PhoneSim(真实加密) --WS--> server.js(路由) --WS--> ServeClient + RtAlignSession
 * 验证：注册/路由、密文同步、diff 计划、ACK 反向路由、明文拒绝、RT_TOKEN 门禁。
 *
 * 运行：node test/align-e2e.js
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const WebSocket = require('../client/node_modules/ws');
const { ServeClient } = require('../client/lib/ws-client');
const { RtAlignSession } = require('../client/lib/rt-align');
const rtCrypto = require('../client/lib/rt-crypto');

const PORT = 18990;
const URL_WS = `ws://127.0.0.1:${PORT}/ws`;
const KEY = rtCrypto.generateKey();
const PC_CLIENT_ID = 'e2e-pc';
const PHONE_ID = 'phone-e2e';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
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

/** 手机端：真实加密 + WS 注册 + 收发。 */
class PhoneSim {
  constructor(key, phoneId) {
    this.derived = rtCrypto.deriveFromKey(key);
    this.phoneId = phoneId;
    this.seq = 0;
    this.sid = 'phone-e2e';
    this.ws = null;
    this.inbox = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL_WS);
      this.ws = ws;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        this.inbox.push(msg);
        for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
          if (this.waiters[i].probe(msg)) {
            this.waiters[i].resolve(msg);
            this.waiters.splice(i, 1);
          }
        }
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register', role: 'phone', phoneId: this.phoneId }));
      });
      ws.on('error', reject);
      ws.on('close', (code) => { this.closeCode = code; });
      // 等 registered（含服务端确认的 phoneId）
      this.waitFor((m) => m.type === 'registered', 5000).then(resolve, reject);
    });
  }

  waitFor(probe, timeoutMs) {
    const hit = this.inbox.find(probe);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { probe, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('phone waitFor timeout'));
      }, timeoutMs);
    });
  }

  syncText(text) {
    this.seq += 1;
    const envelope = rtCrypto.seal(
      this.derived.keyPhoneToPc,
      rtCrypto.buildAad(this.derived.room, 'p2c', this.seq),
      { text, ts: Date.now(), phoneId: this.phoneId },
      { sid: this.sid, seq: this.seq },
    );
    this.ws.send(JSON.stringify({ clientId: PC_CLIENT_ID, text: JSON.stringify(envelope) }));
  }

  /** 等 PC 的 E2E ACK 并解密，返回 applied_seq。 */
  async readAppliedSeq(lastSeen) {
    const frame = await this.waitFor(
      (m) => m.type === 'ack' && m.ack && (m.ack.seq ?? 0) > lastSeen,
      8000,
    );
    const plain = rtCrypto.open(
      this.derived.keyPcToPhone,
      rtCrypto.buildAad(this.derived.room, 'c2p', frame.ack.seq),
      frame.ack,
    );
    return plain.applied_seq;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/** 组装真实 PC 侧：ServeClient + RtAlignSession，注入序列落盘。 */
async function startPcSide(logger) {
  const serve = new ServeClient({ url: URL_WS, clientId: PC_CLIENT_ID, logger });
  const align = new RtAlignSession({
    key: KEY,
    logger,
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
  serve.on('text', (msg) => {
    align.handleIncoming(msg.text);
  });
  serve.connect();
  await waitFor(() => serve.connected, 5000, 'PC connected');
  return { serve, align, applied };
}

async function waitFor(probe, timeoutMs, desc) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = probe();
    if (r) return r;
    await sleep(100);
  }
  throw new Error(`timeout: ${desc}`);
}

/** 起一个带 token 配置的 server（RT_TOKEN 门禁场景用）。 */
function startServer(extraArgs, cwdEnv) {
  const child = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--log-level', 'error', ...(extraArgs || [])], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, ...cwdEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', () => { /* 静默；失败由健康检查暴露 */ });
  return child;
}

async function withServer(extraArgs, fn) {
  const child = startServer(extraArgs);
  try {
    await waitHealth(8000);
    await fn();
  } finally {
    child.kill();
    await sleep(200);
  }
}

async function mainFlow() {
  // ---- 链路就绪 ----
  const phone = new PhoneSim(KEY, PHONE_ID);
  await phone.connect();
  console.log('✓ 手机注册（phoneId 反向路由就位）');

  const pc = await startPcSide(null);
  console.log('✓ PC 注册（ServeClient + RtAlignSession）');

  // ---- 场景矩阵：追加/续写/删除/中段/清空 ----
  async function expectOps(desc, text, expected, lastAckSeen) {
    pc.applied.length = 0;
    phone.syncText(text);
    await waitFor(() => pc.align.mirror === text, 8000, `${desc}: mirror 推进`);
    assert.deepStrictEqual(pc.applied, expected, `${desc}: 注入序列不符`);
    const appliedSeq = await phone.readAppliedSeq(lastAckSeen);
    assert.ok(appliedSeq >= 1);
    console.log(`✓ ${desc}（ACK applied_seq=${appliedSeq}）`);
    return appliedSeq;
  }

  let ack = 0;
  ack = await expectOps('场景 1 追加', '你好', [{ op: 'type', text: '你好' }], ack);
  ack = await expectOps('场景 2 续写', '你好，世界', [{ op: 'type', text: '，世界' }], ack);
  ack = await expectOps('场景 3 删除', '你好', [{ op: 'backspace', count: 3 }], ack);
  ack = await expectOps('场景 4 中段编辑', '你X', [{ op: 'backspace', count: 1 }, { op: 'type', text: 'X' }], ack);
  ack = await expectOps('场景 5 清空', '', [{ op: 'backspace', count: 2 }], ack);

  // ---- 场景 6：明文旁路拒绝 ----
  pc.applied.length = 0;
  phone.ws.send(JSON.stringify({ clientId: PC_CLIENT_ID, text: '这是想绕过加密的明文' }));
  await sleep(500);
  assert.deepStrictEqual(pc.applied, [], 'plaintext must be rejected in align mode');
  assert.strictEqual(pc.align.stats.plaintextRejected, 1);
  console.log('✓ 场景 6 明文旁路被拒绝');

  // ---- 场景 7：错误 key 的信封被丢弃 ----
  const impostor = new PhoneSim('wrong-key-999', 'impostor');
  await impostor.connect();
  impostor.seq = 998; // 越过 seq 去重，直抵解密层
  pc.applied.length = 0;
  const before = pc.align.stats.envelopesBad;
  impostor.syncText('假数据');
  await sleep(500);
  assert.deepStrictEqual(pc.applied, [], 'wrong-key envelope must not inject');
  assert.ok(pc.align.stats.envelopesBad > before, 'decrypt failure counted');
  console.log('✓ 场景 7 错误 key 信封被丢弃');

  phone.close();
  impostor.close();
  pc.serve.close();
}

async function tokenFlow() {
  // ---- RT_TOKEN 门禁：不带 token 注册被 4403 ----
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_WS);
    let closed = false;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', role: 'phone', phoneId: 'no-token' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'error' && /token/.test(msg.error ?? '')) {
        closed = true;
        resolve();
      }
    });
    ws.on('close', (code) => {
      if (!closed && code === 4403) { closed = true; resolve(); }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('token gate timeout')), 5000);
  });
  console.log('✓ 场景 8 RT_TOKEN 门禁：无 token 注册被拒');

  // ---- 设 token 后：跳过注册直接推文本也被拒（2026-10-09 审查发现的旁路） ----
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_WS);
    ws.on('open', () => ws.send(JSON.stringify({ clientId: 'token-pc', text: 'bypass attempt' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'error' && /register required/.test(msg.error ?? '')) {
        try { ws.close(); } catch { /* ignore */ }
        resolve();
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('bypass gate timeout')), 5000);
  });
  console.log('✓ 场景 8b 设 token 后未注册推文本被拒');

  // ---- /push 无 token → 401 ----
  const pushResp = await fetch(`http://127.0.0.1:${PORT}/push?clientId=token-pc&text=hi`);
  assert.strictEqual(pushResp.status, 401, '/push without token must be 401');
  console.log('✓ 场景 8c /push 无 token 返回 401');

  // ---- 带 token 正常注册 ----
  const ws = new WebSocket(URL_WS);
  await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', role: 'pc', clientId: 'token-pc', token: 'SECRET' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'registered') resolve();
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('register with token timeout')), 5000);
  });
  ws.close();
  console.log('✓ 场景 9 带 token 注册通过');

  // ---- 真实 ServeClient 带 token：注册成功 ----
  await new Promise((resolve, reject) => {
    const pc = new ServeClient({ url: URL_WS, clientId: 'token-served-pc', token: 'SECRET', logger: null });
    const timer = setTimeout(() => { pc.close(); reject(new Error('ServeClient with token timeout')); }, 5000);
    pc.on('registered', (msg) => {
      clearTimeout(timer);
      pc.close();
      if (msg.role !== 'pc') return reject(new Error('unexpected role'));
      resolve();
    });
    pc.on('serve-error', (e) => { clearTimeout(timer); pc.close(); reject(new Error(`serve-error: ${e.error}`)); });
    pc.connect();
  });
  console.log('✓ 场景 10 ServeClient 带 token 注册成功');

  // ---- 真实 ServeClient 无 token：4403 拒绝且不重连 ----
  await new Promise((resolve, reject) => {
    const pc = new ServeClient({ url: URL_WS, clientId: 'token-less-pc', logger: null });
    let rejected = false;
    const timer = setTimeout(() => {
      pc.close();
      reject(new Error(rejected ? 'reconnect attempted after 4403' : 'auth-rejected timeout'));
    }, 2500);
    pc.on('auth-rejected', () => {
      rejected = true;
      // 再等一小段确认没有触发重连风暴
      setTimeout(() => {
        clearTimeout(timer);
        pc.close();
        if (pc.stats.reconnects !== 0) return reject(new Error(`unexpected reconnects: ${pc.stats.reconnects}`));
        resolve();
      }, 1200);
    });
    pc.connect();
  });
  console.log('✓ 场景 11 ServeClient 无 token 被 4403 拒绝且停止重连');
}

async function main() {
  console.log('== 第一轮：无 token（明文模式共存，align 拒明文） ==');
  await withServer([], mainFlow);

  console.log('\n== 第二轮：RT_TOKEN=SECRET（注册门禁） ==');
  await withServer(['--token', 'SECRET'], tokenFlow);

  console.log('\n全部场景通过 ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nE2E 失败：${e.message}`);
  process.exit(1);
});
