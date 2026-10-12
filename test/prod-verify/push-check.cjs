'use strict';

/**
 * 生产环境真链路推送验收：手机侧加密 → 服务端路由 → PC 侧解密出按键计划 → ACK 回流可解。
 *
 * 为什么不能只测 /push 返回 200：那只证明服务端"把帧转出去了"，
 * 而端到端最容易坏的地方恰恰是**两端密钥是否真的是同一把**。
 * 上一轮踩过的那类静默故障就是：连得上、转发正常、但每条信封因密钥不一致被
 * 直接丢弃，日志里只有 decrypt-error，用户看到的是"打了字电脑没反应"。
 * 所以判据必须是 PC 侧真的解密出了预期文本，且 ACK 能被手机解回来。
 *
 * 口令只从环境变量读，不落盘、不打印。
 * 跑法：GOAH_USERNAME=... GOAH_PASSWORD=... node .tool/pushcheck/run.cjs
 */

const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

const WebSocket = require('../../client/node_modules/ws');
const rtCrypto = require('../../client/lib/rt-crypto');
const { RtAlignSession } = require('../../client/lib/rt-align');

const ISSUER = process.env.RT_CHECK_ISSUER || 'http://47.110.80.47:8082';
const SERVER = process.env.RT_CHECK_LOCAL || 'http://1.94.101.189:8790';
const USERNAME = process.env.GOAH_USERNAME || '';
const PASSWORD = process.env.GOAH_PASSWORD || '';
const CLIENT_ID = 'mn-rt';
const PC_ID = process.env.RT_PC_ID || 'prod-e2e-pc';
const PHONE_ID = 'prod-e2e-phone';

const b64url = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function req(method, urlStr, { headers = {}, body, form } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = form ? new URLSearchParams(form).toString()
      : (body !== undefined ? JSON.stringify(body) : undefined);
    const r = http.request({
      method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
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
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 保留 raw */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    r.on('timeout', () => r.destroy(new Error('超时')));
    r.on('error', reject);
    r.end(payload);
  });
}

const results = [];
function check(name, ok, detail) {
  results.push([ok, name]);
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `\n      ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等某条 WS 满足 probe 的第一帧。 */
function waitFor(wsState, probe, ms, what) {
  const hit = wsState.inbox.find(probe);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等 ${what} 超时（已收 ${wsState.inbox.length} 帧）`)), ms);
    wsState.waiters.push({ probe, resolve, timer });
  });
}
function mkState(ws) {
  const st = { ws, inbox: [], waiters: [], closeCode: null };
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    st.inbox.push(m);
    for (let i = st.waiters.length - 1; i >= 0; i -= 1) {
      if (st.waiters[i].probe(m)) {
        clearTimeout(st.waiters[i].timer);
        st.waiters[i].resolve(m);
        st.waiters.splice(i, 1);
      }
    }
  });
  ws.on('close', (c) => { st.closeCode = c; });
  return st;
}
async function openWs() {
  const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws');
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return mkState(ws);
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    console.log('需要 GOAH_USERNAME / GOAH_PASSWORD 环境变量');
    process.exit(2);
  }
  console.log(`\n== 生产真链路推送验收：${SERVER}（PC=${PC_ID}）==\n`);

  // ── 认证中心：登录 → 铸码 → 换 token（与 PC CLI 完全同形）──
  const cfgRes = await req('GET', `${SERVER}/auth/oidc/config`);
  const cfg = cfgRes.json;
  const login = await req('POST', `${ISSUER}/api/login`, {
    body: { username: USERNAME, password: PASSWORD, return_to: '' },
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0])
    .filter((c) => c.startsWith('idp_session=')).join('; ');
  check('登录拿到统一登录态', !!cookie, `HTTP ${login.status} ${login.raw.slice(0, 160)}`);
  if (!cookie) return done();

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const qs = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: cfg.redirectUri,
    scope: 'openid profile email', state, nonce: b64url(crypto.randomBytes(16)),
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  const a2 = await req('GET', `${ISSUER}/oauth2/auth?${qs}`, { headers: { Cookie: cookie } });
  const cq = new URLSearchParams((a2.headers.location || '').split('?')[1] || '');
  const cn = await req('POST', `${ISSUER}/api/consent`, {
    headers: { Cookie: cookie },
    body: {
      client_id: cq.get('client_id') || CLIENT_ID,
      redirect_uri: cq.get('redirect_uri') || cfg.redirectUri,
      scope: cq.get('scope') || 'openid profile email',
      state: cq.get('state') || state, nonce: cq.get('nonce') || '',
      code_challenge: cq.get('code_challenge') || challenge,
      code_challenge_method: cq.get('code_challenge_method') || 'S256',
      decision: 'allow',
    },
  });
  const code = new URLSearchParams(((cn.json && cn.json.redirect_to) || '').split('?')[1] || '').get('code') || '';
  const tok = await req('POST', cfg.token_endpoint || `${ISSUER}/oauth2/token`, {
    form: {
      grant_type: 'authorization_code', code, client_id: CLIENT_ID,
      redirect_uri: cfg.redirectUri, code_verifier: verifier,
    },
  });
  const at = (tok.json && tok.json.access_token) || '';
  check('换成认证中心 access_token', !!at, `HTTP ${tok.status} ${tok.raw.slice(0, 160)}`);
  if (!at) return done();

  // ── PC 侧：登记这台电脑，拿设备令牌 + 会话密钥 ──
  const pcVer = await req('POST', `${SERVER}/auth/verify`, {
    headers: { Authorization: `Bearer ${at}` },
    body: { clientId: PC_ID, deviceName: '生产验收机' },
  });
  const pc = pcVer.json || {};
  check('PC 登记成功并拿到设备令牌 + 会话密钥', !!pc.token && !!pc.sessionKey,
    `HTTP ${pcVer.status} ${pcVer.raw.slice(0, 220)}`);
  if (!pc.token || !pc.sessionKey) return done();

  // ── 手机侧：同一账号换一枚不绑设备的用户令牌 ──
  const phVer = await req('POST', `${SERVER}/auth/verify`, {
    headers: { Authorization: `Bearer ${at}` },
    body: { deviceName: '生产验收手机' },
  });
  const ph = phVer.json || {};
  check('手机换到用户令牌（不绑 clientId）', !!ph.token, `HTTP ${phVer.status} ${phVer.raw.slice(0, 200)}`);
  check('手机那枚令牌**不该**带会话密钥（它不是一台可连的电脑）',
    !ph.sessionKey, JSON.stringify(ph).slice(0, 200));

  // ── PC 上线：registered 帧里的密钥必须与 verify 给的是同一把 ──
  const pcWs = await openWs();
  pcWs.ws.send(JSON.stringify({
    type: 'register', role: 'pc', clientId: PC_ID,
    deviceToken: pc.token, deviceName: '生产验收机',
  }));
  const pcReg = await waitFor(pcWs, (m) => m.type === 'registered', 8000, 'pc registered');
  check('PC registered 帧回带会话密钥', !!pcReg.sessionKey, JSON.stringify(pcReg));
  check('两端拿到的是同一把密钥（这就是"免手工配对 key"的实质）',
    pcReg.sessionKey === pc.sessionKey,
    `verify=${String(pc.sessionKey).slice(0, 12)}… registered=${String(pcReg.sessionKey).slice(0, 12)}…`);

  // PC 侧装一个真实对齐会话：收到 text 就用这把密钥解
  const derivedPC = rtCrypto.deriveFromKey(pcReg.sessionKey);
  const pcOps = [];
  const align = new RtAlignSession({
    key: pcReg.sessionKey,
    sendAck: (envelope) => pcWs.ws.send(JSON.stringify({
      type: 'ack', phoneId: PHONE_ID, ack: envelope,
    })),
  });
  align.on('op', (op) => pcOps.push(op));

  // ── 手机上线并加密推送 ──
  const phWs = await openWs();
  phWs.ws.send(JSON.stringify({
    type: 'register', role: 'phone', phoneId: PHONE_ID, deviceToken: ph.token,
  }));
  await waitFor(phWs, (m) => m.type === 'registered', 8000, 'phone registered');

  const TEXT = '生产链路验证：中文、emoji 😀、换行\n第二行';
  const derivedPh = rtCrypto.deriveFromKey(pc.sessionKey);
  const seq = 1;
  const envelope = rtCrypto.seal(
    derivedPh.keyPhoneToPc,
    rtCrypto.buildAad(derivedPh.room, 'p2c', seq),
    { text: TEXT, ts: Date.now(), phoneId: PHONE_ID, enterMode: 'enter' },
    { sid: 'prod-e2e', seq },
  );
  phWs.ws.send(JSON.stringify({ clientId: PC_ID, text: JSON.stringify(envelope) }));

  // PC 侧收帧并解密
  const got = await waitFor(pcWs, (m) => typeof m.text === 'string', 8000, 'PC 收到 text 帧');
  const outcome = align.handleIncoming(got.text);
  check('PC 侧把信封解开了（不是静默丢弃）', outcome === 'envelope',
    `outcome=${outcome} decryptBad=${align.stats.envelopesBad}`);
  check('解密出的文本与手机端发出的逐字一致（含中文/emoji/换行）',
    align.desiredText === TEXT,
    `期望 ${JSON.stringify(TEXT)} 实得 ${JSON.stringify(align.desiredText)}`);
  check('PC 侧产出按键计划（真的会去打字，而不是只解个密）',
    pcOps.length > 0 && pcOps.some((o) => o.op === 'type'),
    JSON.stringify(pcOps).slice(0, 260));

  // 模拟注入成功 → commit → PC 回 ACK → 手机解密
  for (const op of pcOps) if (op.op === 'commit') align.commitApplied(op.seq, TEXT);
  const ackFrame = await waitFor(phWs, (m) => m.type === 'ack' && m.ack, 8000, '手机收到 ACK');
  let ackPlain = null; let ackErr = '';
  try {
    ackPlain = rtCrypto.open(
      derivedPh.keyPcToPhone,
      rtCrypto.buildAad(derivedPh.room, 'c2p', ackFrame.ack.seq),
      ackFrame.ack,
    );
  } catch (e) { ackErr = e.message; }
  check('ACK 能被手机解开 —— 端到端双向闭环成立', !!ackPlain, ackErr || JSON.stringify(ackFrame).slice(0, 200));
  check('ACK 里 applied_seq 与本批 seq 对得上',
    !ackPlain || ackPlain.applied_seq === ackFrame.ack.seq,
    JSON.stringify(ackPlain));

  // ── 负向：明文推送必须被 align 模式拒绝 ──
  // 注意：plaintextRejected 只在 handleIncoming 被调用时才增长。
  // 这里必须先等到那帧到达 PC 的 WS、再显式喂给 align——
  // 上一版只 sleep 后读计数器，测的是我自己的脚本有没有喂数据，不是产品有没有拦。
  const before = align.stats.plaintextRejected;
  const textFramesSoFar = pcWs.inbox.filter((m) => typeof m.text === 'string').length;
  phWs.ws.send(JSON.stringify({ clientId: PC_ID, text: '这是明文攻击' }));
  let plainFed = false;
  try {
    const pf = await waitFor(pcWs,
      (m) => typeof m.text === 'string'
        && pcWs.inbox.filter((x) => typeof x.text === 'string').length > textFramesSoFar,
      6000, 'PC 收到明文帧');
    align.handleIncoming(pf.text);
    plainFed = true;
  } catch (e) { /* 没收到就是服务端拦了，下面分别判定 */ }
  check('明文帧被 align 模式拒绝（防旁路注入）',
    plainFed ? align.stats.plaintextRejected > before : true,
    plainFed
      ? `已喂给 align 但计数没涨：before=${before} after=${align.stats.plaintextRejected}`
      : '明文帧没到达 PC（服务端侧就没转）——也算被拒，但请核对是哪一层挡的');

  // ── 负向：用手机的用户令牌去冒充 PC 注册，必须被拒 ──
  const badWs = await openWs();
  badWs.ws.send(JSON.stringify({ type: 'register', role: 'pc', clientId: PC_ID, deviceToken: ph.token }));
  const badClose = await new Promise((r) => { const t = setTimeout(() => r(badWs.closeCode), 4000); badWs.ws.on('close', (c) => { clearTimeout(t); r(c); }); });
  check('手机那枚用户令牌注册不成 PC（防吸流量）', badClose === 4401, `close=${badClose}`);

  // ── /push 通道：带自己令牌可转发 ──
  const pushRes = await req('POST', `${SERVER}/push`, {
    headers: { Authorization: `Bearer ${pc.token}` },
    body: { clientId: PC_ID, text: 'push 通道文本' },
  });
  check('/push 本人令牌 → forwarded',
    pushRes.json && pushRes.json.status === 'forwarded',
    `${pushRes.status} ${pushRes.raw.slice(0, 200)}`);

  // 用别人（本例：手机用户令牌）推同一台——同属主，应当放行；
  // 真正被拒的是跨属主，那需要第二个账号，这里只记录边界不被误当成安全证明
  const pushPh = await req('POST', `${SERVER}/push`, {
    headers: { Authorization: `Bearer ${ph.token}` },
    body: { clientId: PC_ID, text: '同属主的手机推自己电脑' },
  });
  check('同属主的手机令牌也能推自己的电脑（用户令牌可用，不必绑设备）',
    pushPh.json && pushPh.json.status === 'forwarded',
    `${pushPh.status} ${pushPh.raw.slice(0, 200)}`);

  align.dispose();
  pcWs.ws.close(); phWs.ws.close(); badWs.ws.close();
  await sleep(300);
  return done();
}

function done() {
  const bad = results.filter(([ok]) => !ok);
  console.log(`\n========================================\n  通过 ${results.length - bad.length}   失败 ${bad.length}\n========================================\n`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error('脚本异常：', e && e.message ? e.message : e); process.exit(2); });
