'use strict';

/**
 * 图片通道端到端冒烟（v0.7.0+ 文件模块·实时拍照）。
 *
 * 一条命令拉起完整链路并打真剪贴板：
 *   本地 serve → PC 客户端（对齐模式，真 rust input-agent）→ 假手机端发图。
 * 验证：begin/chunk/end 全链路、逐块 ACK、最后一块 ACK = 剪贴板写入成功。
 *
 * 运行：node test/e2e-image-smoke.mjs [图片路径]
 *   默认图片 test/fixtures/photo_smoke_100x70.jpg（验证时看剪贴板应为 100x70）。
 *   端口 18791；冲突时改 E2E_PORT 环境变量。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { deriveFromKey, buildAad, seal, open } = require('../lib/rt-crypto');
const { RT_IMAGE_CHUNK_SIZE } = require('../lib/rt-image');

const ROOT = path.join(__dirname, '..', '..');
const CLIENT_ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 18791);
const KEY = 'SMOKEKEY123';
const CLIENT_ID = 'smoke-pc-e2e';
const IMAGE = process.argv[2] || path.join(__dirname, 'fixtures', 'photo_smoke_100x70.jpg');
const ACK_TIMEOUT_MS = 20000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-e2e-'));
const children = [];

function log(tag, msg) {
  process.stdout.write(`[e2e][${tag}] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`serve 未在 ${timeoutMs}ms 内监听端口 ${port}`);
}

function spawnChild(tag, cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  p.stdout.on('data', (d) => log(tag, String(d).trim().split('\n').join(' | ')));
  p.stderr.on('data', (d) => log(tag, String(d).trim().split('\n').join(' | ')));
  p.on('exit', (code) => log(tag, `exit code=${code}`));
  return p;
}

/** 假手机端：注册 → 分片 → seal → 逐块发送 → 收 ACK 直到最后一块被确认。 */
async function phoneSide() {
  const jpeg = fs.readFileSync(IMAGE);
  const derived = deriveFromKey(KEY);
  const sid = 'e2e1';
  let seq = 1;

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const ackAppliedSeqs = [];
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'ack' && msg.ack) {
      try {
        const plain = open(derived.keyPcToPhone, buildAad(derived.room, 'c2p', msg.ack.seq), msg.ack);
        ackAppliedSeqs.push(plain.applied_seq);
      } catch (e) {
        log('phone', `ack open failed: ${e.message}`);
      }
    }
  });

  const sendEnvelope = (plain, seq) => {
    const envelope = seal(
      derived.keyPhoneToPc,
      buildAad(derived.room, 'p2c', seq),
      plain,
      { sid, seq },
    );
    ws.send(JSON.stringify({ clientId: CLIENT_ID, text: JSON.stringify(envelope) }));
  };

  ws.send(JSON.stringify({ type: 'register', role: 'phone', phoneId: 'smoke-phone' }));
  await sleep(300); // 等 registered（本地环回足够）

  /** 发一次完整传输（图片 / 文件共用 img 通道，mime 区分），等最后一块 ACK。 */
  const runTransfer = async ({ id, mime, name, bytes }) => {
    const n = Math.ceil(bytes.length / RT_IMAGE_CHUNK_SIZE);
    sendEnvelope(
      { img: { op: 'begin', id, n, size: bytes.length, mime, ...(name ? { name } : {}) }, ts: Date.now(), phoneId: 'smoke-phone' },
      seq,
    );
    seq += 1;
    for (let i = 0; i < n; i += 1) {
      const d = bytes.subarray(i * RT_IMAGE_CHUNK_SIZE, Math.min((i + 1) * RT_IMAGE_CHUNK_SIZE, bytes.length));
      sendEnvelope({ img: { op: 'chunk', id, i, d: d.toString('base64') }, ts: Date.now(), phoneId: 'smoke-phone' }, seq);
      seq += 1;
    }
    const endSeq = seq;
    sendEnvelope({ img: { op: 'end', id }, ts: Date.now(), phoneId: 'smoke-phone' }, endSeq);
    seq += 1;

    const deadline = Date.now() + ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (ackAppliedSeqs.includes(endSeq)) return { chunks: n, acks: ackAppliedSeqs.length };
      await sleep(100);
    }
    throw new Error(`传输 ${id} 最后一块(${endSeq})在 ${ACK_TIMEOUT_MS}ms 内未获 ACK；收到 ${JSON.stringify(ackAppliedSeqs)}`);
  };

  // 1) 图片：JPEG → 剪贴板 CF_DIB
  const img = await runTransfer({ id: 'aaaa0001', mime: 'image/jpeg', bytes: jpeg });
  // 2) 文件（v0.9.0）：octet-stream + name → 接收目录落盘 + CF_HDROP 复制
  const fileBytes = Buffer.from(`RemoteType e2e 文件通道冒烟 ${new Date().toISOString()}\n`.repeat(40));
  const file = await runTransfer({ id: 'bbbb0002', mime: 'application/octet-stream', name: 'e2e-smoke.txt', bytes: fileBytes });
  ws.close();
  return { img, file };
}


async function main() {
  if (!fs.existsSync(IMAGE)) {
    throw new Error(`图片不存在: ${IMAGE}`);
  }
  log('main', `临时目录 ${tmp}`);

  spawnChild('serve', 'node', [
    path.join(ROOT, 'server', 'src', 'server.js'),
    '--port', String(PORT),
    '--record-file', path.join(tmp, 'records.jsonl'),
    '--log-dir', path.join(tmp, 'logs'),
  ], ROOT);
  await waitPort(PORT);

  spawnChild('client', 'node', [
    path.join(CLIENT_ROOT, 'bin', 'index.js'),
    // 0.7.x 起 CLI 改为子命令制：连接必须显式 `serve`
    'serve',
    '--url', `ws://127.0.0.1:${PORT}/ws`,
    '--client-id', CLIENT_ID,
    '--align', '--key', KEY,
    '--no-save',
    '--no-update-check',
    // 文件接收目录指到临时区，别污染真实的 ~/Downloads
    '--receive-dir', path.join(tmp, 'received'),
    '--record-file', path.join(tmp, 'client-records.jsonl'),
  ], CLIENT_ROOT);
  await sleep(1200); // 等注册与 agent 就绪

  const { img, file } = await phoneSide();
  const received = path.join(tmp, 'received', 'e2e-smoke.txt');
  if (!fs.existsSync(received)) {
    throw new Error(`文件通道落盘失败：${received} 不存在`);
  }
  log('main', `PASS：图片 ${img.chunks} 块 + 文件 ${file.chunks} 块全部确认；图片进过剪贴板、文件已落盘 ${received} 并以 CF_HDROP 复制`);
}

main()
  .then(() => process.exitCode = 0)
  .catch((e) => { log('main', `FAIL: ${e.message}`); process.exitCode = 1; })
  .finally(() => {
    for (const p of children) { try { p.kill(); } catch { /* ignore */ } }
    setTimeout(() => process.exit(process.exitCode || 0), 300).unref?.();
  });
