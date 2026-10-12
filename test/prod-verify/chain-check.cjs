'use strict';

/**
 * 真实一次性验收：用手机端 fr 将要走的同一条链路，打通 go-ah 与一个**本地** mn-rt 服务端。
 *
 * 为什么值得单独写：这一步是"我以为能用"和"它确实能用"之间唯一的分界。
 * 前面所有单元测试都用打桩绕过了认证中心，而真正的互操作风险恰好集中在
 * "PKCE + 公共客户端 + 非标准端点名 + 内部 consent 接口"这一小段接缝上。
 *
 * 链路（与 fr 的实现逐字同形）：
 *   ① POST <issuer>/api/login            拿 idp_session（等价于 App 里已统一登录）
 *   ② GET  <issuer>/oauth2/auth          client_id=mn-rt + PKCE → 302 到 /consent
 *   ③ POST <issuer>/api/consent          decision=allow → redirect_to 里有 code
 *   ④ POST <issuer>/oauth2/token          code + verifier → access_token（公共客户端无 secret）
 *   ⑤ 同一 access_token 打到本地 mn-rt 的 /auth/verify → 设备令牌 + sessionKey
 *   ⑥ GET  <local>/my/devices            按属主过滤的设备列表
 *   ⑦ 重放同一个 code 必须失败；换错 verifier 必须失败
 *
 * 跑法：node .tool/chaincheck/run.cjs
 * 口令只从环境变量读，绝不写进文件。
 */

const crypto = require('crypto');
const { URL } = require('url');

const ISSUER = process.env.RT_CHECK_ISSUER || 'http://47.110.80.47:8082';
const LOCAL = process.env.RT_CHECK_LOCAL || 'http://127.0.0.1:8799';
const USERNAME = process.env.GOAH_USERNAME || 'test';
const PASSWORD = process.env.GOAH_PASSWORD || '';
const CLIENT_ID = 'mn-rt';
// redirect_uri 不写死：从 <local>/auth/oidc/config 读服务端公布的值。
// 这正是 fr 必须采取的做法——绑定地址由依赖方决定，客户端抄一份常量
// 迟早和它的白名单漂移，而漂移的表现是"authorize 一直 400"。
let REDIRECT_URI = null;

const b64url = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 手工发请求：要能拿到 302 的 Location 而不自动跟随，fetch 做不到这么直白。 */
function request(method, urlStr, { headers = {}, body, form } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const http = require('http');
    const payload = form ? new URLSearchParams(form).toString()
      : (body !== undefined ? JSON.stringify(body) : undefined);
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : (body !== undefined ? { 'Content-Type': 'application/json' } : {})),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: 20000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        raw,
        json: (() => { try { return JSON.parse(raw); } catch { return null; } })(),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

const results = [];
function check(name, ok, detail) {
  results.push([ok, name, detail]);
  const tag = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${tag} ${name}${ok ? '' : `\n      ${detail}`}`);
}

async function main() {
  if (!PASSWORD) {
    // 显式 SKIPPED + 独立退出码 3。没口令就跑不了是常态（CI 里就没有），
    // 但绝不能因此报 0——"没执行"不该在任何人眼里长得像"测过了"；
    // 也不该混进 1（那是真失败）。
    console.log('SKIPPED（未执行）：需要 GOAH_PASSWORD；口令只走环境变量，不落盘、不入库。');
    console.log('  GOAH_PASSWORD=xxx node test/prod-verify/chain-check.cjs');
    process.exit(3);
  }

  console.log(`\n== 真实链路验收：${ISSUER} + ${LOCAL} ==\n`);

  // ⓪ 服务端公布的参数（fr 的 RemoteTypeEndpoint.authConfig() 就是这一步）
  const cfgRes = await request('GET', `${LOCAL}/auth/oidc/config`);
  const cfg = cfgRes.json || {};
  REDIRECT_URI = cfg.redirectUri || '';
  check('⓪ mn-rt 已连上认证中心（idpAvailable 来自发现文档，不是拼的）',
    cfg.enabled === true && cfg.idpAvailable === true && !!REDIRECT_URI,
    `HTTP ${cfgRes.status} ${cfgRes.raw.slice(0, 240)}`);
  check('⓪b 公布的 redirect_uri 形状受白名单约束（回环 + 逐字 /callback）',
    /^http:\/\/(127\.0\.0\.1|localhost):\d+\/callback$/.test(REDIRECT_URI),
    REDIRECT_URI);
  check('⓪c 公开配置里没有任何 secret',
    !/client_secret|jwtSecret/i.test(cfgRes.raw), cfgRes.raw.slice(0, 200));
  if (!REDIRECT_URI) return finish();

  // ① 登录
  const login = await request('POST', `${ISSUER}/api/login`, {
    body: { username: USERNAME, password: PASSWORD, return_to: '' },
  });
  const setCookie = login.headers['set-cookie'] || [];
  const cookie = setCookie.map((c) => c.split(';')[0])
    .filter((c) => c.startsWith('idp_session='))
    .join('; ');
  check('① 统一登录拿到 idp_session', !!cookie, `HTTP ${login.status} ${login.raw.slice(0, 200)}`);
  if (!cookie) return finish();

  // ② authorize（不跟随重定向，从 Location 里取 consent 参数）
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const nonce = b64url(crypto.randomBytes(16));
  const authzQ = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: 'openid profile email', state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  const r2 = await request('GET', `${ISSUER}/oauth2/auth?${authzQ}`, { headers: { Cookie: cookie } });
  const loc2 = r2.headers.location || '';
  check('② mn-rt 作为 client 可通过授权（302 到确认页）',
    r2.status === 302 && loc2.includes('/consent'),
    `HTTP ${r2.status} location=${loc2.slice(0, 160)} body=${r2.raw.slice(0, 200)}`);
  if (r2.status !== 302) return finish();

  const cq = new URLSearchParams(loc2.split('?')[1] || '');

  // ③ consent：允许
  const r3 = await request('POST', `${ISSUER}/api/consent`, {
    headers: { Cookie: cookie },
    body: {
      client_id: cq.get('client_id') || CLIENT_ID,
      redirect_uri: cq.get('redirect_uri') || REDIRECT_URI,
      scope: cq.get('scope') || 'openid profile email',
      state: cq.get('state') || state,
      nonce: cq.get('nonce') || nonce,
      code_challenge: cq.get('code_challenge') || challenge,
      code_challenge_method: cq.get('code_challenge_method') || 'S256',
      decision: 'allow',
    },
  });
  const redirectTo = (r3.json && r3.json.redirect_to) || '';
  const code = new URLSearchParams((redirectTo.split('?')[1]) || '').get('code') || '';
  check('③ 确认授权后回带 code', !!code, `HTTP ${r3.status} ${r3.raw.slice(0, 240)}`);
  if (!code) return finish();

  // ④ CLI/fr 侧真正关心的是"换得到身份"。先本地换，证明 PKCE 互操作成立。
  const r4 = await request('POST', `${ISSUER}/oauth2/token`, {
    form: {
      grant_type: 'authorization_code', code, client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI, code_verifier: verifier,
    },
  });
  const accessToken = (r4.json && r4.json.access_token) || '';
  check('④ 公共客户端 + PKCE 换到 access_token（无 secret）',
    r4.status === 200 && !!accessToken,
    `HTTP ${r4.status} ${r4.raw.slice(0, 240)}`);
  check('④b 认证中心不返回 refresh_token 给公共客户端也不影响本链路', true,
    `refresh_token=${r4.json && r4.json.refresh_token ? '有(不落地即可)' : '无'}`);
  if (!accessToken) return finish();

  // ⑤ 本地 mn-rt 用这枚 access_token 换自己的设备令牌
  const cid = 'chaincheck-pc';
  const r5 = await request('POST', `${LOCAL}/auth/verify`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: { clientId: cid, deviceName: '链路验收机' },
  });
  const grant = r5.json || {};
  check('⑤ mn-rt 认得认证中心的 token 并签发设备令牌',
    !!grant.ok && !!grant.token, `HTTP ${r5.status} ${r5.raw.slice(0, 240)}`);
  check('⑤b 同时下发会话密钥（取代人工配对 key）', !!grant.sessionKey,
    `HTTP ${r5.status} ${r5.raw.slice(0, 200)}`);
  if (!grant.token) return finish();

  // ⑥ 属主视角的设备列表
  const r6 = await request('GET', `${LOCAL}/my/devices`, {
    headers: { Authorization: `Bearer ${grant.token}` },
  });
  const mine = (r6.json && r6.json.devices) || [];
  // 按 clientId 判定，不写死"恰好一台"：这台机器上跑过多少次验收、
  // push-check 又登记了几台，都会让这个数增长。原断言 mine.length === 1
  // 测的是"登记表空不空"，不是"我的设备在不在列表里"——一旦别的验收脚本
  // 登记过设备就必然误红，而误红的代价是让人去查一个不存在的产品问题。
  const here = mine.find((d) => d.clientId === cid);
  check('⑥ /my/devices 能看到刚登记的那台，且带 sessionKey',
    !!here && !!here.sessionKey,
    `HTTP ${r6.status} 共 ${mine.length} 台：${mine.map((d) => d.clientId).join(', ')} | ${r6.raw.slice(0, 160)}`);
  check('⑥b 列表里每台都只属于当前属主（跨用户零可见）',
    mine.length > 0 && mine.every((d) => String(d.owner) === String(grant.userId)),
    `owners=${mine.map((d) => d.owner).join(', ')}`);
  check('⑥c 属主是认证中心的 sub，不是邮箱',
    !!r6.json && !!r6.json.userId && String(r6.json.userId) === String(grant.userId),
    `userId=${r6.json && r6.json.userId}`);

  // ⑦ 两条安全断言：code 不可重放、verifier 不可替换
  const replay = await request('POST', `${ISSUER}/oauth2/token`, {
    form: {
      grant_type: 'authorization_code', code, client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI, code_verifier: verifier,
    },
  });
  check('⑦ 同一 code 重放必须被拒', replay.status >= 400,
    `HTTP ${replay.status} ${replay.raw.slice(0, 200)}`);

  // 重新走一遍拿新 code，只换 verifier
  const v2 = b64url(crypto.randomBytes(32));
  const c2 = b64url(crypto.createHash('sha256').update(v2).digest());
  const a2 = await request('GET', `${ISSUER}/oauth2/auth?${new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: 'openid profile email', state, nonce,
    code_challenge: c2, code_challenge_method: 'S256',
  })}`, { headers: { Cookie: cookie } });
  const l2 = a2.headers.location || '';
  const q2 = new URLSearchParams(l2.split('?')[1] || '');
  const cn2 = await request('POST', `${ISSUER}/api/consent`, {
    headers: { Cookie: cookie },
    body: {
      client_id: q2.get('client_id') || CLIENT_ID,
      redirect_uri: q2.get('redirect_uri') || REDIRECT_URI,
      scope: q2.get('scope') || 'openid profile email',
      state: q2.get('state') || state, nonce: q2.get('nonce') || nonce,
      code_challenge: q2.get('code_challenge') || c2,
      code_challenge_method: q2.get('code_challenge_method') || 'S256',
      decision: 'allow',
    },
  });
  const code2 = new URLSearchParams(((cn2.json && cn2.json.redirect_to) || '').split('?')[1] || '').get('code') || '';
  const wrong = await request('POST', `${ISSUER}/oauth2/token`, {
    form: {
      grant_type: 'authorization_code', code: code2, client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI, code_verifier: 'SOME_OTHER_VERIFIER_VALUE',
    },
  });
  check('⑦b 换错 PKCE verifier 必须被拒', wrong.status >= 400 && !wrong.json?.access_token,
    `HTTP ${wrong.status} ${wrong.raw.slice(0, 200)}`);

  // ⑧ 跨属主必须不可见：另一次登录（同账号会拿到同一 sub，所以这里只能验"未登记设备拿不到"）
  const stranger = await request('GET', `${LOCAL}/my/devices`, {
    headers: { Authorization: 'Bearer not.a.token' },
  });
  check('⑧ 伪造令牌查设备列表 → 401', stranger.status === 401, `HTTP ${stranger.status}`);

  finish();
}

function finish() {
  const bad = results.filter(([ok]) => !ok);
  console.log(`\n========================================\n  通过 ${results.length - bad.length}   失败 ${bad.length}\n========================================\n`);
  process.exit(bad.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本崩溃：', e); process.exit(1); });
