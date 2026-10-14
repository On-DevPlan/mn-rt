'use strict';

/**
 * 统一登录改造的端到端联调（全离线，自起 server.js）。
 *
 * 为什么这条链路不需要真的认证中心：
 * WS 注册、属主绑定、路由隔离、会话密钥下发全部只看**本服务自己签的 HS256 设备令牌**，
 * 认证中心只在「第一次换身份」那一跳参与。用同一份 RT_AUTH_JWT_SECRET 在测试里签令牌，
 * 就得到一个不含网络依赖、但走的是完全相同代码路径的场景。
 * 唯一需要认证中心在场的是 `/auth/verify`（verifyBearer 会实时拉发现文档 + userinfo），
 * 所以那里接一个**本地 OIDC 桩**（见 startIdpStub）——多账号的两条关键契约
 *（身份预检不产生登记、同一 clientId 换属主必被 403）都发生在这一跳上，
 * 不能在 e2e 里留空白。
 *
 * 运行：node test/auth-e2e.js
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');
const fs = require('fs');

const WebSocket = require('../client/node_modules/ws');
const { AuthHub } = require('../server/src/auth');
const rtCrypto = require('../client/lib/rt-crypto');

const PORT = 18991;
const URL_WS = `ws://127.0.0.1:${PORT}/ws`;
const SECRET = 'e2e-shared-secret-do-not-use-in-prod';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 极小的本地 OIDC 桩：只服务发现文档与 userinfo，供 /auth/verify 走完 verifyBearer。
 *
 * 桩不校验签名——它按 Bearer 查一张测试自控的身份表，等价于"认证中心断言了他是谁"。
 * 覆盖的真实代码路径是：服务端拉发现文档 → 用 Bearer 换身份 → 属主判定 → 签发。
 */
function startIdpStub() {
  const tokens = new Map(); // access_token → userinfo
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const path = new URL(req.url, base).pathname;
    if (path === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/oauth2/auth`,
        token_endpoint: `${base}/oauth2/token`,
        userinfo_endpoint: `${base}/oauth2/userinfo`,
      }));
      return;
    }
    if (path === '/oauth2/userinfo') {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const who = tokens.get(bearer);
      res.writeHead(who ? 200 : 401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(who || { error: 'invalid_token' }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        issuer: `http://127.0.0.1:${server.address().port}`,
        /** 发一枚"认证中心令牌"：本桩按 bearer 查表给出身份，不做签名校验。 */
        issue(user) {
          const tok = `idp-tok-${user.sub}-${Math.random().toString(36).slice(2, 10)}`;
          tokens.set(tok, {
            sub: user.sub,
            email: user.email || '',
            preferred_username: user.username || '',
            name: user.name || '',
          });
          return tok;
        },
        close() { try { server.close(); } catch { /* ignore */ } },
      });
    });
  });
}

/** 与服务端同密钥的离签器：payload 形状必须与 issueDeviceToken 一致。 */
const signer = new AuthHub({
  enabled: true, issuer: 'http://idp.invalid', clientId: 'mn-rt',
  jwtSecret: SECRET, deviceFile: null, logger: { warn() {}, info() {} },
});

function req(method, p, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      method, host: '127.0.0.1', port: PORT, path: p,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 保留 raw 供断言 */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

/** 裸 WS 连接：能控制注册帧内容，也能观察关闭码。 */
function rawConn() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_WS);
    const inbox = [];
    const waiters = [];
    const state = {
      ws,
      inbox,
      closeCode: null,
      send(obj) { ws.send(JSON.stringify(obj)); },
      waitFor(probe, ms = 4000) {
        const hit = inbox.find(probe);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const w = { probe, res };
          waiters.push(w);
          setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error('waitFor 超时'));
          }, ms);
        });
      },
      closed(ms = 4000) {
        if (state.closeCode !== null) return Promise.resolve(state.closeCode);
        return new Promise((res) => {
          const t = setTimeout(() => res(state.closeCode), ms);
          const prev = ws.listeners('close')[0];
          ws.on('close', (code) => { clearTimeout(t); res(code); });
          void prev;
        });
      },
      dispose() { try { ws.close(); } catch { /* ignore */ } },
    };
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].probe(msg)) { waiters[i].res(msg); waiters.splice(i, 1); }
      }
    });
    ws.on('close', (code) => { state.closeCode = code; });
    ws.on('error', reject);
    ws.on('open', () => resolve(state));
  });
}

async function waitHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const r = http.get(`http://127.0.0.1:${PORT}/health`, (res) => { res.resume(); resolve(res.statusCode === 200); });
      r.on('error', () => resolve(false));
      r.setTimeout(800, () => { r.destroy(); resolve(false); });
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error('server 未在超时内健康');
}

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-auth-e2e-'));
  // 认证中心桩必须先于 server 起来：server 启动时会预热发现文档
  const idp = await startIdpStub();
  const child = spawn(process.execPath, ['src/server.js', '--port', String(PORT), '--log-level', 'error'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: {
      ...process.env,
      RT_AUTH_ENABLED: '1',
      RT_AUTH_ISSUER: idp.issuer,
      RT_AUTH_CLIENT_ID: 'mn-rt',
      RT_AUTH_JWT_SECRET: SECRET,
      RT_AUTH_DEVICE_FILE: path.join(dir, 'devices.json'),
      RT_TOKEN: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  try {
    await waitHealth();
    await fn(dir, idp);
  } finally {
    child.kill();
    idp.close();
    await sleep(150);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统临时区 */ }
    if (stderr.trim() && process.env.RT_E2E_VERBOSE) console.log('  [server stderr]\n' + stderr);
  }
}

const results = [];
async function t(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`);
  }
}

async function main() {
  console.log('\n== mn-rt 统一登录端到端（RT_AUTH_ENABLED=1，离线）==\n');

  await withServer(async (dir, idp) => {
    // ---------- 1. 门禁：没有设备令牌什么都做不了 ----------
    await t('无 deviceToken 的 register 被关闭 4401', async () => {
      const c = await rawConn();
      try {
        c.send({ type: 'register', role: 'pc', clientId: 'pc-nobody' });
        const err = await c.waitFor((m) => m.type === 'error');
        assert.strictEqual(err.error, 'auth_required', JSON.stringify(err));
        assert.ok(/mn-rt auth login|auth login/.test(err.hint || ''), `hint 要能指路: ${err.hint}`);
        assert.strictEqual(await c.closed(), 4401);
      } finally { c.dispose(); }
    });

    await t('无效/伪造 deviceToken 同样 4401', async () => {
      const c = await rawConn();
      try {
        c.send({ type: 'register', role: 'pc', clientId: 'pc-x', deviceToken: 'a.b.c' });
        assert.strictEqual(await c.closed(), 4401);
      } finally { c.dispose(); }
    });

    await t('跳过 register 直接发 ack → 4403（ack 口没有属主概念，只能靠注册门禁）', async () => {
      const c = await rawConn();
      try {
        c.send({ type: 'ack', phoneId: 'phone-victim', ack: { sid: 's', seq: 1, nonce: 'n', ct: 'c' } });
        assert.strictEqual(await c.closed(), 4403);
      } finally { c.dispose(); }
    });

    await t('跳过 register 直接发 text → 4403', async () => {
      const c = await rawConn();
      try {
        c.send({ clientId: 'e2e-pc', text: 'hello' });
        assert.strictEqual(await c.closed(), 4403);
      } finally { c.dispose(); }
    });

    // ---------- 2. PC 登记：令牌与 clientId 必须自洽 ----------
    const alicePc = signer.issueDeviceToken({ userId: 'alice', clientId: 'pc-alice', deviceName: 'Alice 的台式' });
    const alicePhone = signer.issueDeviceToken({ userId: 'alice', clientId: '', deviceName: 'phone' });
    const bobPc = signer.issueDeviceToken({ userId: 'bob', clientId: 'pc-bob', deviceName: 'Bob 的笔记本' });
    const bobPhone = signer.issueDeviceToken({ userId: 'bob', clientId: '', deviceName: 'phone' });

    await t('用户令牌（cid 为空）不能注册成 pc', async () => {
      const c = await rawConn();
      try {
        c.send({ type: 'register', role: 'pc', clientId: 'pc-alice', deviceToken: alicePhone.token });
        const err = await c.waitFor((m) => m.type === 'error');
        assert.strictEqual(err.error, 'token_client_mismatch', JSON.stringify(err));
        assert.strictEqual(await c.closed(), 4401);
      } finally { c.dispose(); }
    });

    await t('A 机令牌冒充 B 机上线被拒', async () => {
      const c = await rawConn();
      try {
        c.send({ type: 'register', role: 'pc', clientId: 'pc-bob', deviceToken: alicePc.token });
        assert.strictEqual(await c.closed(), 4401);
      } finally { c.dispose(); }
    });

    let aliceSessionKey = null;
    await t('PC 正常登记并拿到服务端下发的 sessionKey', async () => {
      const c = await rawConn();
      try {
        c.send({ type: 'register', role: 'pc', clientId: 'pc-alice', deviceToken: alicePc.token, deviceName: 'Alice 的台式' });
        const ack = await c.waitFor((m) => m.type === 'registered');
        assert.ok(ack.sessionKey && ack.sessionKey.length >= 32, '必须下发会话密钥');
        assert.strictEqual(ack.device.owner, 'alice');
        aliceSessionKey = ack.sessionKey;
      } finally { c.dispose(); }
    });

    await t('sessionKey 跨重启稳定：同一 clientId 二次登记回同一把', async () => {
      const c = await rawConn();
      try {
        c.send({ type: 'register', role: 'pc', clientId: 'pc-alice', deviceToken: alicePc.token });
        const ack = await c.waitFor((m) => m.type === 'registered');
        assert.strictEqual(ack.sessionKey, aliceSessionKey, '换了密钥手机端缓存立刻对不上');
      } finally { c.dispose(); }
    });

    // ---------- 3. 属主隔离：列表与注入两条路都要断 ----------
    await t('/my/devices 跨用户零可见，且密钥只随属主的列表下发', async () => {
      // bob 也要有一台在线的电脑，才能证明"过滤"真的在工作而不是表是空的
      const cb = await rawConn();
      const ca = await rawConn();
      try {
        cb.send({ type: 'register', role: 'pc', clientId: 'pc-bob', deviceToken: bobPc.token, deviceName: 'Bob 的笔记本' });
        await cb.waitFor((m) => m.type === 'registered');
        ca.send({ type: 'register', role: 'pc', clientId: 'pc-alice', deviceToken: alicePc.token });
        const ack = await ca.waitFor((m) => m.type === 'registered');

        const mine = await req('GET', '/my/devices', { token: alicePhone.token });
        assert.strictEqual(mine.status, 200);
        assert.strictEqual(mine.json.userId, 'alice');
        assert.deepStrictEqual(mine.json.devices.map((d) => d.clientId), ['pc-alice']);
        assert.strictEqual(mine.json.devices[0].sessionKey, ack.sessionKey, '属主必须拿到自己那把');
        assert.strictEqual(mine.json.devices[0].online, true, '在线状态必须回给手机，否则列表点不开');

        const theirs = await req('GET', '/my/devices', { token: bobPhone.token });
        assert.deepStrictEqual(theirs.json.devices.map((d) => d.clientId), ['pc-bob']);
        assert.ok(!JSON.stringify(theirs.json).includes(ack.sessionKey), 'bob 的响应里不得出现 alice 的密钥');

      } finally { cb.dispose(); ca.dispose(); }
    });

    await t('无令牌访问 /my/devices → 401', async () => {
      const r = await req('GET', '/my/devices');
      assert.strictEqual(r.status, 401);
    });

    await t('bob 的手机向 alice 的电脑注入 → 被拒，且 alice 电脑收不到任何帧', async () => {
      const victim = await rawConn();
      const attacker = await rawConn();
      try {
        victim.send({ type: 'register', role: 'pc', clientId: 'pc-alice', deviceToken: alicePc.token });
        await victim.waitFor((m) => m.type === 'registered');
        victim.inbox.length = 0;

        attacker.send({ type: 'register', role: 'phone', phoneId: 'phone-bob', deviceToken: bobPhone.token });
        await attacker.waitFor((m) => m.type === 'registered');
        attacker.send({ clientId: 'pc-alice', text: JSON.stringify(rtCrypto.seal(
          rtCrypto.deriveFromKey('BOBSOWNKEY1234567890').keyPhoneToPc,
          rtCrypto.buildAad('x', 'p2c', 1), { text: '越权注入' }, { sid: 's', seq: 1 },
        )) });

        const result = await attacker.waitFor((m) => m.status === 'forbidden' || m.clientId === 'pc-alice', 4000);
        assert.strictEqual(result.status, 'forbidden', `期望 forbidden，实到 ${JSON.stringify(result)}`);
        await sleep(250);
        assert.strictEqual(victim.inbox.length, 0, '受害电脑一条帧都不该收到');
      } finally { victim.dispose(); attacker.dispose(); }
    });

    await t('alice 的手机向自己的电脑注入 → 正常投递', async () => {
      const pc = await rawConn();
      const phone = await rawConn();
      try {
        pc.send({ type: 'register', role: 'pc', clientId: 'pc-alice', deviceToken: alicePc.token });
        await pc.waitFor((m) => m.type === 'registered');
        phone.send({ type: 'register', role: 'phone', phoneId: 'phone-alice', deviceToken: alicePhone.token });
        await phone.waitFor((m) => m.type === 'registered');
        const env = rtCrypto.seal(
          rtCrypto.deriveFromKey(aliceSessionKey).keyPhoneToPc,
          rtCrypto.buildAad('any', 'p2c', 1), { text: '自己的电脑', ts: 1, phoneId: 'phone-alice' },
          { sid: 's1', seq: 1 },
        );
        phone.send({ clientId: 'pc-alice', text: JSON.stringify(env) });
        const got = await pc.waitFor((m) => typeof m.text === 'string', 4000);
        const opened = rtCrypto.open(
          rtCrypto.deriveFromKey(aliceSessionKey).keyPhoneToPc,
          rtCrypto.buildAad('any', 'p2c', 1), JSON.parse(got.text),
        );
        assert.strictEqual(opened.text, '自己的电脑', '端到端信封必须原样可达');
      } finally { pc.dispose(); phone.dispose(); }
    });

    // ---------- 4. HTTP 注入口的身份要求 ----------
    await t('/push 无身份 → 401；bob 推 alice 的机器 → forbidden；本人 → 放行', async () => {
      const pc = await rawConn();
      try {
        pc.send({ type: 'register', role: 'pc', clientId: 'pc-alice', deviceToken: alicePc.token });
        await pc.waitFor((m) => m.type === 'registered');

        const anon = await req('POST', '/push', { body: { clientId: 'pc-alice', text: 'hi' } });
        assert.strictEqual(anon.status, 401, '/push 是注入通道，未带身份必须拒');

        const cross = await req('POST', '/push', { body: { clientId: 'pc-alice', text: 'hi' }, token: bobPc.token });
        assert.strictEqual(cross.json.status, 'forbidden', JSON.stringify(cross.json));

        const own = await req('POST', '/push', { body: { clientId: 'pc-alice', text: 'hi' }, token: alicePc.token });
        assert.strictEqual(own.json.status, 'forwarded', JSON.stringify(own.json));
      } finally { pc.dispose(); }
    });

    await t('auth 开启后 /clients 不再泄露别人的 clientId', async () => {
      const r = await req('GET', '/clients');
      assert.ok(r.status === 401 || r.status === 403, `期望 401/403，实到 ${r.status}: ${r.raw}`);
      assert.ok(!r.raw.includes('pc-alice'), '未认证响应里不得出现别人的 clientId');
    });

    // ---------- 5. 同一台电脑、多个账号 ----------
    // 这是 CLI 多账号方案依赖的服务端契约：clientId→属主 永久一对一（改绑被拒），
    // 以及"不带 clientId 的 verify 只回答身份、不产生登记"——CLI 靠它先探明这次
    // 浏览器登录的是谁，再决定沿用原 clientId 还是领一个新的。
    const PC_X = 'pc-shared-x';
    const PC_Y = 'pc-shared-y';
    const aliceTok = idp.issue({ sub: 'shared-alice', email: 'shared-alice@e2e.test', name: 'Alice' });
    const bobTok = idp.issue({ sub: 'shared-bob', email: 'shared-bob@e2e.test', name: 'Bob' });
    let sharedKeyA = null;
    let sharedTokenA = null;
    let sharedTokenB = null;

    await t('账号 A 用 clientId pc-shared-x 登记 → 设备令牌 + 会话密钥', async () => {
      const r = await req('POST', '/auth/verify', {
        body: { clientId: PC_X, deviceName: '共用的书房电脑' }, token: aliceTok,
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.json.userId, 'shared-alice');
      assert.strictEqual(r.json.device.owner, 'shared-alice');
      assert.ok(r.json.token && r.json.sessionKey, '设备令牌与会话密钥都要下发');
      sharedKeyA = r.json.sessionKey;
      sharedTokenA = r.json.token;
    });

    await t('账号 B 拿同一个 clientId 登记 → 403 device_owned_by_other，不泄露 A 的密钥', async () => {
      const r = await req('POST', '/auth/verify', {
        body: { clientId: PC_X, deviceName: '共用的书房电脑' }, token: bobTok,
      });
      assert.strictEqual(r.status, 403, `同一 clientId 改绑属主必须被拒，实到 ${r.status}: ${r.raw}`);
      assert.strictEqual(r.json.error, 'device_owned_by_other');
      assert.ok(!r.raw.includes(sharedKeyA), '被拒的响应绝不能带上真属主的会话密钥');
    });

    await t('身份预检（不带 clientId）→ 只回答身份，不产生任何设备登记', async () => {
      const pre = await req('POST', '/auth/verify', { body: {}, token: bobTok });
      assert.strictEqual(pre.status, 200, pre.raw);
      assert.strictEqual(pre.json.userId, 'shared-bob', '先知身份、再选 clientId——多账号就靠这一跳');
      assert.ok(pre.json.token, '预检同样发一枚用户令牌（用完即弃）');
      assert.ok(!pre.json.device && !pre.json.sessionKey, '预检不得登记设备、也不该下发密钥');
      // A 的记录一个字节都没被动过：再验一次，还是那把密钥
      const again = await req('POST', '/auth/verify', { body: { clientId: PC_X }, token: aliceTok });
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.json.sessionKey, sharedKeyA, '预检不能碰到别人的登记记录');
    });

    await t('账号 B 换一个自己的 clientId → 登记成功，两台"电脑"各持各的密钥', async () => {
      const r = await req('POST', '/auth/verify', {
        body: { clientId: PC_Y, deviceName: '共用的书房电脑' }, token: bobTok,
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.json.device.owner, 'shared-bob');
      assert.notStrictEqual(r.json.sessionKey, sharedKeyA, '每个 clientId 一把独立会话密钥');
      sharedTokenB = r.json.token;
    });

    await t('客户端真代码 verifyExchange：成功形状与 403 形状都能对出来', async () => {
      // 用 CLI 自己的实现（client/lib/auth.js）打这台服务器，而不是在测试里重写一遍
      const { verifyExchange } = require('../client/lib/auth');
      const base = `http://127.0.0.1:${PORT}`;
      const ok = await verifyExchange({
        serverHttp: base, accessToken: aliceTok, clientId: PC_X, deviceName: '共用的书房电脑',
      });
      assert.strictEqual(ok.userId, 'shared-alice');
      assert.ok(ok.token && ok.sessionKey, '归一化结果里要有令牌与会话密钥');
      assert.strictEqual(ok.serverHttp, base);
      await assert.rejects(
        () => verifyExchange({ serverHttp: base, accessToken: bobTok, clientId: PC_X }),
        (e) => e.code === 'device_owned_by_other',
        '复用别人的 clientId 必须抛 device_owned_by_other（CLI 靠它决定换新 id）',
      );
    });

    await t('两个 clientId 各自 register 成 pc；重连回到各自那把密钥', async () => {
      const cA = await rawConn();
      const cB = await rawConn();
      try {
        cA.send({ type: 'register', role: 'pc', clientId: PC_X, deviceToken: sharedTokenA, deviceName: '共用的书房电脑' });
        const ackA = await cA.waitFor((m) => m.type === 'registered');
        assert.strictEqual(ackA.device.owner, 'shared-alice');
        assert.strictEqual(ackA.sessionKey, sharedKeyA);

        cB.send({ type: 'register', role: 'pc', clientId: PC_Y, deviceToken: sharedTokenB, deviceName: '共用的书房电脑' });
        const ackB = await cB.waitFor((m) => m.type === 'registered');
        assert.strictEqual(ackB.device.owner, 'shared-bob');
        assert.notStrictEqual(ackB.sessionKey, ackA.sessionKey, '两台设备的密钥必须彼此独立');

        // 切走再切回来（= CLI auth switch 后再起 serve）：仍是原来那把，手机端缓存的密钥继续有效
        const cA2 = await rawConn();
        try {
          cA2.send({ type: 'register', role: 'pc', clientId: PC_X, deviceToken: sharedTokenA, sessionKey: sharedKeyA });
          const ackA2 = await cA2.waitFor((m) => m.type === 'registered');
          assert.strictEqual(ackA2.sessionKey, sharedKeyA);
        } finally { cA2.dispose(); }
      } finally { cA.dispose(); cB.dispose(); }
    });

    await t('多账号不改变隔离：B 的手机推不到 A 那台（跨属主仍 forbidden）', async () => {
      const cA = await rawConn();
      const phoneB = await rawConn();
      try {
        cA.send({ type: 'register', role: 'pc', clientId: PC_X, deviceToken: sharedTokenA });
        await cA.waitFor((m) => m.type === 'registered');
        cA.inbox.length = 0; // 登记回执不算“收到的注入帧”，清掉再看有没有越权投递
        const bobPhone = signer.issueDeviceToken({ userId: 'shared-bob', clientId: '', deviceName: 'phone' });
        phoneB.send({ type: 'register', role: 'phone', phoneId: 'phone-shared-bob', deviceToken: bobPhone.token });
        await phoneB.waitFor((m) => m.type === 'registered');

        phoneB.send({ clientId: PC_X, text: '越权注入' });
        const res = await phoneB.waitFor((m) => m.status === 'forbidden' || m.clientId === PC_X, 4000);
        assert.strictEqual(res.status, 'forbidden', JSON.stringify(res));
        await sleep(250);
        assert.strictEqual(cA.inbox.length, 0, 'A 那台一条帧都不该收到');
      } finally { cA.dispose(); phoneB.dispose(); }
    });
  });

  const failed = results.filter(([ok]) => !ok);
  console.log(`\n========================================\n  通过 ${results.length - failed.length}   失败 ${failed.length}\n========================================\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e 崩溃：', e);
  process.exit(1);
});
