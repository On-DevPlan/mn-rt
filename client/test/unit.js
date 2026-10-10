'use strict';

/**
 * client 侧单元测试（不依赖 X11、不依赖网络）。
 *
 * 覆盖三个纯逻辑模块：
 *   - lib/sanitize.js  文本预处理
 *   - lib/queue.js     FIFO 串行队列
 *   - lib/platform.js  平台识别
 *
 * 运行：node test/unit.js
 */

const assert = require('assert');
const path = require('path');

const { sanitize, isInvisible, DEFAULT_MAX_LENGTH } = require('../lib/sanitize');
const { MessageQueue } = require('../lib/queue');
const platform = require('../lib/platform');
const { parseArgs, resolveEnterMode } = require('../lib/config');

let pass = 0;
let fail = 0;

// 收集待执行的用例，最后统一串行 await。
// 若直接在 test() 里执行异步用例，返回的 Promise 会被丢弃，
// 导致断言在进程退出后才结算（表现为「异步用例全部没输出」）。
const pending = [];

function test(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      pass += 1;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (e) {
      fail += 1;
      console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`);
    }
  });
}

async function run() {
  for (const t of pending) await t();
}

console.log('\n== sanitize：文本预处理 ==');

test('config：CLI 多词参数归一化为驼峰（--client-id → flags.clientId）', () => {
  const { flags } = parseArgs(['--client-id', 'pc-x', '--log-level', 'debug', '--align', '--key=MYKEY']);
  assert.strictEqual(flags.clientId, 'pc-x');
  assert.strictEqual(flags.logLevel, 'debug');
  assert.strictEqual(flags.align, true);
  assert.strictEqual(flags.key, 'MYKEY');
});

test('普通中文原样保留', () => {
  const r = sanitize('你好世界');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '你好世界');
});

test('中文标点不被误伤（。、「」、）', () => {
  const s = '测试句号。引号「」顿号、结束';
  assert.strictEqual(sanitize(s).text, s);
});

test('保留换行与 Tab', () => {
  const r = sanitize('第一行\n第二行\t缩进');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '第一行\n第二行\t缩进');
});

test('剔除零宽字符', () => {
  const r = sanitize('可\u200b见\u200d文字\ufeff');
  assert.strictEqual(r.text, '可见文字');
});

test('剔除 C0 控制字符（\\x07 响铃 / \\x1b ESC）', () => {
  const r = sanitize('可见\u0007\u001b文字');
  assert.strictEqual(r.text, '可见文字');
});

test('统一 \\r\\n 为 \\n', () => {
  assert.strictEqual(sanitize('a\r\nb\rc').text, 'a\nb\nc');
});

test('空串被拒', () => {
  const r = sanitize('');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'empty_after_clean');
});

test('纯空白被拒', () => {
  assert.strictEqual(sanitize('   \n\t ').ok, false);
});

test('仅含零宽字符被拒', () => {
  assert.strictEqual(sanitize('\u200b\u200d\ufeff').ok, false);
});

test('非字符串被拒', () => {
  assert.strictEqual(sanitize(null).reason, 'not_a_string');
  assert.strictEqual(sanitize(12345).reason, 'not_a_string');
});

test('keepWhitespace：纯空白保留（对齐模式，IME 自动换行不算失败）', () => {
  const r = sanitize('   \n\t ', { keepWhitespace: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '   \n\t ');
  // 含换行的正常文本不受影响
  assert.strictEqual(sanitize('你好\n不要', { keepWhitespace: true }).text, '你好\n不要');
});

test('keepWhitespace：整条仅不可见字符 → ok 且空串，由调用方决定无操作', () => {
  const r = sanitize('​‍﻿', { keepWhitespace: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '');
});

test('keepWhitespace 不影响默认路径', () => {
  assert.strictEqual(sanitize('   \n\t ', { keepWhitespace: false }).ok, false);
});

test('超长截断并标记 truncated', () => {
  const r = sanitize('字'.repeat(DEFAULT_MAX_LENGTH + 100));
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(Array.from(r.text).length, DEFAULT_MAX_LENGTH);
});

test('自定义 maxLength 生效', () => {
  const r = sanitize('一二三四五', { maxLength: 3 });
  assert.strictEqual(r.text, '一二三');
  assert.strictEqual(r.truncated, true);
});

test('isInvisible 对可见字符返回 false', () => {
  assert.strictEqual(isInvisible('你'), false);
  assert.strictEqual(isInvisible('。'), false);
  assert.strictEqual(isInvisible(' '), false);
});

console.log('\n== MessageQueue：FIFO 串行队列 ==');

test('严格按入队顺序串行处理', async () => {
  const seen = [];
  const q = new MessageQueue({
    handler: async (item) => {
      // 人为制造耗时差异，验证不会交叉执行
      await new Promise((r) => setTimeout(r, item.delay));
      seen.push(item.n);
    },
  });
  for (let i = 1; i <= 5; i += 1) {
    q.push({ n: i, delay: (6 - i) * 5 });
  }
  await q.waitIdle(5000);
  assert.deepStrictEqual(seen, [1, 2, 3, 4, 5]);
});

test('同一时刻只有一条在途（无并发交叉）', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const q = new MessageQueue({
    handler: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent -= 1;
    },
  });
  for (let i = 0; i < 8; i += 1) q.push({ n: i });
  await q.waitIdle(5000);
  assert.strictEqual(maxConcurrent, 1);
});

test('队列满时丢弃新消息并计数', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const q = new MessageQueue({
    maxSize: 2,
    // 第一条会立刻被取出消费并卡在 gate 上，从而让后续入队稳定堆积
    handler: (item) => (item.n === 1 ? gate : Promise.resolve()),
  });
  q.push({ n: 1 });          // 被取出，占住消费者
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(q.push({ n: 2 }), true);   // 队列深度 1
  assert.strictEqual(q.push({ n: 3 }), true);   // 队列深度 2（达到上限）
  assert.strictEqual(q.push({ n: 4 }), false);  // 超出，被丢弃
  assert.strictEqual(q.stats.dropped, 1);
  release();
  await q.waitIdle(2000);
});

test('handler 抛错时记录 failed 且不阻断后续消息', async () => {
  const seen = [];
  const q = new MessageQueue({
    handler: async (item) => {
      if (item.n === 2) throw new Error('boom');
      seen.push(item.n);
    },
  });
  for (const n of [1, 2, 3]) q.push({ n });
  await q.waitIdle(5000);
  assert.deepStrictEqual(seen, [1, 3]);
  assert.strictEqual(q.stats.failed, 1);
  assert.strictEqual(q.stats.processed, 2);
});

test('pause 后暂停消费，resume 后继续', async () => {
  const seen = [];
  const q = new MessageQueue({
    handler: async (item) => { seen.push(item.n); },
  });
  q.pause();
  q.push({ n: 1 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(seen, []);
  q.resume();
  await q.waitIdle(2000);
  assert.deepStrictEqual(seen, [1]);
});

test('waitIdle 在空闲队列上立即返回 true', async () => {
  const q = new MessageQueue({ handler: async () => {} });
  assert.strictEqual(await q.waitIdle(100), true);
});

console.log('\n== platform：平台识别 ==');

test('resolveTarget 返回 platform/arch/key', () => {
  const t = platform.resolveTarget();
  assert.ok(t && typeof t === 'object');
  assert.ok(['win32', 'darwin', 'linux'].includes(t.platform), `platform=${t.platform}`);
  assert.ok(typeof t.arch === 'string' && t.arch.length > 0);
  assert.strictEqual(t.key, `${t.platform}-${t.arch}`);
});

test('binaryName 在 Windows 带 .exe 后缀', () => {
  assert.strictEqual(platform.binaryName('win32'), 'input-agent.exe');
  assert.strictEqual(platform.binaryName('darwin'), 'input-agent');
  assert.strictEqual(platform.binaryName('linux'), 'input-agent');
});

test('isSupported 对已知平台返回 true', () => {
  assert.strictEqual(platform.isSupported('linux', 'x64'), true);
  assert.strictEqual(platform.isSupported('darwin', 'arm64'), true);
  assert.strictEqual(platform.isSupported('win32', 'x64'), true);
});

test('isSupported 对未知平台返回 false', () => {
  // resolveTarget 会把非 arm64 的 arch 归一化为 x64，
  // 因此只有未知的 OS 才会落在支持列表之外。
  assert.strictEqual(platform.isSupported('freebsd', 'x64'), false);
  assert.strictEqual(platform.isSupported('sunos', 'x64'), false);
});

test('resolveTarget 归一化未知 arch 为 x64', () => {
  assert.strictEqual(platform.resolveTarget('linux', 'ia32').key, 'linux-x64');
  assert.strictEqual(platform.resolveTarget('linux', 'arm64').key, 'linux-arm64');
});

test('binaryUrl 指向扁平命名 input-agent-<key>[.exe]', () => {
  const linux = platform.binaryUrl({ platform: 'linux', arch: 'x64', key: 'linux-x64' });
  assert.ok(linux.startsWith('https://'), linux);
  assert.ok(linux.endsWith('/input-agent-linux-x64'), linux);

  const win = platform.binaryUrl({ platform: 'win32', arch: 'x64', key: 'win32-x64' });
  assert.ok(win.endsWith('/input-agent-win32-x64.exe'), win);

  const mac = platform.binaryUrl({ platform: 'darwin', arch: 'arm64', key: 'darwin-arm64' });
  assert.ok(mac.endsWith('/input-agent-darwin-arm64'), mac);
});

// ================= RT1 加密（rt-crypto.js） =================

const fs = require('fs');
const rtCrypto = require('../lib/rt-crypto');
const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'vectors', 'rt1-vectors.json'), 'utf8'),
);

test('RT1 KDF 与对拍向量逐字节一致（跨语言契约）', () => {
  const d = rtCrypto.deriveFromKey(vectors.input_key);
  assert.strictEqual(rtCrypto.normalizeKey(vectors.input_key), vectors.normalized_key);
  assert.strictEqual(d.room, vectors.room);
  assert.strictEqual(d.pairSalt.toString('hex'), vectors.pair_salt_hex);
  assert.strictEqual(d.keyPhoneToPc.toString('hex'), vectors.key_phone_to_pc_hex);
  assert.strictEqual(d.keyPcToPhone.toString('hex'), vectors.key_pc_to_phone_hex);
});

test('RT1 房间号满足 relay requested_code 规则', () => {
  assert.match(vectors.room, /^[A-HJ-NP-Z2-9]{5}$/);
  // 归一化输入只改大小写/符号，不影响派生
  const d2 = rtCrypto.deriveFromKey('  RT1-test-key-AB12 ');
  assert.strictEqual(d2.room, vectors.room);
});

test('RT1 pairProof 与对拍向量一致', () => {
  assert.strictEqual(
    rtCrypto.pairProof(Buffer.from(vectors.pair_salt_hex, 'hex'), vectors.pair_nonce),
    vectors.pair_proof_hex,
  );
});

test('RT1 能打开向量信封并还原明文', () => {
  const d = rtCrypto.deriveFromKey(vectors.input_key);
  const aad = rtCrypto.buildAad(vectors.room, vectors.envelope.direction, vectors.envelope.seq);
  const plain = rtCrypto.open(d.keyPhoneToPc, aad, vectors.envelope);
  assert.deepStrictEqual(plain, vectors.envelope_plaintext);
});
test('RT1 seal/open 往返 + AAD 篡改拒绝', () => {
  const d = rtCrypto.deriveFromKey(vectors.input_key);
  const aad = rtCrypto.buildAad(d.room, 'c2p', 3);
  const env = rtCrypto.seal(d.keyPcToPhone, aad, { applied_seq: 9, ts: 1 }, { sid: 'ff', seq: 3 });
  assert.deepStrictEqual(rtCrypto.open(d.keyPcToPhone, aad, env), { applied_seq: 9, ts: 1 });

  // 换方向/换房间/换 seq 的 AAD 都必须解不开
  assert.throws(() => rtCrypto.open(d.keyPcToPhone, rtCrypto.buildAad(d.room, 'p2c', 3), env));
  assert.throws(() => rtCrypto.open(d.keyPcToPhone, rtCrypto.buildAad('ZZZZZ', 'c2p', 3), env));
  assert.throws(() => rtCrypto.open(d.keyPcToPhone, rtCrypto.buildAad(d.room, 'c2p', 4), env));
  // 换密钥解不开
  assert.throws(() => rtCrypto.open(d.keyPhoneToPc, aad, env));
  // 密文被翻动解不开
  const bad = { ...env, ct: env.ct.slice(0, -4) + (env.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  assert.throws(() => rtCrypto.open(d.keyPcToPhone, aad, bad));
});

test('generateKey 产出 20 位无易混字符 key，且可正常派生', () => {
  const key = rtCrypto.generateKey();
  assert.match(key, new RegExp(`^[${rtCrypto.ROOM_ALPHABET}]{20}$`));
  const d = rtCrypto.deriveFromKey(key);
  assert.match(d.room, /^[A-HJ-NP-Z2-9]{5}$/);
});

// ================= RT1 diff（rt-diff.js） =================

const { planTransition, graphemes } = require('../lib/rt-diff');

test('diff：grapheme 拆分（emoji ZWJ / 组合字符为一个整体）', () => {
  assert.deepStrictEqual(graphemes('家庭👨‍👩‍👧‍👦'), ['家', '庭', '👨‍👩‍👧‍👦']);
  assert.deepStrictEqual(graphemes('Cafe\u{301}'), ['C', 'a', 'f', 'e\u{301}']);
});

test('diff：FlowType 用例集（追加/改尾/删 emoji/组合字符不破坏）', () => {
  assert.deepStrictEqual(planTransition('你好', '你好，Windows'), { backspaces: 0, insert: '，Windows' });
  assert.deepStrictEqual(planTransition('正在输入旧内容', '正在输入新文本'), { backspaces: 3, insert: '新文本' });
  assert.deepStrictEqual(planTransition('家庭👨‍👩‍👧‍👦', '家庭'), { backspaces: 1, insert: '' });
  assert.deepStrictEqual(planTransition('Cafe\u{301}', 'Cafe\u{301} 好'), { backspaces: 0, insert: ' 好' });
});

test('diff：中段编辑回删到共同前缀重打（光标在末尾语义，禁用后缀优化）', () => {
  // 后缀保尾必须先左移光标才正确，而注入原语没有光标左移——
  // 曾因后缀优化把中段改动打到文本末尾（屏幕 'abcd'→期望 'abd' 实得 'abc'）
  assert.deepStrictEqual(planTransition('ABCDE', 'ABXDE'), { backspaces: 3, insert: 'XDE' });
  assert.deepStrictEqual(planTransition('前缀[旧]后缀', '前缀[新]后缀'), { backspaces: 4, insert: '新]后缀' });
  assert.deepStrictEqual(planTransition('abcd', 'abd'), { backspaces: 2, insert: 'd' });
  assert.deepStrictEqual(planTransition('hello world', 'hello brave world'), {
    backspaces: 5,
    insert: 'brave world',
  });
});

test('diff：清空 / 从空开始 / 无变化 / 长度增减边界', () => {
  assert.deepStrictEqual(planTransition('你好世界', ''), { backspaces: 4, insert: '' });
  assert.deepStrictEqual(planTransition('', '你好'), { backspaces: 0, insert: '你好' });
  assert.deepStrictEqual(planTransition('same', 'same'), { backspaces: 0, insert: '' });
  assert.deepStrictEqual(planTransition('aaa', 'aaaa'), { backspaces: 0, insert: 'a' });
  assert.deepStrictEqual(planTransition('aaaa', 'aaa'), { backspaces: 1, insert: '' });
});

// 计划自洽性：任一 transition 按注入语义模拟执行后必须精确落在 current
test('diff：计划自洽（backspace+type 模拟执行必达 current）', () => {
  const cases = [
    ['abc', 'ab'],
    ['你好世界', '你好世'],
    ['abcd', 'abd'],
    ['今天天气很好', '今天气很好'],
    ['hello world', 'hello brave world'],
    ['ABC', 'ABCD'],
    ['前缀[旧]后缀', '前缀[新]后缀'],
    [' completely different ', '完全不同'],
    ['', '从头输入'],
    ['全部删掉', ''],
  ];
  for (const [prev, cur] of cases) {
    const plan = planTransition(prev, cur);
    const applied = graphemes(prev).slice(0, graphemes(prev).length - plan.backspaces).join('') + plan.insert;
    assert.strictEqual(applied, cur, `'${prev}' → '${cur}' 计划执行后不落位`);
  }
});

// ================= RtAlignSession 状态机（纯逻辑，不连网） =================

const { RtAlignSession, looksLikeEnvelope } = require('../lib/rt-align');

/** 构造一个不连网的 align 会话，收集 op 事件与 ACK 外发。 */
function newTestAlign(key) {
  const acks = [];
  const align = new RtAlignSession({
    key,
    sendAck: (envelope) => acks.push(envelope),
  });
  const ops = [];
  align.on('op', (op) => ops.push(op));
  return { align, ops, acks };
}

/** 以手机身份密封一条全文（走真实加密链路）。 */
function sealedSync(align, text, seq, sid = 's1', phoneId = 'phone-e2e', enterMode) {
  const { seal, buildAad } = require('../lib/rt-crypto');
  const plain = { text, ts: 0, phoneId };
  if (enterMode) plain.enterMode = enterMode;
  return JSON.stringify(
    seal(align.keyPhoneToPc, buildAad(align.room, 'p2c', seq), plain, { sid, seq }),
  );
}

test('looksLikeEnvelope 嗅探信封形状', () => {
  assert.ok(looksLikeEnvelope('{"sid":"a","seq":1,"nonce":"n","ct":"c"}'));
  assert.ok(!looksLikeEnvelope('just plain text'));
  assert.ok(!looksLikeEnvelope('{"sid":"a","seq":1}')); // 缺字段
  assert.ok(!looksLikeEnvelope('not json {'));
});

test('align：明文拒绝（直连模式防旁路注入）', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  assert.strictEqual(align.handleIncoming('普通明文文本'), 'plaintext');
  assert.strictEqual(align.stats.plaintextRejected, 1);
  assert.deepStrictEqual(ops, []);
});

test('align：快照携带合法 enterMode → type op 透传', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '第一行\n第二行', 1, 's1', 'phone-e2e', 'shift_enter'));
  assert.deepStrictEqual(ops.map((o) => o.op), ['type', 'commit']);
  assert.strictEqual(ops[0].enterMode, 'shift_enter');
});

test('align：旧手机不带 enterMode → type op 不携带该字段', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '你好', 1));
  assert.strictEqual(ops[0].op, 'type');
  assert.ok(!('enterMode' in ops[0]));
});

test('align：非法 enterMode 丢弃——不透传不崩溃', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '你好', 1, 's1', 'phone-e2e', 'raw'));
  assert.ok(!('enterMode' in ops[0]));
  align.handleIncoming(sealedSync(align, '你好!', 2, 's1', 'phone-e2e', 123));
  assert.ok(!('enterMode' in ops[0]));
});

test('align：enterMode 随最新快照切换', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, 'a', 1, 's1', 'phone-e2e', 'shift_enter'));
  assert.strictEqual(ops[0].enterMode, 'shift_enter');
  align.commitApplied(1, 'a');
  ops.length = 0;
  align.handleIncoming(sealedSync(align, 'ab', 2, 's1', 'phone-e2e', 'enter'));
  assert.strictEqual(ops[0].enterMode, 'enter');
});

test('align：解密全文 → 产出 backspace/type/commit 计划', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  assert.strictEqual(align.handleIncoming(sealedSync(align, '你好', 1)), 'envelope');
  assert.deepStrictEqual(ops.map((o) => o.op), ['type', 'commit']);
  assert.strictEqual(ops[0].text, '你好');
  assert.strictEqual(align.phoneId, 'phone-e2e');

  // 追加：只有 type + commit
  ops.length = 0;
  align.commitApplied(1, '你好');
  align.handleIncoming(sealedSync(align, '你好世界', 2));
  assert.deepStrictEqual(ops.map((o) => o.op), ['type', 'commit']);
  assert.strictEqual(ops[0].text, '世界');

  // 删字：只有 backspace（+commit）
  ops.length = 0;
  align.commitApplied(2, '你好世界');
  align.handleIncoming(sealedSync(align, '你好', 3));
  assert.deepStrictEqual(ops.map((o) => o.op), ['backspace', 'commit']);
  assert.strictEqual(ops[0].count, 2);
});

test('align：中段编辑回删到共同前缀重打（贯通到计划层）', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '前缀[旧]后缀', 1));
  align.commitApplied(1, '前缀[旧]后缀');
  ops.length = 0;
  align.handleIncoming(sealedSync(align, '前缀[新]后缀', 2));
  assert.deepStrictEqual(ops.map((o) => o.op), ['backspace', 'type', 'commit']);
  assert.strictEqual(ops[0].count, 4);
  assert.strictEqual(ops[1].text, '新]后缀');
});

test('align：注入失败走 commitFailed——mirror 不推进，重试后挂起，新快照自愈', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '你好', 1));
  align.commitApplied(1, '你好');
  ops.length = 0;

  // 删字计划注入失败：mirror 必须停在 '你好'，且立即重试产出相同计划
  assert.strictEqual(align.handleIncoming(sealedSync(align, '你', 2)), 'envelope');
  assert.deepStrictEqual(ops.map((o) => o.op), ['backspace', 'commit']);
  assert.strictEqual(ops[0].count, 1);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    ops.length = 0;
    align.commitFailed(2);
    assert.strictEqual(align.mirror, '你好');
    assert.deepStrictEqual(ops.map((o) => o.op), ['backspace', 'commit'], `retry #${attempt}`);
  }

  // 超过重试上限：挂起，不再产出计划（避免坏 agent 场景打满队列）
  ops.length = 0;
  align.commitFailed(2);
  assert.deepStrictEqual(ops, []);
  assert.strictEqual(align.busy, false);

  // 下一条快照恢复：pendingFails 归零，按真实 mirror 重新 diff
  ops.length = 0;
  assert.strictEqual(align.handleIncoming(sealedSync(align, '你', 3)), 'envelope');
  assert.deepStrictEqual(ops.map((o) => o.op), ['backspace', 'commit']);
  assert.strictEqual(ops[0].count, 1);

  // 成功路径归零：commitApplied 后重试计数复位
  align.commitApplied(3, '你');
  assert.strictEqual(align.pendingFails, 0);
});

test('align：busy 期间 coalescing，commit 后对最新全文续跑', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, 'A', 1));
  // commit 前（busy）又来了 B、C 两版：不得产出针对 B 的计划
  align.handleIncoming(sealedSync(align, 'AB', 2));
  align.handleIncoming(sealedSync(align, 'ABC', 3));
  const opsForA = ops.splice(0);
  assert.deepStrictEqual(opsForA.map((o) => o.op), ['type', 'commit']);
  assert.strictEqual(opsForA[0].text, 'A');

  align.commitApplied(1, 'A');
  // 续跑直接从 A → C（跳过 B）
  assert.deepStrictEqual(ops.map((o) => o.op), ['type', 'commit']);
  assert.strictEqual(ops[0].text, 'BC');
});

test('align：重复 seq 忽略；sid 更换后 seq 域重置', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '你好', 5));
  align.commitApplied(5, '你好');
  ops.length = 0;
  // 旧 seq 重放：忽略
  assert.strictEqual(align.handleIncoming(sealedSync(align, '你好!', 5)), 'duplicate');
  assert.deepStrictEqual(ops, []);
  // 手机重启：新 sid、seq 从 1 重新开始（与旧文本无公共前缀 → 回删后重打）
  align.handleIncoming(sealedSync(align, '新会话', 1, 's2'));
  assert.deepStrictEqual(ops.map((o) => o.op), ['backspace', 'type', 'commit']);
  assert.strictEqual(ops[0].count, 2);
  assert.strictEqual(ops[1].text, '新会话');
});

test('align：密钥不匹配 → decrypt-error 不崩溃', () => {
  const { align, ops } = newTestAlign('totally-different-key-99');
  let decryptErrors = 0;
  align.on('decrypt-error', () => { decryptErrors += 1; });
  const honest = newTestAlign(vectors.input_key).align;
  assert.strictEqual(align.handleIncoming(sealedSync(honest, '你好', 1)), 'duplicate');
  assert.deepStrictEqual(ops, []);
  assert.strictEqual(decryptErrors, 1);
  assert.strictEqual(align.stats.envelopesBad, 1);
});

test('align：commit 后发 ACK 信封（方向 c2p，手机可解）', () => {
  const { align, ops, acks } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '你好', 1));
  align.commitApplied(1, '你好');
  assert.strictEqual(acks.length, 1);
  // 用手机侧对称密钥解 ACK：能还原 applied_seq 即端到端闭环
  const plain = rtCrypto.open(
    align.keyPcToPhone,
    rtCrypto.buildAad(align.room, 'c2p', acks[0].seq),
    acks[0],
  );
  assert.strictEqual(plain.applied_seq, 1);
});

// ================= resolveEnterMode：手机字段 > CLI 配置 > raw =================

test('resolveEnterMode：手机字段优先于 CLI 配置', () => {
  assert.strictEqual(resolveEnterMode('shift_enter', 'enter'), 'shift_enter');
  assert.strictEqual(resolveEnterMode('enter', 'shift_enter'), 'enter');
});

test('resolveEnterMode：手机字段缺失或非法时回退 CLI 配置', () => {
  assert.strictEqual(resolveEnterMode(undefined, 'shift_enter'), 'shift_enter');
  assert.strictEqual(resolveEnterMode('bogus', 'shift_enter'), 'shift_enter');
  assert.strictEqual(resolveEnterMode(null, 'enter'), 'enter');
  assert.strictEqual(resolveEnterMode('raw', 'shift_enter'), 'shift_enter');
});

test('resolveEnterMode：两级都无 → raw', () => {
  assert.strictEqual(resolveEnterMode(undefined, 'raw'), 'raw');
  assert.strictEqual(resolveEnterMode(undefined, undefined), 'raw');
});

run().then(() => {
  console.log('\n========================================');
  console.log(`  通过 ${pass}   失败 ${fail}`);
  console.log('========================================\n');
  process.exit(fail === 0 ? 0 : 1);
});
