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

// ---- 快捷键指令（v0.5.4+）----

/** 以手机身份密封一条快捷键指令（与 sealedSync 同链路，明文带 hotkey 字段）。 */
function sealedHotkey(align, keys, seq, sid = 's1', phoneId = 'phone-e2e') {
  const { seal, buildAad } = require('../lib/rt-crypto');
  const plain = { hotkey: keys, ts: 0, phoneId };
  return JSON.stringify(
    seal(align.keyPhoneToPc, buildAad(align.room, 'p2c', seq), plain, { sid, seq }),
  );
}

test('align：hotkey 信封 → hotkey op，不进 diff 状态机', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  assert.strictEqual(align.handleIncoming(sealedHotkey(align, ['win', 'r'], 1)), 'envelope');
  // 单条 op：hotkey。没有 type / backspace / commit——它是无状态事件
  assert.deepStrictEqual(ops.map((o) => o.op), ['hotkey']);
  assert.strictEqual(ops[0].key, 'r');
  assert.deepStrictEqual(ops[0].modifiers, ['win']);
  assert.strictEqual(ops[0].seq, 1);
  assert.strictEqual(align.phoneId, 'phone-e2e');
  // 不碰快照状态：desiredText 仍为 null，mirror 仍为空
  assert.strictEqual(align.desiredText, null);
  assert.strictEqual(align.mirror, '');
  assert.strictEqual(align.busy, false);
});

test('align：hotkey 重复 seq 不去重（事件语义，重复点击应重复生效）', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedHotkey(align, ['win', 'r'], 1));
  align.handleIncoming(sealedHotkey(align, ['win', 'r'], 1));
  assert.strictEqual(ops.length, 2);
  assert.deepStrictEqual(ops.map((o) => o.op), ['hotkey', 'hotkey']);
});

test('align：hotkey 与 text 快照互不干扰', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  // 先 hotkey，再文字快照：文字走正常 diff 流程
  align.handleIncoming(sealedHotkey(align, ['ctrl', 'shift', 't'], 1));
  assert.deepStrictEqual(ops.map((o) => o.op), ['hotkey']);
  ops.length = 0;
  align.handleIncoming(sealedSync(align, '你好', 2));
  assert.deepStrictEqual(ops.map((o) => o.op), ['type', 'commit']);
  assert.strictEqual(ops[0].text, '你好');
  // 再 hotkey：不与快照状态打架（desiredSeq 已是 2，hotkey seq=1 也会被放行）
  ops.length = 0;
  align.handleIncoming(sealedHotkey(align, ['f5'], 1));
  assert.deepStrictEqual(ops.map((o) => o.op), ['hotkey']);
  assert.strictEqual(ops[0].key, 'f5');
  assert.deepStrictEqual(ops[0].modifiers, []);
  // 快照状态不被 hotkey 污染：下一次快照 diff 仍从 mirror 出发
  align.commitApplied(2, '你好');
  ops.length = 0;
  align.handleIncoming(sealedSync(align, '你好!', 3));
  assert.deepStrictEqual(ops.map((o) => o.op), ['type', 'commit']);
  assert.strictEqual(ops[0].text, '!');
});

test('align：hotkey 受理即回 ACK（无按键计划也推进手机端确认）', () => {
  const { align, ops, acks } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedHotkey(align, ['win', 'v'], 7));
  assert.strictEqual(acks.length, 1);
  const plain = rtCrypto.open(
    align.keyPcToPhone,
    rtCrypto.buildAad(align.room, 'c2p', acks[0].seq),
    acks[0],
  );
  assert.strictEqual(plain.applied_seq, 7);
});

test('align：hotkey 空数组 / 非数组字段 → 按旧规则处理（向后兼容）', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  // 空数组不算 hotkey 指令，也没有 text → duplicate（老 PC 行为不变）
  const { seal, buildAad } = require('../lib/rt-crypto');
  const env = JSON.stringify(seal(
    align.keyPhoneToPc, buildAad(align.room, 'p2c', 1),
    { hotkey: [], ts: 0, phoneId: 'p' }, { sid: 's1', seq: 1 },
  ));
  assert.strictEqual(align.handleIncoming(env), 'duplicate');
  assert.deepStrictEqual(ops, []);
});

test('align：发送模式 Enter 提交后 mirror 归零（目标框已随消息清空）', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '你好\n', 1, 's1', 'phone-e2e', 'enter'));
  assert.deepStrictEqual(ops.map((o) => o.op), ['type', 'commit']);
  align.commitApplied(1, '你好\n');
  // IM 发出消息后输入框为空：mirror 必须归零与手机端清空对齐，
  // 否则下一条会先回删整条已发送内容
  assert.strictEqual(align.mirror, '');
  assert.strictEqual(align.desiredText, null);
});

test('align：发送模式归零不重打——无新快照时不得重复注入', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '第一\n', 1, 's1', 'phone-e2e', 'enter'));
  align.commitApplied(1, '第一\n');
  ops.length = 0;
  // 无新快照：归零后 desiredText 为 null，不应触发重新 dispatch 重打一遍
  assert.deepStrictEqual(ops, []);
  // 新消息正常从空 mirror 开始
  align.handleIncoming(sealedSync(align, '第二\n', 2, 's1', 'phone-e2e', 'enter'));
  assert.deepStrictEqual(ops.map((o) => o.op), ['type', 'commit']);
  assert.strictEqual(ops[0].text, '第二\n');
  align.commitApplied(2, '第二\n');
  assert.strictEqual(align.mirror, '');
});

test('align：发送模式归零——busy 期间手机清空快照已到，commit 后无重打', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '你好\n', 1, 's1', 'phone-e2e', 'enter'));
  // 注入进行中手机已清空（flush 后立刻发空快照）
  align.handleIncoming(sealedSync(align, '', 2, 's1', 'phone-e2e', 'enter'));
  align.commitApplied(1, '你好\n');
  ops.length = 0;
  // desired='' === mirror=''：不再产出任何 op
  assert.deepStrictEqual(ops, []);
  assert.strictEqual(align.mirror, '');
});

test('align：换行模式不归零（内容继续累积）', () => {
  const { align, ops } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '你好\n', 1, 's1', 'phone-e2e', 'shift_enter'));
  align.commitApplied(1, '你好\n');
  assert.strictEqual(align.mirror, '你好\n');
});

test('align：发送模式未到句尾不归零（普通中途注入）', () => {
  const { align } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, 'abc', 1, 's1', 'phone-e2e', 'enter'));
  align.commitApplied(1, 'abc');
  assert.strictEqual(align.mirror, 'abc');
});

test('align：老手机（无 enterMode）行尾不归零（行为不变）', () => {
  const { align } = newTestAlign(vectors.input_key);
  align.handleIncoming(sealedSync(align, '你好\n', 1));
  align.commitApplied(1, '你好\n');
  assert.strictEqual(align.mirror, '你好\n');
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

// ================= saveConnectionConfig：连通后保存连接参数 =================

const os = require('os');

/** 建一个隔离的临时目录并伪装成用户主目录（APPDATA/USERPROFILE），测后还原。 */
function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cfg-test-'));
  const saved = {
    // NX_RT_HOME 优先于 REMOTETYPE_HOME：开发机若全局设过它，测试会写到真实配置目录
    NX_RT_HOME: process.env.NX_RT_HOME,
    REMOTETYPE_HOME: process.env.REMOTETYPE_HOME,
    APPDATA: process.env.APPDATA,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.NX_RT_HOME = dir;
  process.env.REMOTETYPE_HOME = dir;
  // 迁移逻辑会扫「真实旧目录」（APPDATA\remotetype 与 ~/.remotetype），
  // 测试期间必须把它们也指进临时区，否则会拷到真机数据
  process.env.APPDATA = path.join(dir, 'AppData', 'Roaming');
  process.env.USERPROFILE = path.join(dir, 'home');
  process.env.HOME = path.join(dir, 'home'); // posix 的 os.homedir() 读 HOME
  try {
    fn(dir);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('saveConnectionConfig：全新目录创建 config.json 并写入连接参数', () => {
  withTempHome((dir) => {
    const { saveConnectionConfig } = require('../lib/config');
    const r = saveConnectionConfig({ url: 'ws://1.2.3.4:8790/ws', alignKey: 'KEY1', token: 'T1' });
    assert.strictEqual(r.changed, true);
    const saved = JSON.parse(fs.readFileSync(require('../lib/config').configFile(), 'utf8'));
    assert.strictEqual(saved.url, 'ws://1.2.3.4:8790/ws');
    assert.strictEqual(saved.alignKey, 'KEY1');
    assert.strictEqual(saved.token, 'T1');
  });
});

test('saveConnectionConfig：合并保留未知字段', () => {
  withTempHome((dir) => {
    const { saveConnectionConfig, configFile } = require('../lib/config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({ logLevel: 'debug', custom: 'keep-me' }));
    saveConnectionConfig({ url: 'ws://x', alignKey: 'K' });
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    assert.strictEqual(saved.logLevel, 'debug');
    assert.strictEqual(saved.custom, 'keep-me');
    assert.strictEqual(saved.alignKey, 'K');
  });
});

test('saveConnectionConfig：无变化不重写（changed:false）', () => {
  withTempHome(() => {
    const { saveConnectionConfig } = require('../lib/config');
    saveConnectionConfig({ url: 'ws://same', alignKey: 'K' });
    const r = saveConnectionConfig({ url: 'ws://same', alignKey: 'K' });
    assert.strictEqual(r.changed, false);
  });
});

test('saveConnectionConfig：空 key/token 不写入不覆盖已有值', () => {
  withTempHome(() => {
    const { saveConnectionConfig, configFile } = require('../lib/config');
    saveConnectionConfig({ url: 'ws://x', alignKey: 'OLD', token: 'T' });
    // 本次运行没带 key/token（对齐模式自动生成前的空态）：不得把已有值抹掉
    saveConnectionConfig({ url: 'ws://x', alignKey: null, token: '' });
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    assert.strictEqual(saved.alignKey, 'OLD');
    assert.strictEqual(saved.token, 'T');
  });
});

test('saveConnectionConfig → loadConfig 闭环：存了就能读回来', () => {
  withTempHome(() => {
    const { saveConnectionConfig, loadConfig } = require('../lib/config');
    saveConnectionConfig({ url: 'ws://saved:8790/ws', alignKey: 'SAVEDKEY', token: 'TT' });
    const cfg = loadConfig({});
    assert.strictEqual(cfg.url, 'ws://saved:8790/ws');
    assert.strictEqual(cfg.alignKey, 'SAVEDKEY');
    assert.strictEqual(cfg.token, 'TT');
  });
});

test('parseArgs：--no-save 归一化为 noSave', () => {
  const { flags } = parseArgs(['--no-save']);
  assert.strictEqual(flags.noSave, true);
});

// ================= 配置目录 ~/.nx-rt：环境变量优先级 + 旧目录迁移 =================

test('configDir：NX_RT_HOME 优先于 REMOTETYPE_HOME，都无时默认 ~/.nx-rt', () => {
  const { configDir } = require('../lib/config');
  const prevX = process.env.NX_RT_HOME;
  const prevR = process.env.REMOTETYPE_HOME;
  try {
    process.env.NX_RT_HOME = 'D:/tmp/nx-a';
    process.env.REMOTETYPE_HOME = 'D:/tmp/rt-b';
    assert.strictEqual(configDir(), 'D:/tmp/nx-a');
    delete process.env.NX_RT_HOME;
    assert.strictEqual(configDir(), 'D:/tmp/rt-b');
    delete process.env.REMOTETYPE_HOME;
    assert.ok(configDir().endsWith('.nx-rt'));
  } finally {
    if (prevX === undefined) delete process.env.NX_RT_HOME; else process.env.NX_RT_HOME = prevX;
    if (prevR === undefined) delete process.env.REMOTETYPE_HOME; else process.env.REMOTETYPE_HOME = prevR;
  }
});

test('migrateLegacyConfigDir：拷贝 client-id/config.json，logs/data 不动', () => {
  withTempHome((dir) => {
    const fs2 = require('fs');
    const p = require('path');
    // withTempHome 已把 HOME/USERPROFILE 指进临时区：os.homedir() 即临时 home，
    // 这里就是 legacyConfigDirs 在所有平台都会扫描的旧目录
    const oldDir = path.join(os.homedir(), '.remotetype');
    fs2.mkdirSync(p.join(oldDir, 'logs'), { recursive: true });
    fs2.writeFileSync(p.join(oldDir, 'client-id'), 'pc-old-id');
    fs2.writeFileSync(p.join(oldDir, 'config.json'), '{"url":"ws://old"}');
    fs2.writeFileSync(p.join(oldDir, 'logs', 'a.log'), 'x');
    const { migrateLegacyConfigDir } = require('../lib/config');
    const newDir = p.join(dir, '.nx-rt');
    assert.strictEqual(migrateLegacyConfigDir(newDir), true);
    assert.strictEqual(fs2.readFileSync(p.join(newDir, 'client-id'), 'utf8'), 'pc-old-id');
    assert.strictEqual(fs2.readFileSync(p.join(newDir, 'config.json'), 'utf8'), '{"url":"ws://old"}');
    assert.ok(!fs2.existsSync(p.join(newDir, 'logs')));
  });
});

test('migrateLegacyConfigDir：新目录已存在则不动', () => {
  withTempHome((dir) => {
    const fs2 = require('fs');
    const p = require('path');
    const oldDir = path.join(os.homedir(), '.remotetype');
    fs2.mkdirSync(oldDir, { recursive: true });
    fs2.writeFileSync(p.join(oldDir, 'client-id'), 'pc-old');
    const newDir = p.join(dir, '.nx-rt');
    fs2.mkdirSync(newDir, { recursive: true });
    fs2.writeFileSync(p.join(newDir, 'client-id'), 'pc-new');
    const { migrateLegacyConfigDir } = require('../lib/config');
    assert.strictEqual(migrateLegacyConfigDir(newDir), false);
    assert.strictEqual(fs2.readFileSync(p.join(newDir, 'client-id'), 'utf8'), 'pc-new');
  });
});

test('migrateLegacyConfigDir：旧目录不存在返回 false 且不建新目录', () => {
  withTempHome((dir) => {
    const fs2 = require('fs');
    const p = require('path');
    const { migrateLegacyConfigDir } = require('../lib/config');
    const newDir = p.join(dir, '.nx-rt');
    assert.strictEqual(migrateLegacyConfigDir(newDir), false);
    assert.ok(!fs2.existsSync(newDir));
  });
});

test('platform.cacheDir：NX_RT_CACHE 优先，默认落在 ~/.nx-rt/binaries', () => {
  const platform = require('../lib/platform');
  const prevC = process.env.NX_RT_CACHE;
  const prevOld = process.env.REMOTETYPE_CACHE;
  try {
    process.env.NX_RT_CACHE = 'D:/tmp/cache-a';
    assert.strictEqual(platform.cacheDir(), path.join('D:/tmp/cache-a', 'binaries'));
    delete process.env.NX_RT_CACHE;
    delete process.env.REMOTETYPE_CACHE;
    const cachePath = platform.cacheDir();
    assert.strictEqual(path.basename(path.dirname(cachePath)), '.nx-rt');
    assert.strictEqual(path.basename(cachePath), 'binaries');
  } finally {
    if (prevC === undefined) delete process.env.NX_RT_CACHE; else process.env.NX_RT_CACHE = prevC;
    if (prevOld === undefined) delete process.env.REMOTETYPE_CACHE; else process.env.REMOTETYPE_CACHE = prevOld;
  }
});

// ==================== 统一登录：配置层 ====================

console.log('\n== 统一登录：config 层 ==');

test('httpBaseFromWs：ws/wss 同源推导，端口与协议都对', () => {
  const { httpBaseFromWs } = require('../lib/config');
  assert.strictEqual(httpBaseFromWs('ws://1.94.101.189:8790/ws'), 'http://1.94.101.189:8790');
  assert.strictEqual(httpBaseFromWs('wss://example.com/ws'), 'https://example.com');
  assert.strictEqual(httpBaseFromWs(''), null);
  assert.strictEqual(httpBaseFromWs('不是地址'), null);
});

test('内置默认服务地址必须是一个真能连的地址（不得是脚手架占位值）', () => {
  // 回归用例：默认值曾是 wss://remotetype.example.com/ws —— 一个永远不会解析的
  // RFC 2606 保留域。只有 `serve --url ...` 的年代它无害；README 把
  // `npx nx-rt auth login` 写成推荐用法后，零参数路径必然失败，
  // 而用户看到的是裸 getaddrinfo ENOTFOUND。真实用户在另一台机器上踩到了。
  const { DEFAULT_SERVE_URL, placeholderUrlReason, httpBaseFromWs } = require('../lib/config');
  assert.ok(placeholderUrlReason(DEFAULT_SERVE_URL) === null,
    `默认服务地址仍是占位值：${DEFAULT_SERVE_URL}`);
  assert.ok(!/example\.(com|net|org)|\.test$|\.invalid$/i.test(DEFAULT_SERVE_URL),
    '默认值不得落在保留域上');
  // 更要紧的是：默认值推导出的 HTTP 基址得是真的那台部署机（auth login 走 HTTP）
  assert.equal(httpBaseFromWs(DEFAULT_SERVE_URL), 'http://1.94.101.189:8790');
});

test('placeholderUrlReason 认出占位/保留域，但放过 localhost 与真实 IP', () => {
  const { placeholderUrlReason } = require('../lib/config');
  assert.ok(placeholderUrlReason('wss://remotetype.example.com/ws'), '老配置里的占位值必须被抓出');
  assert.ok(placeholderUrlReason('http://foo.test'), 'RFC 2606 保留 TLD');
  assert.ok(placeholderUrlReason('ws://a.example.com/ws'), '保留二级域');
  assert.ok(placeholderUrlReason(''), '空值');
  assert.ok(placeholderUrlReason('完全不是个地址'), '畸形值');
  // 这些是真能用的形态，一律放过
  assert.equal(placeholderUrlReason('ws://1.94.101.189:8790/ws'), null);
  assert.equal(placeholderUrlReason('ws://localhost:8790/ws'), null, '本机部署是合法用法');
  assert.equal(placeholderUrlReason('wss://rt.mydomain.com/ws'), null);
});

test('saveConnectionConfig → loadConfig：deviceToken/sessionKey/authUser 存了能读回', () => {
  withTempHome(() => {
    const { loadConfig, saveConnectionConfig } = require('../lib/config');
    const r = saveConnectionConfig({
      url: 'ws://1.94.101.189:8790/ws',
      deviceToken: 'dev.abc',
      sessionKey: 'SESSKEY1',
      deviceName: '书房电脑',
      authUser: { userId: 'u-1', email: 'a@b.c' },
    });
    assert.strictEqual(r.changed, true);
    const cfg = loadConfig({});
    assert.strictEqual(cfg.deviceToken, 'dev.abc');
    assert.strictEqual(cfg.sessionKey, 'SESSKEY1');
    assert.strictEqual(cfg.deviceName, '书房电脑');
    assert.deepStrictEqual(cfg.authUser, { userId: 'u-1', email: 'a@b.c' });
    // serverHttp 从 url 自动推导，用户不必填第二遍
    assert.strictEqual(cfg.serverHttp, 'http://1.94.101.189:8790');
  });
});

test('--key 覆盖存盘的 sessionKey（临时连老服务器不必先清配置）', () => {
  withTempHome(() => {
    const { loadConfig, saveConnectionConfig } = require('../lib/config');
    saveConnectionConfig({ sessionKey: 'SERVERKEY' });
    assert.strictEqual(loadConfig({ key: 'MANUAL' }).sessionKey, 'MANUAL');
    assert.strictEqual(loadConfig({}).sessionKey, 'SERVERKEY');
  });
});

test('sessionKey 回退到老的 alignKey：未登录用户保持旧行为', () => {
  withTempHome(() => {
    const { loadConfig, saveConnectionConfig } = require('../lib/config');
    saveConnectionConfig({ alignKey: 'LEGACYKEY' });
    const cfg = loadConfig({});
    assert.strictEqual(cfg.sessionKey, 'LEGACYKEY');
    assert.strictEqual(cfg.alignKey, 'LEGACYKEY');
    assert.strictEqual(cfg.deviceToken, null);
  });
});

test('clearAuthCredentials：只抹统一登录产物，alignKey/token 原样保留', () => {
  withTempHome(() => {
    const fs2 = require('fs');
    const { loadConfig, saveConnectionConfig, clearAuthCredentials, configFile } = require('../lib/config');
    saveConnectionConfig({
      alignKey: 'LEGACYKEY', token: 'RTTOKEN',
      deviceToken: 'dev.abc', sessionKey: 'SESSKEY1', authUser: { userId: 'u-1' },
    });
    assert.strictEqual(clearAuthCredentials().changed, true);
    const left = JSON.parse(fs2.readFileSync(configFile(), 'utf8'));
    assert.ok(!('deviceToken' in left));
    assert.ok(!('sessionKey' in left));
    assert.ok(!('authUser' in left));
    assert.strictEqual(left.alignKey, 'LEGACYKEY');
    assert.strictEqual(left.token, 'RTTOKEN');
    const cfg = loadConfig({});
    assert.strictEqual(cfg.deviceToken, null);
    assert.strictEqual(cfg.sessionKey, 'LEGACYKEY'); // 退回旧配对 key
    assert.strictEqual(clearAuthCredentials().changed, false); // 幂等
  });
});

// ==================== 统一登录：auth.js 参数构造 ====================

console.log('\n== 统一登录：auth.js ==');

test('createAuthRequest：发出的 state 就是回来要比对的 state', () => {
  // 回归用例：曾经 req.state 与 authorizeParams.state 是两个独立随机值，
  // 调用方先发后者、再拿前者比对 → 每次登录必然报「state 不一致」。
  const { createAuthRequest } = require('../lib/auth');
  const req = createAuthRequest('http://127.0.0.1:9/callback');
  assert.strictEqual(req.authorizeParams.state, req.state);
  assert.strictEqual(req.authorizeParams.redirect_uri, 'http://127.0.0.1:9/callback');
  assert.strictEqual(req.authorizeParams.code_challenge_method, 'S256');
  // PKCE 契约：challenge 必须是 verifier 的 SHA-256（base64url 无填充）
  const crypto = require('crypto');
  const expect = crypto.createHash('sha256').update(req.verifier).digest()
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(req.authorizeParams.code_challenge, expect);
});

test('createAuthRequest：每次调用 verifier/state 都不同（不可预测）', () => {
  const { createAuthRequest } = require('../lib/auth');
  const a = createAuthRequest('http://127.0.0.1:1/cb');
  const b = createAuthRequest('http://127.0.0.1:1/cb');
  assert.notStrictEqual(a.verifier, b.verifier);
  assert.notStrictEqual(a.state, b.state);
});

test('openBrowserArgs：Windows 路径不得借道 cmd / start（URL 里的 & 会被切）', () => {
  // 回归用例：早期走 `cmd /c start <url>` 时，cmd.exe 把 & 当命令分隔符，
  // 浏览器只收到 ?client_id=mn-rt 就报 redirect_uri 不在白名单。
  // 这条断言钉死：Windows 路径必须直接交给一个不解析 & 的二进制。
  const { openBrowserArgs } = require('../lib/auth');
  const [cmd, args] = openBrowserArgs('win32',
    'http://47.110.80.47:8082/oauth2/auth?client_id=mn-rt&scope=openid+profile+email&state=xyz');
  assert.notStrictEqual(cmd, 'cmd', 'Windows 绝不能再走 cmd');
  assert.strictEqual(cmd, 'rundll32');
  // URL 原文（含 &）必须作为单一参数原样传出去：
  assert.deepStrictEqual(args, ['url.dll,FileProtocolHandler',
    'http://47.110.80.47:8082/oauth2/auth?client_id=mn-rt&scope=openid+profile+email&state=xyz']);
});

// ==================== 统一登录：register 帧 ====================

console.log('\n== 统一登录：ws-client register 帧 ==');

/** 假 WebSocket：记录发出的帧，允许测试主动推 message / 触发 close。 */
function fakeWs() {
  const sent = [];
  const handlers = {};
  const inst = {
    readyState: 1, // OPEN
    sent,
    on(name, fn) { handlers[name] = fn; },
    send(data) { sent.push(JSON.parse(data)); },
    ping() {},
    close() {},
    emit(name, ...args) { return handlers[name] && handlers[name](...args); },
    frameCount: 0,
  };
  function WebSocketImpl(url, opts) {
    WebSocketImpl.instance = inst;
    inst.url = url;
    inst.opts = opts;
    return inst;
  }
  WebSocketImpl.OPEN = 1;
  return WebSocketImpl;
}

test('register 帧携带 deviceToken / deviceName / sessionKey', () => {
  const { ServeClient } = require('../lib/ws-client');
  const WebSocketImpl = fakeWs();
  const c = new ServeClient({
    url: 'ws://h/ws', clientId: 'pc-1', logger: null, WebSocketImpl,
    deviceToken: 'dev.abc', deviceName: '书房电脑', sessionKey: 'SESSKEY1',
  });
  c.connect();
  WebSocketImpl.instance.emit('open');
  const reg = WebSocketImpl.instance.sent[0];
  assert.strictEqual(reg.type, 'register');
  assert.strictEqual(reg.role, 'pc');
  assert.strictEqual(reg.clientId, 'pc-1');
  assert.strictEqual(reg.deviceToken, 'dev.abc');
  assert.strictEqual(reg.deviceName, '书房电脑');
  assert.strictEqual(reg.sessionKey, 'SESSKEY1');
  c.close();
});

test('未登录时 register 帧不出现这三个字段（老服务器收到的报文与旧版逐字一致）', () => {
  const { ServeClient } = require('../lib/ws-client');
  const WebSocketImpl = fakeWs();
  const c = new ServeClient({ url: 'ws://h/ws', clientId: 'pc-1', WebSocketImpl });
  c.connect();
  WebSocketImpl.instance.emit('open');
  const reg = WebSocketImpl.instance.sent[0];
  assert.ok(!('deviceToken' in reg), `不该有 deviceToken: ${JSON.stringify(reg)}`);
  assert.ok(!('deviceName' in reg), '不该有 deviceName');
  assert.ok(!('sessionKey' in reg), '不该有 sessionKey');
  assert.ok(!('token' in reg), '不该有 token');
  c.close();
});

test('服务端下发 sessionKey → 采纳、上抛事件；回同样的值不重复上抛', () => {
  const { ServeClient } = require('../lib/ws-client');
  const WebSocketImpl = fakeWs();
  const c = new ServeClient({
    url: 'ws://h/ws', clientId: 'pc-1', WebSocketImpl, deviceToken: 'dev.abc', sessionKey: 'OLD',
  });
  const got = [];
  c.on('session-key', (k) => got.push(k));
  c.connect();
  WebSocketImpl.instance.emit('open');
  WebSocketImpl.instance.emit('message', JSON.stringify({ type: 'registered', role: 'pc', clientId: 'pc-1', sessionKey: 'NEW' }));
  assert.deepStrictEqual(got, ['NEW']);
  assert.strictEqual(c.sessionKey, 'NEW');
  // 重连时服务端回同一把：不该再触发一次落盘
  WebSocketImpl.instance.emit('message', JSON.stringify({ type: 'registered', role: 'pc', clientId: 'pc-1', sessionKey: 'NEW' }));
  assert.deepStrictEqual(got, ['NEW']);
  c.close();
});

test('close 4401（要求统一登录）停止重连并上抛 auth-rejected', () => {
  const { ServeClient } = require('../lib/ws-client');
  const WebSocketImpl = fakeWs();
  const c = new ServeClient({ url: 'ws://h/ws', clientId: 'pc-1', WebSocketImpl });
  let rejected = null;
  c.on('auth-rejected', (e) => { rejected = e; });
  c.connect();
  WebSocketImpl.instance.emit('open');
  WebSocketImpl.instance.emit('close', 4401, 'auth required');
  assert.ok(rejected, '应上抛 auth-rejected');
  assert.strictEqual(rejected.code, 4401);
  assert.strictEqual(c.reconnectTimer, null, '不该安排重连');
  c.close();
});

test('普通断线（1006）仍然安排重连——不能把 4401 的逻辑误扩大', () => {
  const { ServeClient } = require('../lib/ws-client');
  const WebSocketImpl = fakeWs();
  const c = new ServeClient({ url: 'ws://h/ws', clientId: 'pc-1', baseBackoffMs: 50, WebSocketImpl });
  let rejected = false;
  c.on('auth-rejected', () => { rejected = true; });
  c.connect();
  WebSocketImpl.instance.emit('open');
  WebSocketImpl.instance.emit('close', 1006, '');
  assert.strictEqual(rejected, false);
  assert.ok(c.reconnectTimer, '普通断线必须重连');
  c.close();
});

// ==================== 统一登录：会话密钥热切换 ====================

console.log('\n== 统一登录：rt-align setKey ==');

test('setKey 后新密钥能解、旧密钥的信封解不开', () => {
  const { RtAlignSession } = require('../lib/rt-align');
  const rtCrypto = require('../lib/rt-crypto');
  const kA = rtCrypto.generateKey();
  const kB = rtCrypto.generateKey();
  const a = new RtAlignSession({ key: kA, sendAck: () => {} });
  // AAD 里的 room 来自派生结果，不是随便一个标签——必须按 kB 派生出来的 room 封，
  // 否则这条测试会因为 AAD 不匹配而"假通过"（看起来验证了密钥，其实验证了别的）
  const dB = rtCrypto.deriveFromKey(kB);
  const env = rtCrypto.seal(dB.keyPhoneToPc, rtCrypto.buildAad(dB.room, 'p2c', 1), { text: 'hi' });
  const feed = (sid) => a.handleIncoming(JSON.stringify({ ...env, sid, seq: 1 }));

  feed('s1');
  assert.strictEqual(a.stats.envelopesBad, 1, 'kB 的信封在 kA 会话下必须解不开');
  assert.strictEqual(a.stats.envelopesOk, 0);

  assert.strictEqual(a.setKey(kB), true);
  feed('s2');
  assert.strictEqual(a.stats.envelopesOk, 1, '切换后同一个信封必须可解');
  assert.strictEqual(a.setKey(kB), false, '同值不该重复切换');
  a.dispose();
});

test('setKey 只换密钥、不清同步状态（换 key 不得导致已注入内容重打）', () => {
  const { RtAlignSession } = require('../lib/rt-align');
  const rtCrypto = require('../lib/rt-crypto');
  const k = rtCrypto.generateKey();
  const a = new RtAlignSession({ key: k, sendAck: () => {} });
  const d = rtCrypto.deriveFromKey(k);
  const env = rtCrypto.seal(d.keyPhoneToPc, rtCrypto.buildAad(d.room, 'p2c', 7), { text: '已有内容', phoneId: 'p1' });
  a.handleIncoming(JSON.stringify({ ...env, sid: 'sa', seq: 7 }));
  assert.strictEqual(a.desiredSeq, 7);
  a.setKey(rtCrypto.generateKey());
  assert.strictEqual(a.desiredSeq, 7, '换 key 后 desiredSeq 必须保持');
  assert.strictEqual(a.mirror, '', 'mirror 也不该被动过');
  a.dispose();
});

// ==================== 模块可加载性 ====================

console.log('\n== 每个 lib 模块都必须能加载 ==');

/**
 * 这条用例看起来像废话，但它抓到过一次真实事故：往块注释里写回环通配地址
 * （形如 "星号 + 斜杠"）会把注释提前闭合，文件后半段变成代码 —— 语法错。
 * 如果只靠间接引用去发现，报出来的将是某个八竿子打不着的断言失败
 * （"createAuthRequest 的 state 不对"），排查方向整个错掉。
 * 让"文件解析不了"直接以文件名的形式失败在这里。
 */
test('lib/*.js 全部可 require（语法与依赖完整）', () => {
  const fs2 = require('fs');
  const dir = path.join(__dirname, '..', 'lib');
  const files = fs2.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 8, `lib 下文件数异常：${files.length}`);
  for (const f of files) {
    try {
      require(path.join(dir, f));
    } catch (e) {
      throw new Error(`${f} 加载失败：${e.message}`);
    }
  }
});

test('bin/index.js 语法可解析（不能 require，它会直接跑 main）', () => {
  const { execFileSync } = require('child_process');
  const file = path.join(__dirname, '..', 'bin', 'index.js');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`bin/index.js 语法错误：${e.stderr ? e.stderr.toString() : e.message}`);
  }
});

// ==================== 多账号：accounts.js 纯逻辑 ====================

console.log('\n== accounts：多账号账号簿 ==');

const accountsLib = require('../lib/accounts');

test('accountKey：忽略尾斜杠，部署 + userId 拼成唯一键', () => {
  assert.strictEqual(accountsLib.normalizeServerHttp('http://h:8790///'), 'http://h:8790');
  assert.strictEqual(accountsLib.normalizeServerHttp('  http://h:8790 '), 'http://h:8790');
  assert.strictEqual(accountsLib.accountKey('http://h:8790/', 'u-1'), 'http://h:8790::u-1');
  assert.notStrictEqual(
    accountsLib.accountKey('http://h:8791', 'u-1'),
    accountsLib.accountKey('http://h:8790', 'u-1'),
    '不同部署上的同一 userId 必须是两个互不覆盖的账号',
  );
});

test('withAccounts：空配置 → 空表；legacy flat 凭据 → 合成首条目', () => {
  assert.deepStrictEqual(accountsLib.withAccounts({}), { accounts: {}, activeAccountKey: null });
  assert.deepStrictEqual(accountsLib.withAccounts(undefined).accounts, {});

  const legacy = {
    url: 'ws://h:8790/ws',
    serverHttp: 'http://h:8790',
    deviceToken: 'dev.abc',
    sessionKey: 'S1',
    deviceName: '书房电脑',
    authUser: { userId: 'u-1', email: 'a@x.com', loginAt: 1, expiresAt: 2 },
  };
  const v = accountsLib.withAccounts(legacy, { defaultClientId: 'pc-machine' });
  assert.deepStrictEqual(Object.keys(v.accounts), ['http://h:8790::u-1']);
  assert.strictEqual(v.activeAccountKey, 'http://h:8790::u-1', '迁移出来的唯一条目就是当前账号');
  const e = v.accounts['http://h:8790::u-1'];
  assert.strictEqual(e.clientId, 'pc-machine');
  assert.strictEqual(e.expiresAt, 2);
  assert.strictEqual(e.sessionKey, 'S1');
});

test('withAccounts：flat 里有 clientId 时优先用它（保住既有绑定）', () => {
  const v = accountsLib.withAccounts({
    serverHttp: 'http://h',
    deviceToken: 'd',
    clientId: 'pc-handwritten',
    authUser: { userId: 'u-1' },
  }, { defaultClientId: 'pc-machine' });
  assert.strictEqual(Object.values(v.accounts)[0].clientId, 'pc-handwritten');
});

test('withAccounts：已迁移则原样返回，畸形条目被丢弃', () => {
  const raw = {
    activeAccount: 'http://h::u-2',
    accounts: {
      'http://h::u-1': { userId: 'u-1', deviceToken: 'd1' },
      'http://h::u-2': { userId: 'u-2', deviceToken: 'd2' },
      'http://h::u-3': { userId: 'u-3' }, // 没有 deviceToken
      'http://h::u-4': null,
    },
  };
  const v = accountsLib.withAccounts(raw);
  assert.deepStrictEqual(Object.keys(v.accounts).sort(), ['http://h::u-1', 'http://h::u-2']);
  assert.strictEqual(v.activeAccountKey, 'http://h::u-2');
  // 幂等：再跑一次结果不变
  assert.deepStrictEqual(
    accountsLib.withAccounts({ ...raw, accounts: v.accounts }).accounts,
    v.accounts,
  );
});

test('withAccounts：指针指向不存在的条目 → 视为未激活（不猜）', () => {
  const v = accountsLib.withAccounts({
    activeAccount: 'http://h::gone',
    accounts: { 'http://h::u-1': { userId: 'u-1', deviceToken: 'd1' } },
  });
  assert.strictEqual(v.activeAccountKey, null,
    '只剩一个条目也不能自动激活——logout 之后必须如实显示"未登录"');
});

test('listAccounts：按 key 升序（序号匹配与展示共用同一顺序）', () => {
  const v = accountsLib.withAccounts({
    accounts: {
      'http://h::u-c': { userId: 'u-c', deviceToken: 'd' },
      'http://a::u-a': { userId: 'u-a', deviceToken: 'd' },
      'http://h::u-b': { userId: 'u-b', deviceToken: 'd' },
    },
  });
  assert.deepStrictEqual(
    accountsLib.listAccounts(v).map((a) => a.key),
    ['http://a::u-a', 'http://h::u-b', 'http://h::u-c'],
  );
});

/** 两个账号的配置：alice（激活）+ bob。 */
function twoAccountsRaw() {
  return {
    activeAccount: 'http://h::u-alice',
    accounts: {
      'http://h::u-alice': {
        userId: 'u-alice', email: 'alice@x.com', nickname: 'Alice', deviceToken: 'dA',
        sessionKey: 'KA', clientId: 'pc-a', serverHttp: 'http://h', url: 'ws://h/ws',
      },
      'http://h::u-bob': {
        userId: 'u-bob', email: 'bob@y.com', username: 'bobby', deviceToken: 'dB',
        sessionKey: 'KB', clientId: 'pc-b', serverHttp: 'http://h', url: 'ws://h/ws',
      },
    },
  };
}

test('resolveAccountEntry：完整 key / userId / 邮箱（忽略大小写）/ 昵称子串 / 序号', () => {
  const raw = twoAccountsRaw();
  assert.strictEqual(accountsLib.resolveAccountEntry(raw, 'http://h::u-alice').entry.userId, 'u-alice');
  assert.strictEqual(accountsLib.resolveAccountEntry(raw, 'u-bob').entry.userId, 'u-bob');
  assert.strictEqual(accountsLib.resolveAccountEntry(raw, 'ALICE@X.COM').entry.userId, 'u-alice');
  assert.strictEqual(accountsLib.resolveAccountEntry(raw, 'obb').entry.userId, 'u-bob');
  assert.strictEqual(accountsLib.resolveAccountEntry(raw, '1').entry.userId, 'u-alice');
  assert.strictEqual(accountsLib.resolveAccountEntry(raw, '2').entry.userId, 'u-bob');
});

test('resolveAccountEntry：歧义 / 未命中 / 越界都抛错，且错误信息带候选清单', () => {
  const raw = twoAccountsRaw();
  assert.throws(() => accountsLib.resolveAccountEntry(raw, 'com'), /匹配到多个账号/);
  assert.throws(() => accountsLib.resolveAccountEntry(raw, 'nobody'), /找不到账号/);
  assert.throws(() => accountsLib.resolveAccountEntry(raw, '9'), /超出范围/);
  assert.throws(() => accountsLib.resolveAccountEntry(raw, ''), /未指定账号/);
  assert.throws(() => accountsLib.resolveAccountEntry({}, 'x'), /还没有已存账号/);
  try {
    accountsLib.resolveAccountEntry(raw, 'nobody');
  } catch (e) {
    assert.ok(e.message.includes('alice@x.com') && e.message.includes('bob@y.com'),
      '报错必须把可选账号列出来，否则用户不知道该填什么');
  }
});

test('buildFlatSyncPatch：含 clientId（系铃处），身份快照走 authUser.expiresAt', () => {
  const patch = accountsLib.buildFlatSyncPatch({
    userId: 'u-1', email: 'a@x.com', deviceToken: 'd', sessionKey: 'K',
    clientId: 'pc-1', serverHttp: 'http://h/', url: 'ws://h/ws', deviceName: '书房电脑',
    loginAt: 5, expiresAt: 9,
  });
  assert.strictEqual(patch.clientId, 'pc-1', '不写 clientId → serve 会退回机器默认 id → 4401');
  assert.strictEqual(patch.serverHttp, 'http://h');
  assert.deepStrictEqual(patch.authUser, {
    userId: 'u-1', email: 'a@x.com', username: '', nickname: '', loginAt: 5, expiresAt: 9,
  });
  // 空字段不下发：绝不把 flat 里已有的值抹白
  const thin = accountsLib.buildFlatSyncPatch({ userId: 'u-2', deviceToken: 'd2' });
  assert.ok(!('sessionKey' in thin) && !('clientId' in thin) && !('url' in thin));
});

test('planLoginClientId：五个分支——机器默认 / 沿用 / 领新 / 显式 / 403 兜底', () => {
  const mk = (uid, cid, name) => ({
    userId: uid, deviceToken: 'd', clientId: cid, deviceName: name || '', serverHttp: 'http://h',
  });
  const empty = accountsLib.withAccounts({});
  const one = accountsLib.withAccounts({
    accounts: { 'http://h::u-a': mk('u-a', 'pc-a', '书房电脑') },
  });
  const two = accountsLib.withAccounts({
    accounts: {
      'http://h::u-a': mk('u-a', 'pc-a', '书房电脑'),
      'http://h::u-b': mk('u-b', 'pc-b', '笔记本'),
    },
  });
  // 确定性生成器：既能看到它避开了哪些 id，也能断言结果与已存账号不撞车
  const gen = (taken) => {
    for (let i = 0; ; i += 1) {
      const id = `pc-gen${i}`;
      if (!taken.has(id)) return id;
    }
  };
  const base = {
    serverHttp: 'http://h', machineClientId: 'pc-machine', deviceName: '书房电脑', generate: gen,
  };

  // ① 机器上还没有任何账号 → 机器默认标识（首次登录的既有行为），并允许 403 兜底
  const first = accountsLib.planLoginClientId(empty, { userId: 'u-a' }, base);
  assert.strictEqual(first.clientId, 'pc-machine');
  assert.strictEqual(first.reason, 'machine');
  assert.strictEqual(first.retryOnOwnedByOther, true, '机器默认标识可能早已被别人登记，要留一次兜底');

  // ② 同账号重登 → 沿用原标识与原设备名（只换令牌，绑定与会话密钥不变）
  const again = accountsLib.planLoginClientId(one, { userId: 'u-a' }, { ...base, deviceName: 'hostname' });
  assert.strictEqual(again.clientId, 'pc-a');
  assert.strictEqual(again.deviceName, '书房电脑', '条目里存的名字优先，手机端看着不变');
  assert.strictEqual(again.reason, 'reuse');
  assert.strictEqual(again.retryOnOwnedByOther, false, '复用路径撞 403 必须如实报错，不许自己换 id');

  // ②b 显式 --device-name 覆盖条目里的名字
  const renamed = accountsLib.planLoginClientId(one, { userId: 'u-a' }, {
    ...base, deviceName: '客厅电脑', explicitDeviceName: true,
  });
  assert.strictEqual(renamed.deviceName, '客厅电脑');

  // ③ 本机已有别的账号 → 领新标识，且避开已用过的
  const second = accountsLib.planLoginClientId(one, { userId: 'u-b' }, base);
  assert.strictEqual(second.reason, 'fresh');
  assert.notStrictEqual(second.clientId, 'pc-a');
  const third = accountsLib.planLoginClientId(two, { userId: 'u-c' }, base);
  assert.ok(!['pc-a', 'pc-b'].includes(third.clientId), '新标识不得与已存账号撞车');
  assert.strictEqual(third.retryOnOwnedByOther, false);

  // ④ 显式 --client-id 最高优先
  const explicit = accountsLib.planLoginClientId(two, { userId: 'u-c' }, { ...base, explicitClientId: 'pc-fixed' });
  assert.strictEqual(explicit.clientId, 'pc-fixed');
  assert.strictEqual(explicit.reason, 'explicit');

  // ⑤ 403 兜底：机器默认标识已被别人登记 → 换新标识，且不再重试
  const retry = accountsLib.planLoginClientId(empty, { userId: 'u-a' }, {
    ...base, prevErr: Object.assign(new Error('device_owned_by_other'), { code: 'device_owned_by_other' }),
  });
  assert.strictEqual(retry.reason, 'retry');
  assert.notStrictEqual(retry.clientId, 'pc-machine');
  assert.strictEqual(retry.retryOnOwnedByOther, false, '兜底只许用一次，第二次仍 403 就如实报错');
});

test('resolveAccountEntry：纯数字一律当序号，不被邮箱里的数字截胡', () => {
  // 回归：序号分支曾经排在子串匹配之后，于是 auth switch 2 会被
  // alice2@x.com 里的 "2" 命中，把用户切到**另一个**账号——选择器回传的正是数字串。
  const raw = accountsLib.withAccounts({
    accounts: {
      'http://h::u-1': { userId: 'u-1', email: 'alice2@x.com', deviceToken: 'd1' },
      'http://h::u-2': { userId: 'u-2', email: 'bob@y.com', deviceToken: 'd2' },
    },
  });
  assert.strictEqual(accountsLib.resolveAccountEntry(raw, '2').entry.userId, 'u-2',
    '输入 2 必须是列表里的第 2 个，而不是邮箱里含 2 的那个');
  assert.strictEqual(accountsLib.resolveAccountEntry(raw, '1').entry.userId, 'u-1');
  assert.throws(() => accountsLib.resolveAccountEntry(raw, '7'), /超出范围/);
  // 非纯数字才走子串
  assert.strictEqual(accountsLib.resolveAccountEntry(raw, 'alice2').entry.userId, 'u-1');
});

test('saveAuthAccount：老配置（无 flat clientId）迁移时用机器默认标识，绝不蹭新账号的', () => {
  // 回归（严重）：0.5.x 的 config.json 里**没有** clientId（那时 saveConnectionConfig
  // 根本不写它）。迁移时若拿"本次登录账号的 clientId"播种，两个账号会共用同一个标识，
  // 老账号此后既登不回来（服务端 403），切过去也注册不上（4401）。
  withTempHome(() => {
    const { saveAuthAccount, readConfigFile, ensureClientId } = require('../lib/config');
    const machineId = ensureClientId();
    fs.writeFileSync(require('../lib/config').configFile(), JSON.stringify({
      url: 'ws://h:8790/ws', serverHttp: 'http://h:8790',
      deviceToken: 'dev.old', sessionKey: 'SKOLD', deviceName: '书房电脑',
      authUser: { userId: 'u-old', email: 'old@x.com', expiresAt: 1, loginAt: 1 },
      // 注意：**没有** clientId —— 这才是真实的老配置
    }));

    const r = saveAuthAccount({
      entry: {
        userId: 'u-new', deviceToken: 'dev.new', serverHttp: 'http://h:8790',
        clientId: 'pc-bob', sessionKey: 'SKNEW', loginAt: 2,
      },
      setActive: true,
    });
    const raw = readConfigFile();
    assert.strictEqual(raw.accounts['http://h:8790::u-old'].clientId, machineId,
      '老账号的标识必须是机器默认标识（它当年就是用它绑定的）');
    assert.strictEqual(raw.accounts[r.key].clientId, 'pc-bob');
    assert.notStrictEqual(raw.accounts['http://h:8790::u-old'].clientId,
      raw.accounts[r.key].clientId, '两个账号绝不能共用标识');
  });
});

test('saveConnectionConfig：老配置只写 flat，不凭空生成账号表（行为与升级前一致）', () => {
  withTempHome(() => {
    const { saveConnectionConfig, readConfigFile, loadConfig, configFile } = require('../lib/config');
    fs.writeFileSync(configFile(), JSON.stringify({
      url: 'ws://h:8790/ws', serverHttp: 'http://h:8790',
      deviceToken: 'dev.old', sessionKey: 'SKOLD',
      authUser: { userId: 'u-old', email: 'old@x.com' },
      // 老配置：没有 clientId、没有 accounts
    }));
    const before = { ...readConfigFile() };

    // 模拟 serve 连上后的回写（registered / 会话密钥两处都是这个形状）
    saveConnectionConfig({
      url: 'ws://h:8790/ws', deviceToken: 'dev.old', sessionKey: 'SK-NEW',
      deviceName: 'hostname', serverHttp: 'http://h:8790',
    });

    const raw = readConfigFile();
    assert.strictEqual(raw.accounts, undefined, '老配置不该被悄悄升级成账号表');
    assert.strictEqual(raw.activeAccount, undefined);
    assert.strictEqual(raw.sessionKey, 'SK-NEW');
    assert.strictEqual(raw.alignKey, before.alignKey);
    assert.strictEqual(loadConfig({}).clientId.length > 0, true);
  });
});

test('迁移后的老账号 clientId 非空：switch 过去不会带上前一个账号的标识', () => {
  withTempHome(() => {
    const {
      saveAuthAccount, switchActiveAccount, saveConnectionConfig,
      readConfigFile, loadConfig, ensureClientId, configFile,
    } = require('../lib/config');
    const machineId = ensureClientId();
    fs.writeFileSync(configFile(), JSON.stringify({
      url: 'ws://h:8790/ws', serverHttp: 'http://h:8790',
      deviceToken: 'dev.old', sessionKey: 'SKOLD',
      authUser: { userId: 'u-old', email: 'old@x.com' },
    }));
    // 老账号先跑一次 serve 回写（此时还没有账号表）
    saveConnectionConfig({ url: 'ws://h:8790/ws', sessionKey: 'SKOLD' });
    // 第二个人登录 → 迁移 + 新条目
    saveAuthAccount({
      entry: {
        userId: 'u-new', deviceToken: 'dev.new', serverHttp: 'http://h:8790',
        clientId: 'pc-bob', sessionKey: 'SKNEW', loginAt: 2,
      },
      setActive: true,
    });
    // 切回老账号：flat 的 clientId 必须是老账号自己的，不能留着 pc-bob
    const r = switchActiveAccount('old@x.com', { defaultClientId: machineId });
    assert.strictEqual(r.entry.clientId, machineId);
    const raw = readConfigFile();
    assert.strictEqual(raw.clientId, machineId);
    assert.strictEqual(raw.deviceToken, 'dev.old');
    const cfg = loadConfig({});
    assert.strictEqual(cfg.clientId, machineId);
    assert.strictEqual(cfg.deviceToken, 'dev.old', '令牌与标识必须成对，否则 register 直接 4401');
  });
});

test('手改坏的条目：读的时候被忽略，写的时候原样保留（不替用户删数据）', () => {
  withTempHome(() => {
    const { saveAuthAccount, readConfigFile, configFile } = require('../lib/config');
    fs.writeFileSync(configFile(), JSON.stringify({
      accounts: {
        'http://h::u-ok': { userId: 'u-ok', deviceToken: 'd-ok', clientId: 'pc-ok', serverHttp: 'http://h' },
        'http://h::u-broken': { userId: 'u-broken', note: '手改留下的半截条目' },
      },
      activeAccount: 'http://h::u-ok',
    }));
    const list = accountsLib.listAccounts(accountsLib.withAccounts(readConfigFile(), {}));
    assert.deepStrictEqual(list.map((a) => a.key), ['http://h::u-ok'], '读的时候跳过不可用条目');

    saveAuthAccount({
      entry: { userId: 'u-new', deviceToken: 'd-new', clientId: 'pc-new', serverHttp: 'http://h' },
      setActive: true,
    });
    const raw = readConfigFile();
    assert.ok(raw.accounts['http://h::u-broken'], '写的时候不能因为我们看不懂就删掉它');
    assert.strictEqual(raw.accounts['http://h::u-broken'].note, '手改留下的半截条目');
  });
});

test('isExpired：按 expiresAt 判定，缺字段视为未知（不算过期）', () => {
  assert.strictEqual(accountsLib.isExpired({ expiresAt: Date.now() + 1000 }), false);
  assert.strictEqual(accountsLib.isExpired({ expiresAt: Date.now() - 1000 }), true);
  assert.strictEqual(accountsLib.isExpired({}), false);
});

// ==================== 多账号：config.js 落盘 ====================

console.log('\n== 多账号：config.js 账号簿落盘 ==');

test('generateClientId：格式与 ensureClientId 一致，且能避让已用过的 id', () => {
  const { generateClientId } = require('../lib/config');
  const id = generateClientId();
  assert.ok(/^[a-z0-9-]{1,20}-[a-z0-9]{6}$/.test(id), `clientId 格式异常：${id}`);

  const seen = new Set();
  for (let i = 0; i < 50; i += 1) seen.add(generateClientId());
  assert.ok(seen.size >= 45, `随机性不足（50 次只出了 ${seen.size} 个）`);

  const taken = new Set();
  for (let i = 0; i < 30; i += 1) {
    const fresh = generateClientId(taken);
    assert.ok(!taken.has(fresh), 'exclude 里的 id 不得再被生成');
    taken.add(fresh);
  }
});

test('saveAuthAccount：首个账号写条目 + 指针 + flat 镜像（含 clientId）', () => {
  withTempHome(() => {
    const { saveAuthAccount, readConfigFile, loadConfig } = require('../lib/config');
    const entry = {
      userId: 'u-1', email: 'a@x.com', username: 'a', nickname: 'Alice',
      deviceToken: 'dev.a', expiresAt: Date.now() + 100000, sessionKey: 'SK1',
      serverHttp: 'http://h:8790', url: 'ws://h:8790/ws', deviceName: '书房电脑',
      clientId: 'pc-aaa111', loginAt: 111,
    };
    const r = saveAuthAccount({ entry, setActive: true });
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.key, 'http://h:8790::u-1');

    const raw = readConfigFile();
    assert.strictEqual(raw.activeAccount, r.key);
    assert.strictEqual(raw.deviceToken, 'dev.a');
    assert.strictEqual(raw.clientId, 'pc-aaa111');
    assert.strictEqual(raw.authUser.userId, 'u-1');
    assert.strictEqual(raw.authUser.expiresAt, entry.expiresAt);
    // flat 必须就是 loadConfig 看到的东西
    assert.strictEqual(loadConfig({}).clientId, 'pc-aaa111');
  });
});

test('saveAuthAccount：第二个账号不挤掉第一个（惰性迁移 + 各自独立 clientId）', () => {
  withTempHome(() => {
    const { saveAuthAccount, readConfigFile, configFile } = require('../lib/config');
    // 先摆一份 0.5.x 风格的老配置：只有 flat 凭据，没有 accounts 表
    fs.writeFileSync(configFile(), JSON.stringify({
      url: 'ws://h:8790/ws', serverHttp: 'http://h:8790', clientId: 'pc-old',
      deviceToken: 'dev.old', sessionKey: 'SKOLD', deviceName: '书房电脑',
      authUser: { userId: 'u-old', email: 'old@x.com', expiresAt: 1, loginAt: 1 },
      alignKey: 'LEGACY', token: 'RTTOKEN',
    }));

    const r = saveAuthAccount({
      entry: {
        userId: 'u-new', email: 'new@x.com', deviceToken: 'dev.new', sessionKey: 'SKNEW',
        serverHttp: 'http://h:8790', url: 'ws://h:8790/ws', clientId: 'pc-new',
        expiresAt: 2, loginAt: 2,
      },
      setActive: true,
    });

    const raw = readConfigFile();
    assert.deepStrictEqual(Object.keys(raw.accounts).sort(),
      ['http://h:8790::u-new', 'http://h:8790::u-old']);
    assert.strictEqual(raw.activeAccount, r.key);
    assert.strictEqual(raw.deviceToken, 'dev.new'); // flat 跟着新账号走
    assert.strictEqual(raw.clientId, 'pc-new');
    // 老账号原样留着：绑定与标识都没被挤掉，切回去还是原来那台"电脑"
    assert.strictEqual(raw.accounts['http://h:8790::u-old'].deviceToken, 'dev.old');
    assert.strictEqual(raw.accounts['http://h:8790::u-old'].clientId, 'pc-old');
    assert.strictEqual(raw.accounts['http://h:8790::u-old'].sessionKey, 'SKOLD');
    // 老的 --key / RT_TOKEN 路径不受影响
    assert.strictEqual(raw.alignKey, 'LEGACY');
    assert.strictEqual(raw.token, 'RTTOKEN');
  });
});

test('saveAuthAccount：同账号重登不新增条目，clientId 不变', () => {
  withTempHome(() => {
    const { saveAuthAccount, readConfigFile } = require('../lib/config');
    const base = {
      userId: 'u-1', deviceToken: 'd1', serverHttp: 'http://h',
      clientId: 'pc-1', deviceName: '书房电脑',
    };
    saveAuthAccount({ entry: { ...base, loginAt: 1 } });
    const r2 = saveAuthAccount({ entry: { ...base, deviceToken: 'd2', loginAt: 2 } });
    const raw = readConfigFile();
    assert.strictEqual(Object.keys(raw.accounts).length, 1, '重登不得新增条目');
    assert.strictEqual(raw.accounts[r2.key].deviceToken, 'd2');
    assert.strictEqual(raw.accounts[r2.key].clientId, 'pc-1');
  });
});

test('switchActiveAccount：flat 全量镜像目标账号（含 url / serverHttp / clientId）', () => {
  withTempHome(() => {
    const {
      saveAuthAccount, switchActiveAccount, readConfigFile, loadConfig, configFile,
    } = require('../lib/config');
    const exp = Date.now() + 100000;
    saveAuthAccount({
      entry: {
        userId: 'u-a', email: 'a@x.com', deviceToken: 'dA', sessionKey: 'KA', clientId: 'pc-a',
        serverHttp: 'http://h1', url: 'ws://h1/ws', deviceName: 'AlicePC',
        expiresAt: exp, loginAt: 1,
      },
    });
    saveAuthAccount({
      entry: {
        userId: 'u-b', email: 'b@x.com', deviceToken: 'dB', sessionKey: 'KB', clientId: 'pc-b',
        serverHttp: 'http://h2', url: 'ws://h2/ws', deviceName: 'BobPC',
        expiresAt: exp, loginAt: 2,
      },
    });
    assert.strictEqual(loadConfig({}).clientId, 'pc-b', '后登录的账号成为当前账号');

    const r = switchActiveAccount('a@x.com', { defaultClientId: 'pc-machine' });
    assert.strictEqual(r.key, 'http://h1::u-a');
    const raw = readConfigFile();
    assert.strictEqual(raw.deviceToken, 'dA');
    assert.strictEqual(raw.sessionKey, 'KA');
    assert.strictEqual(raw.clientId, 'pc-a');
    assert.strictEqual(raw.serverHttp, 'http://h1'); // 跨部署切换必须一起走，否则拿 A 的令牌连 B
    assert.strictEqual(raw.url, 'ws://h1/ws');
    assert.strictEqual(raw.deviceName, 'AlicePC');
    assert.strictEqual(raw.authUser.email, 'a@x.com');

    // 系铃处回归：切换后 loadConfig 必须给出目标账号的 clientId，
    // 否则 WS register 的 token cid 与上报 clientId 对不上 → 4401
    const cfg = loadConfig({});
    assert.strictEqual(cfg.clientId, 'pc-a');
    assert.strictEqual(cfg.deviceToken, 'dA');

    assert.throws(() => switchActiveAccount('nobody@x.com'), /找不到账号/);
    const leftovers = fs.readdirSync(path.dirname(configFile())).filter((f) => f.includes('.tmp'));
    assert.deepStrictEqual(leftovers, [], '原子写不得留下 .tmp 残留');
  });
});

test('clearAuthCredentials：默认只清当前账号（其余留着），--all 清空，幂等', () => {
  withTempHome(() => {
    const { saveAuthAccount, clearAuthCredentials, readConfigFile } = require('../lib/config');
    const mk = (uid, cid) => ({
      userId: uid, email: `${uid}@x.com`, deviceToken: `d-${uid}`, sessionKey: `K-${uid}`,
      clientId: cid, serverHttp: 'http://h', url: 'ws://h/ws',
      expiresAt: Date.now() + 100000, loginAt: 1,
    });
    saveAuthAccount({ entry: mk('u-a', 'pc-a') });
    saveAuthAccount({ entry: mk('u-b', 'pc-b') }); // b 是当前账号

    const r = clearAuthCredentials();
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.remaining, 1);
    const raw = readConfigFile();
    assert.deepStrictEqual(Object.keys(raw.accounts), ['http://h::u-a']);
    assert.strictEqual(raw.activeAccount, undefined);
    assert.strictEqual(raw.deviceToken, undefined);
    assert.strictEqual(raw.clientId, undefined, 'clientId 属于那个账号，登出要一起摘掉');
    assert.ok(!('authUser' in raw));

    assert.strictEqual(clearAuthCredentials().changed, false, '已是未登录态 → 幂等');
    const all = clearAuthCredentials({ all: true });
    assert.strictEqual(all.changed, true);
    assert.strictEqual(all.remaining, 0);
    assert.strictEqual(readConfigFile().accounts, undefined);
  });
});

test('saveConnectionConfig(cfg, {accountKey})：借用别人账号只写它的条目，flat 不动', () => {
  withTempHome(() => {
    const { saveAuthAccount, saveConnectionConfig, readConfigFile } = require('../lib/config');
    const mk = (uid, cid) => ({
      userId: uid, deviceToken: `d-${uid}`, sessionKey: `K-${uid}`, clientId: cid,
      serverHttp: 'http://h', url: 'ws://h/ws', expiresAt: Date.now() + 100000, loginAt: 1,
    });
    const keyA = 'http://h::u-a';
    saveAuthAccount({ entry: mk('u-a', 'pc-a') });
    const rB = saveAuthAccount({ entry: mk('u-b', 'pc-b') });

    const res = saveConnectionConfig({ sessionKey: 'K-A-NEW', url: 'ws://h2/ws' }, { accountKey: keyA });
    assert.strictEqual(res.changed, true);
    const raw = readConfigFile();
    assert.strictEqual(raw.accounts[keyA].sessionKey, 'K-A-NEW');
    assert.strictEqual(raw.accounts[keyA].url, 'ws://h2/ws');
    // flat 必须继续镜像当前激活账号 B，不能被 A 的运行期字段污染
    assert.strictEqual(raw.sessionKey, 'K-u-b');
    assert.strictEqual(raw.url, 'ws://h/ws');
    assert.strictEqual(raw.activeAccount, rB.key);

    // 激活账号自己的运行期回写：条目与 flat 一起更新
    // （只写 flat 的话，切走再切回来会拿到那把已经过期的 sessionKey）
    saveConnectionConfig({ sessionKey: 'K-B-NEW' });
    const raw2 = readConfigFile();
    assert.strictEqual(raw2.sessionKey, 'K-B-NEW');
    assert.strictEqual(raw2.accounts[rB.key].sessionKey, 'K-B-NEW');

    assert.strictEqual(saveConnectionConfig({ sessionKey: 'K-B-NEW' }).changed, false, '无差异不重写');
  });
});

run().then(() => {
  console.log('\n========================================');
  console.log(`  通过 ${pass}   失败 ${fail}`);
  console.log('========================================\n');
  process.exit(fail === 0 ? 0 : 1);
});
