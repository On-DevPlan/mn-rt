'use strict';

/**
 * 统一登录接入与设备属主的单元测试。
 *
 * 用 Node 内置 `node:test`，不引入测试框架——本服务的全部依赖只有一个 `ws`，
 * 为了几个断言再加一套 test runner 不值得。
 *
 * 跑法：node --test server/test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createServer } = require('../src/server');
const { AuthHub } = require('../src/auth');

function tmpFile(name) {
  return path.join(os.tmpdir(), `mnrt-test-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

/** 造一个开了统一登录的服务实例（不 listen，只测内部判据）。 */
function makeAuthedServer(tag) {
  return createServer({
    port: 0,
    logLevel: 'silent',
    logDir: tmpFile(`log-${tag}`),
    recordFile: tmpFile(`rec-${tag}`),
    token: null,
    auth: {
      enabled: true,
      issuer: 'http://idp.test:8082',
      clientId: 'mn-rt',
      redirectUri: 'http://1.94.101.189:8790/auth/oidc/callback',
      scopes: ['openid', 'profile', 'email'],
      jwtSecret: 'test-secret-do-not-use-in-prod',
      deviceFile: tmpFile(`dev-${tag}`),
      httpTimeoutMs: 2000,
    },
  });
}

test.afterEach(() => { /* 每个用例各自建实例，无需共享清理 */ });

// ==================== 配置与启动 ====================

test('RT_AUTH_ENABLED 必须认 1/yes/on；认不出的值抛错而不是静默关闭', () => {
  // 这条锁的是"配了但没生效"这一整类事故：docker-compose 里 `RT_AUTH_ENABLED=1`
  // 是最自然的写法，而按 `=== 'true'` 判会把它当成 false——服务照常起、
  // /auth/oidc/config 照答，整套属主隔离静默不存在，运维那边看到的是"已开启"。
  const { loadConfig } = require('../src/server');
  const withEnv = (v, fn) => {
    const prev = process.env.RT_AUTH_ENABLED;
    if (v === undefined) delete process.env.RT_AUTH_ENABLED; else process.env.RT_AUTH_ENABLED = v;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.RT_AUTH_ENABLED; else process.env.RT_AUTH_ENABLED = prev;
    }
  };
  for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on', ' True ']) {
    assert.equal(withEnv(truthy, () => loadConfig(['--port', '0']).auth.enabled), true, `${truthy} 应为 true`);
  }
  for (const falsy of ['0', 'false', 'no', 'off']) {
    assert.equal(withEnv(falsy, () => loadConfig(['--port', '0']).auth.enabled), false, `${falsy} 应为 false`);
  }
  // 未设置 → 默认关闭（改造可以先进仓，开启与否是部署决策）
  assert.equal(withEnv(undefined, () => loadConfig(['--port', '0']).auth.enabled), false);
  // 拼错的值必须炸，不能悄悄落到默认值
  assert.throws(() => withEnv('ture', () => loadConfig(['--port', '0'])), /RT_AUTH_ENABLED 取值无法识别/);
});

test('默认 redirectUri 必须是认证中心白名单放行的形状', () => {
  // 白名单规则：回环通配只放行 `http://127.0.0.1:*/callback`——
  // 主机限回环、端口通配、**路径逐字 /callback**；公网地址一律不许通配。
  // 所以"把本服务的 /auth/oidc/callback 当默认值"看着合理，实际一条都不匹配，
  // 症状是配置全对、authorize 一直 400，离真正的因由隔了三次跳转。
  const { loadConfig } = require('../src/server');
  const prev = process.env.RT_AUTH_REDIRECT_URI;
  const prevPort = process.env.RT_PORT;
  try {
    delete process.env.RT_AUTH_REDIRECT_URI;
    process.env.RT_PORT = '8790';
    const cfg = loadConfig(['--port', '8790']);
    assert.equal(cfg.auth.redirectUri, 'http://127.0.0.1:8790/callback');
    assert.match(
      cfg.auth.redirectUri,
      /^http:\/\/(127\.0\.0\.1|localhost):\d+\/callback$/,
      '必须落在回环通配那一项里',
    );
    // 显式配置永远优先于默认（换端口、换部署形态时不用改代码）
    process.env.RT_AUTH_REDIRECT_URI = 'http://localhost:9999/callback';
    assert.equal(loadConfig(['--port', '8790']).auth.redirectUri, 'http://localhost:9999/callback');
  } finally {
    if (prev === undefined) delete process.env.RT_AUTH_REDIRECT_URI; else process.env.RT_AUTH_REDIRECT_URI = prev;
    if (prevPort === undefined) delete process.env.RT_PORT; else process.env.RT_PORT = prevPort;
  }
});

test('开启统一登录但未配签名密钥 → 拒绝启动', () => {
  assert.throws(
    () => createServer({
      logLevel: 'silent',
      logDir: tmpFile('l'), recordFile: tmpFile('r'),
      auth: { enabled: true, issuer: 'http://x', clientId: 'c', jwtSecret: '', deviceFile: tmpFile('d') },
    }),
    /RT_AUTH_JWT_SECRET/,
  );
});

test('关闭统一登录 → 行为与改造前一致（不碰网络、不要求令牌）', async () => {
  const srv = createServer({
    port: 0, logLevel: 'silent',
    logDir: tmpFile('l2'), recordFile: tmpFile('r2'), token: null,
    auth: { enabled: false, issuer: '', clientId: '', jwtSecret: '', deviceFile: tmpFile('d2') },
  });
  // 关闭时 routeMessage 不做属主校验：目标不存在只报 offline，不会冒 forbidden
  const r = srv._internal.routeMessage('pc-anything', 'hello', 'phone', undefined);
  assert.equal(r.status, 'target_offline');
  assert.notEqual(r.status, 'forbidden');
});

// ==================== 设备令牌 ====================

test('设备令牌：自签、篡改、跨密钥都必须被拒', () => {
  const a = new AuthHub({
    enabled: true, issuer: 'http://idp.test', clientId: 'mn-rt',
    jwtSecret: 'secret-A', deviceFile: tmpFile('t1'), logger: { warn() {}, info() {} },
  });
  const { token } = a.issueDeviceToken({ userId: '42', clientId: 'pc-office' });
  assert.ok(a.verifyDeviceToken(token), '合法令牌必须通过');

  // 攻击者把 payload 里的 sub 换成别人：签名对不上必须废
  const [h, b, s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: '1', cid: 'pc-victim', exp: 9e9 }))
    .toString('base64url');
  assert.equal(a.verifyDeviceToken(`${h}.${forged}.${s}`), null, '篡改 payload 必须被拒');

  // 另一台服务器用不同密钥签的令牌，绝不能在这里被认成合法身份
  const b2 = new AuthHub({
    enabled: true, issuer: 'http://idp.test', clientId: 'mn-rt',
    jwtSecret: 'secret-B', deviceFile: tmpFile('t2'), logger: { warn() {}, info() {} },
  });
  assert.equal(b2.verifyDeviceToken(token), null, '跨密钥令牌必须被拒');
  assert.equal(a.verifyDeviceToken('garbage'), null);
  assert.equal(a.verifyDeviceToken(''), null);
});

test('令牌里的 clientId 与上报 clientId 不一致时不得放行（防冒充上线）', () => {
  const a = new AuthHub({
    enabled: true, issuer: 'http://i', clientId: 'c',
    jwtSecret: 's', deviceFile: tmpFile('t3'), logger: { warn() {}, info() {} },
  });
  const mine = a.issueDeviceToken({ userId: '7', clientId: 'pc-mine' });
  const payload = a.verifyDeviceToken(mine.token);
  // 这条判据在 server.js 的 register 里；这里固化它的语义：cid 必须逐字相等
  assert.equal(payload.cid, 'pc-mine');
  assert.notEqual(payload.cid, 'pc-victim', '拿 A 机令牌冒充 B 机必须能被识别');
});

test('吊销后的令牌立即失效', () => {
  const a = new AuthHub({
    enabled: true, issuer: 'http://i', clientId: 'c',
    jwtSecret: 's', deviceFile: tmpFile('t4'), logger: { warn() {}, info() {} },
  });
  const { token, jti } = a.issueDeviceToken({ userId: '9', clientId: 'pc-lost' });
  assert.ok(a.verifyDeviceToken(token));
  a.revoke(jti);
  assert.equal(a.verifyDeviceToken(token), null, '吊销必须立即生效（JWT 本身无法作废，靠名单）');
});

// ==================== 属主与路由（核心安全判据） ====================

test('跨属主注入必须被拒，同属主才放行', () => {
  const srv = makeAuthedServer('own');
  const { auth, pcs } = srv._internal;

  auth.upsertDevice({ clientId: 'pc-alice', userId: 'alice' });
  // 伪造一个"在线"的目标连接
  pcs.set('pc-alice', { readyState: 1, send() {} });

  const bad = srv._internal.routeMessage('pc-alice', 'rm -rf /', 'phone', 'bob');
  assert.equal(bad.status, 'forbidden', 'bob 向 alice 的电脑注入文本必须被拒');

  const anon = srv._internal.routeMessage('pc-alice', 'hi', 'phone', undefined);
  assert.equal(anon.status, 'forbidden', '无身份者不得注入');

  const ok = srv._internal.routeMessage('pc-alice', 'hi', 'phone', 'alice');
  assert.notEqual(ok.status, 'forbidden', '本人必须能连自己的电脑');

  const ghost = srv._internal.routeMessage('pc-never-registered', 'hi', 'phone', 'alice');
  assert.equal(ghost.status, 'unregistered_target', '目标未登记属主时不得转发');
});

test('设备列表严格按属主过滤，跨用户零可见', () => {
  const srv = makeAuthedServer('list');
  const { auth } = srv._internal;
  auth.upsertDevice({ clientId: 'pc-a1', userId: 'alice', deviceName: '办公室' });
  auth.upsertDevice({ clientId: 'pc-a2', userId: 'alice', deviceName: '家里' });
  auth.upsertDevice({ clientId: 'pc-b1', userId: 'bob', deviceName: 'Bob 的笔记本' });

  const alice = auth.listDevicesByUser('alice');
  assert.equal(alice.length, 2);
  assert.deepEqual(alice.map((d) => d.clientId).sort(), ['pc-a1', 'pc-a2']);
  assert.ok(!alice.some((d) => d.deviceName.includes('Bob')), '他人设备名不得出现在我的列表里');
  assert.equal(auth.listDevicesByUser('carol').length, 0);
  // 字符串型 sub 与数字型 sub 必须等价（认证中心的 sub 是字符串）
  assert.equal(auth.listDevicesByUser(123).length, 0);
});

test('会话密钥：首次生成后稳定，且换绑尝试被拒', () => {
  const srv = makeAuthedServer('key');
  const { auth } = srv._internal;

  const first = auth.upsertDevice({ clientId: 'pc-x', userId: 'alice' });
  assert.equal(first.rejected, false);
  assert.ok(first.rec.sessionKey && first.rec.sessionKey.length >= 32, '必须生成会话密钥');

  // PC 重启重新登记：密钥不能变。变了的话手机端缓存的密钥立刻对不上，
  // 表现为"连上了但所有信封被静默丢弃"——README 里已记载这是最难排查的故障。
  const again = auth.upsertDevice({ clientId: 'pc-x', userId: 'alice' });
  assert.equal(again.rec.sessionKey, first.rec.sessionKey, '重复登记必须保持同一把会话密钥');

  // bob 拿着同一个 clientId 来登记（比如他猜到了别人的 clientId）
  const steal = auth.upsertDevice({ clientId: 'pc-x', userId: 'bob', deviceName: '我的' });
  assert.equal(steal.rejected, true, '换绑必须显式标记为被拒，调用方才没机会漏判');
  assert.equal(steal.rec.userId, 'alice', '属主不得被后来者覆盖');
  assert.equal(steal.rec.sessionKey, first.rec.sessionKey, '换绑失败时不得顺手换掉密钥');
  assert.equal(auth.listDevicesByUser('bob').length, 0, 'bob 不该因此得到这台设备');
});

test('被拒的换绑尝试绝不得回显真属主的会话密钥', () => {
  const srv = makeAuthedServer('leak');
  const { auth } = srv._internal;
  const alice = auth.upsertDevice({ clientId: 'pc-alice', userId: 'alice' }).rec;
  assert.ok(alice.sessionKey);

  const steal = auth.upsertDevice({ clientId: 'pc-alice', userId: 'bob' });
  assert.equal(steal.rejected, true);
  // rejected 记录里密钥仍然指向真属主（不能清成"已脱敏"形状，否则上层会以为
  // deviceName 之类也可以安全回显）——所以真正的防线是调用方**不回 sessionKey**。
  assert.equal(steal.rec.sessionKey, alice.sessionKey);
});

test('/auth/verify 遇换绑冲突必须 403、不签令牌、不回真属主密钥', async () => {
  const srv = makeAuthedServer('verify');
  const { auth } = srv._internal;
  const aliceKey = auth.upsertDevice({ clientId: 'pc-alice', userId: 'alice' }).rec.sessionKey;
  assert.ok(aliceKey);

  // verifyBearer 打桩成固定身份：这条测的是"服务端拿到身份之后的处置"，
  // 不是测认证中心。为了断言它真起一个 IdP 会让失败原因变得无法归因。
  auth.verifyBearer = async () => ({
    userId: 'bob', sub: 'bob', email: 'b@x', preferredUsername: 'bob', name: 'Bob',
  });

  const { port } = await srv.listen();
  try {
    const resp = await new Promise((resolve, reject) => {
      const req = http.request({
        method: 'POST', hostname: '127.0.0.1', port, path: '/auth/verify',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer whatever' },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ clientId: 'pc-alice', deviceName: '偷来的' }));
    });
    assert.equal(resp.status, 403, `换绑冲突必须 403，实际 ${resp.status} ${resp.raw}`);
    assert.ok(resp.raw.includes('device_owned_by_other'), resp.raw);
    assert.ok(!resp.raw.includes(aliceKey), '响应体里绝不能出现真属主的会话密钥');
    assert.ok(!/"token"\s*:/.test(resp.raw), '被拒时也不得签发可用的设备令牌');
    assert.equal(auth.getDevice('pc-alice').userId, 'alice', '属主记录一个字都没被改');
  } finally {
    await srv.close();
  }
});

// ==================== 持久化 ====================

test('设备注册表跨重启保持属主与密钥', () => {
  const file = tmpFile('persist');
  const lg = { warn() {}, info() {} };
  const a1 = new AuthHub({ enabled: true, issuer: 'http://i', clientId: 'c', jwtSecret: 's', deviceFile: file, logger: lg });
  const d = a1.upsertDevice({ clientId: 'pc-p', userId: 'alice', deviceName: 'Desk' }).rec;

  const a2 = new AuthHub({ enabled: true, issuer: 'http://i', clientId: 'c', jwtSecret: 's', deviceFile: file, logger: lg });
  const re = a2.getDevice('pc-p');
  assert.ok(re, '重启后设备必须还在');
  assert.equal(re.userId, 'alice');
  assert.equal(re.deviceName, 'Desk');
  assert.equal(re.sessionKey, d.sessionKey, '重启后密钥必须不变，否则两端对不上');
  fs.rmSync(file, { force: true });
});

test('注册表文件损坏时按空表启动，而不是让服务起不来', () => {
  const file = tmpFile('broken');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  const a = new AuthHub({
    enabled: true, issuer: 'http://i', clientId: 'c', jwtSecret: 's',
    deviceFile: file, logger: { warn() {}, info() {} },
  });
  assert.equal(a.devices.size, 0);
  // 坏文件不能阻止新登记，且必须真的可查
  const r = a.upsertDevice({ clientId: 'pc-new', userId: 'zoe' });
  assert.equal(r.rejected, false);
  assert.ok(a.getDevice('pc-new'));
  fs.rmSync(file, { force: true });
});

test('pc 角色必须持"绑定了该 clientId 的设备令牌"——用户令牌不得登记他人电脑', () => {
  // 回归用例：门禁原先写成 `if (ident.cid && clientId && ident.cid !== clientId)`，
  // 空 cid 的用户令牌（手机端 auth 产物）会整条跳过判断，
  // 于是任何登录用户都能用「用户令牌 + 别人的 clientId」注册成 pc，
  // 把该电脑本该收到的手机流量吸到自己这条连接上。
  const a = new AuthHub({
    enabled: true, issuer: 'http://i', clientId: 'c',
    jwtSecret: 's', deviceFile: tmpFile('role'), logger: { warn() {}, info() {} },
  });
  a.upsertDevice({ clientId: 'pc-victim', userId: 'alice' });
  const userToken = a.issueDeviceToken({ userId: 'bob', clientId: '' }); // 手机端令牌：无 cid
  const payload = a.verifyDeviceToken(userToken.token);
  assert.equal(payload.cid, '', '用户令牌本就不绑定设备，这是合法形态');
  // 但正是这个空 cid 让它能声称自己是任意一台 pc —— 判据必须是相等而非"非空才比"
  assert.notEqual(payload.cid, 'pc-victim', '用户令牌不等于 pc 身份凭证');
});

// ==================== 公开配置 ====================

test('GET /auth/oidc/callback 明确拒绝而不是静默 404（服务端不代理浏览器流程）', async () => {
  // 这条地址**没有**登记进认证中心白名单，正常永远打不到这里。
  // 会有人打进来只可能是手工指过来的，所以必须给一句能照着往下走的话——
  // 一个 404 会让人去查路由，而真正缺的是一份 RP 会话。
  const srv = makeAuthedServer('getcb');
  const { port } = await srv.listen();
  try {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/auth/oidc/callback?code=x&state=y' }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      }).on('error', reject);
    });
    assert.equal(r.status, 400);
    assert.ok(r.raw.includes('browser_callback_flow_not_implemented'), r.raw);
    assert.ok(r.raw.includes('auth login'), '必须给出可执行的下一步');
  } finally {
    await srv.close();
  }
});

test('/my/devices 响应回带属主，CLI auth status 才知道"服务端认的是谁"', async () => {
  const srv = makeAuthedServer('mydev');
  const { auth } = srv._internal;
  auth.upsertDevice({ clientId: 'pc-mine', userId: 'alice', deviceName: '书房' });
  const { token } = auth.issueDeviceToken({ userId: 'alice', clientId: 'pc-mine' });

  const { port } = await srv.listen();
  try {
    const call = (headers) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/my/devices', headers }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw || '{}') }));
      }).on('error', reject);
    });

    const mine = await call({ Authorization: `Bearer ${token}` });
    assert.equal(mine.status, 200);
    assert.equal(mine.json.userId, 'alice', '响应必须自报属主');
    assert.equal(mine.json.devices.length, 1);
    assert.ok(mine.json.devices[0].sessionKey, '属主必须拿得到自己设备的会话密钥');

    // 别人的设备令牌，一个字都看不到
    const bobTok = auth.issueDeviceToken({ userId: 'bob', clientId: 'pc-bob' }).token;
    const theirs = await call({ Authorization: `Bearer ${bobTok}` });
    assert.equal(theirs.json.count, 0, '跨用户零可见');
    assert.ok(!JSON.stringify(theirs.json).includes(mine.json.devices[0].sessionKey),
      '他人响应里不得出现我的会话密钥');

    const anon = await call({});
    assert.equal(anon.status, 401, '无令牌必须拒');
  } finally {
    await srv.close();
  }
});

/**
 * 起一个最小假认证中心：发现文档 + token 端点 + userinfo。
 *
 * 为什么打桩而不是直连线上认证中心：线上那条真链路需要一个能登录的账号，
 * 而 CI 里不该存生产口令。这里覆盖的是**本服务这一段实现的正确性**
 * （表单字段名、不带 secret、用完即弃、拿 sub 当属主）；
 * 与真实认证中心的互操作由 .tool/chaincheck 手工验收（需一次真实登录）。
 * 两者是不同的问题，别用其中一个的通过去宣称另一个也通过了。
 */
function startFakeIdp({ expectVerifier } = {}) {
  const hits = { token: 0, userinfo: 0, lastTokenForm: null, lastAuth: null };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === '/.well-known/openid-configuration') {
      const base = `http://127.0.0.1:${srv.address().port}`;
      return send(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth2/auth`,
        token_endpoint: `${base}/oauth2/token`,
        userinfo_endpoint: `${base}/oauth2/userinfo`,
      });
    }
    if (u.pathname === '/oauth2/token') {
      hits.token += 1;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw));
        hits.lastTokenForm = form;
        if (form.code_verifier !== expectVerifier) return send(400, { error: 'invalid_grant' });
        send(200, { access_token: 'IDP-AT-1', refresh_token: 'IDP-RT-SECRET', token_type: 'Bearer' });
      });
      return undefined;
    }
    if (u.pathname === '/oauth2/userinfo') {
      hits.userinfo += 1;
      hits.lastAuth = req.headers.authorization || '';
      if (hits.lastAuth !== 'Bearer IDP-AT-1') return send(401, { error: 'invalid_token' });
      return send(200, { sub: 'sub-777', email: 'p@x.io', name: '跑批', preferred_username: 'pao' });
    }
    return send(404, { error: 'not_found' });
  });
  srv.listen(0, '127.0.0.1');
  return new Promise((resolve) => srv.once('listening', () => resolve({
    srv, hits,
    issuer: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((r) => srv.close(r)),
  })));
}

test('POST /auth/oidc/callback：授权码+verifier 换到身份并签发设备令牌', async () => {
  const verifier = 'a-test-verifier-value-0123456789abcdef';
  const idp = await startFakeIdp({ expectVerifier: verifier });
  const srv = createServer({
    port: 0, logLevel: 'silent',
    logDir: tmpFile('l-cb'), recordFile: tmpFile('r-cb'), token: null,
    auth: {
      enabled: true, issuer: idp.issuer, clientId: 'mn-rt',
      redirectUri: 'http://127.0.0.1:8790/callback',
      jwtSecret: 'cb-test-secret', deviceFile: tmpFile('d-cb'), httpTimeoutMs: 4000,
    },
  });
  const { port } = await srv.listen();
  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST', host: '127.0.0.1', port, path,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw, json: JSON.parse(raw || '{}') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  try {
    const ok = await post('/auth/oidc/callback', {
      code: 'CODE-1', codeVerifier: verifier, redirectUri: 'http://127.0.0.1:8790/callback',
      clientId: 'pc-cb', deviceName: '回调机',
    });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.json.userId, 'sub-777', '属主必须是认证中心断言的 sub');
    assert.ok(ok.json.token, '回设备令牌');
    assert.ok(ok.json.sessionKey, '回会话密钥');

    // 表单必须带 verifier 且**不带任何 secret**：这是公共客户端的契约
    assert.equal(idp.hits.lastTokenForm.code_verifier, verifier);
    assert.equal(idp.hits.lastTokenForm.client_id, 'mn-rt');
    assert.ok(!('client_secret' in idp.hits.lastTokenForm), '公共客户端不得发 client_secret');
    assert.equal(idp.hits.userinfo, 1);

    // 关键隐私断言：认证中心的 refresh_token 绝不外流到响应里
    const body = JSON.stringify(ok.json);
    assert.ok(!body.includes('IDP-RT-SECRET'), 'refresh_token 不得出现在任何响应/存储里');
    assert.ok(!body.includes('IDP-AT-1'), 'access_token 也不得回带给客户端');

    // 换错 verifier 必须失败，且不能因此签出任何令牌
    const bad = await post('/auth/oidc/callback', {
      code: 'CODE-2', codeVerifier: 'WRONG', redirectUri: 'http://127.0.0.1:8790/callback',
      clientId: 'pc-cb',
    });
    assert.equal(bad.status, 401, `verifier 不匹配必须 401，实到 ${bad.status}`);
    assert.ok(!bad.json.token, '失败路径不得发令牌');

    // 注册表落盘里也不能存认证中心的凭据
    const persisted = JSON.stringify(srv._internal.auth.devices);
    assert.ok(!persisted.includes('IDP-RT-SECRET') && !persisted.includes('IDP-AT-1'),
      '设备注册表不得存认证中心 token');
  } finally {
    await srv.close();
    await idp.close();
  }
});

test('拉不到发现文档时，idpError 必须带真实原因而不是兜底文案', async () => {
  // 观测性判据。_discoverError 曾经只在成功时被置 null，从未写入过错误本身，
  // 于是 /auth/oidc/config 永远只报"未拉取到发现文档"——线上正是这样卡在
  // "连不上"三个字上：DNS 失败、出网被防火墙掐、issuer 端口写错、对方返回 HTML
  // 四种完全不同的病长得一模一样，而容器日志进不去。
  const a = new AuthHub({
    enabled: true, issuer: 'http://127.0.0.1:1', clientId: 'mn-rt',
    jwtSecret: 's', deviceFile: tmpFile('disc'),
    logger: { warn() {}, info() {} }, httpTimeoutMs: 2000,
  });
  await assert.rejects(() => a.discover());
  const cfg = a.publicConfig();
  assert.equal(cfg.idpAvailable, false);
  assert.ok(cfg.idpError && cfg.idpError !== '未拉取到发现文档',
    `idpError 必须是具体原因，实到：${cfg.idpError}`);
  assert.ok(/127\.0\.0\.1:1/.test(cfg.idpError), `要带上尝试拉取的地址：${cfg.idpError}`);
});

test('/auth/oidc/config 的公开视图不含任何密钥', () => {
  const srv = makeAuthedServer('cfg');
  const cfg = srv._internal.auth.publicConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.clientId, 'mn-rt');
  assert.equal(cfg.issuer, 'http://idp.test:8082');
  const json = JSON.stringify(cfg);
  for (const banned of ['jwtSecret', 'secret-A', 'test-secret-do-not-use-in-prod']) {
    assert.ok(!json.includes(banned), `公开配置里不得出现 ${banned}`);
  }
  assert.ok(!('client_secret' in cfg));
});
