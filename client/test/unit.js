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

run().then(() => {
  console.log('\n========================================');
  console.log(`  通过 ${pass}   失败 ${fail}`);
  console.log('========================================\n');
  process.exit(fail === 0 ? 0 : 1);
});
