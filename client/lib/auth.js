'use strict';

/**
 * PC 端统一登录：`remotetype auth login`。
 *
 * 流程（全程零复制粘贴）：
 *   ① GET  <server>/auth/oidc/config     问服务端"认证中心在哪、用哪个 client"
 *   ② 本机 127.0.0.1:<随机端口> 起一次性监听，生成 PKCE，打开系统浏览器
 *   ③ 用户在认证中心登录 → 302 回本机监听 → 拿到 code
 *   ④ 用 code + verifier 直接在**认证中心**换 access_token（公共客户端，无 secret）
 *   ⑤ 带 Bearer 调 <server>/auth/verify → 换回本服务的设备令牌 + 会话密钥
 *      （多账号时先裸体调一次做**身份预检**，拿到身份再决定用哪个 clientId 登记：
 *        同账号沿用原标识，新账号领新标识——服务端的 clientId→属主 是永久一对一的）
 *   ⑥ 落盘到配置文件，之后 `serve` 静默携带
 *
 * ── 为什么第 ④ 步由 CLI 自己换、而不是把 code 交给服务端换 ──────────────
 * 交给服务端换需要服务端自己发起 authorize 并持有 PKCE verifier——那就多一份 RP 会话
 * （cookie/存储）要实现。没有它，服务端在 GET 回调上收到 code 也用不了，
 * 所以那个地址干脆不登记进认证中心白名单（登记了只会把故障变成一个没有解释的 404）。
 * CLI 自己换 token 则只需登记回环通配（127.0.0.1 端口任意、路径固定 /callback）——
 * 这是 RFC 8252 给原生客户端的标准做法，一步到位且零复制粘贴。
 * （那条地址在这里刻意不逐字写：它是"星号紧跟斜杠"的形式，出现在块注释里会提前
 *   把注释闭合掉，本项目真实踩过一次，症状是文件后半段被当成代码。）
 *
 * ── 跨设备登录的已知边界 ────────────────────────────────────────────────
 * 回环意味着"浏览器必须和 CLI 在同一台机器上"。在无桌面的机器上（SSH 过去跑的 CLI），
 * 用 `auth login --no-open` 拿到地址后在本地浏览器打开，再把本机的回调端口
 * 用 `ssh -L` 转过去即可；认证中心对 127.0.0.1 是端口通配的，所以端口不必对齐。
 *
 * ── 为什么这里不存 refresh_token ────────────────────────────────────────
 * 第 ④ 步换到的 refresh_token 直接丢弃。CLI 真正需要长期持有的是第 ⑤ 步
 * 服务端签发的**设备令牌**——它可被服务端吊销，而 refresh_token 一旦落到
 * 每台 PC 的磁盘上，就是把"谁拿到谁可用 7 天"的凭据复制到 N 台机器。
 * 令牌过期后重新 `auth login` 一次即可，浏览器通常还有认证中心会话，是无感的。
 */

const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { URL } = require('url');

/** CLI 侧回环回调地址。端口 0 让内核分配，再回填进 authorize 请求。 */
const LOOPBACK_PATH = '/callback';
/** 等用户完成登录的时间上限。超时就收摊，不留一个僵尸监听。 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 生成 PKCE 与一次性参数。
 *
 * 注意 state 只有**一个**值：authorizeParams 里的那个就是真正发出去的，
 * 也是回调回来后要比对的。这里曾经同时返回 req.state 和 authorizeParams.state
 * 两个独立随机值，而调用方先 set('state', req.state) 再整体覆盖 authorizeParams，
 * 于是实际发出的是后者、比对的是前者——**每次登录都必然报 state 不一致**。
 */
function createAuthRequest(redirectUri) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  return {
    verifier,
    state,
    nonce: b64url(crypto.randomBytes(16)),
    authorizeParams: {
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    },
  };
}

/**
 * 起一次性回环监听，等浏览器把 code 送回来。
 * @returns {{uri: string, wait: () => Promise<{code:string, state:string}>, close: () => void}}
 */
function openLoopback() {
  let server;
  let resolveFn;
  let rejectFn;
  const got = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          const u = new URL(req.url, 'http://127.0.0.1');
          if (u.pathname !== LOOPBACK_PATH) { res.writeHead(404).end(); return; }
          const err = u.searchParams.get('error');
          if (err) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              .end('<h3>授权未通过</h3><p>可以关闭这个页面了。</p>');
            rejectFn(new Error(`授权被拒绝：${err}`));
            return;
          }
          const code = u.searchParams.get('code');
          const state = u.searchParams.get('state');
          if (!code) { rejectFn(new Error('回调里没有 code')); return; }
          // 回调页是给用户看的，必须自解释——否则用户不知道"能不能关窗口"
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end('<h3>✅ 已收到授权</h3><p>可以关闭浏览器，回到终端了。</p>');
          resolveFn({ code, state });
        });
        server.once('error', reject);
        // 只绑 127.0.0.1：绑 0.0.0.0 会让同网段任何人都能来抢这个 code
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          resolve(`http://127.0.0.1:${port}${LOOPBACK_PATH}`);
        });
      });
    },
    wait: (ms = LOGIN_TIMEOUT_MS) => Promise.race([
      got,
      new Promise((_, rej) => setTimeout(() => rej(new Error('登录超时（5 分钟未完成）')), ms)
        .unref?.()),
    ]),
    close() { try { server && server.close(); } catch { /* ignore */ } },
  };
}

/**
 * 各平台打开浏览器的命令与参数。
 *
 * ── Windows 为什么绝不借道 `cmd /c start` ────────────────────────────────
 * 授权 URL 里全是 `&`。Node execFile 对不含空格的参数不加引号，命令行到达
 * cmd.exe 后 `&` 被**当成命令分隔符**：浏览器只收到第一个 `&` 之前的
 * `?client_id=mn-rt`，redirect_uri / code_challenge 全被切掉，报
 * 「redirect_uri 未在白名单内」；被切下来的尾段还被 cmd 当命令执行，而
 * stdio:'ignore' 把那串报错吞得干干净净——故障看起来像"白名单没配对"。
 * rundll32 的 FileProtocolHandler 不经任何 shell 解析，CreateProcess 的
 * 命令行原样到达，`&` 安然无恙。这是 Windows 上程序化开 URL 的经典做法。
 */
function openBrowserArgs(platform, url) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

function openBrowser(url) {
  const [cmd, args] = openBrowserArgs(process.platform, url);
  // detached + stdio ignore：不阻塞 CLI，也不让浏览器的输出灌进终端
  execFile(cmd, args, { detached: true, stdio: 'ignore' }, (e) => {
    if (e) {
      // 打不开也得让用户有路可走：地址永远已经在上面打印过一份
      process.stderr.write(`自动打开浏览器失败（${e.message.split('\n')[0]}），请手动打开上面打印的授权地址\n`);
    }
  });
}

/** 向任意 URL 发 JSON / 表单请求并解析 JSON。用内置 http，不引 fetch polyfill。 */
function postJson(urlStr, { body, headers = {}, form } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { reject(new Error(`非法地址: ${urlStr}`)); return; }
    const payload = form ? new URLSearchParams(form).toString() : JSON.stringify(body || {});
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: 15_000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : {}, raw });
        } catch {
          // 返回 HTML 而不是 JSON（网关错误页、地址写错到别的服务）必须单独成类，
          // 否则上层会把它当"认证失败"处理，方向完全错
          reject(new Error(`响应不是 JSON (HTTP ${res.statusCode}): ${raw.slice(0, 160)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

function getJson(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    http.get({ method: 'GET', hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers, timeout: 15_000 },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : {} }); }
          catch { reject(new Error(`响应不是 JSON (HTTP ${res.statusCode})`)); }
        });
      }).on('error', reject).on('timeout', function onTimeout() { this.destroy(new Error('请求超时')); });
  });
}

/**
 * 拿认证中心的 access_token 换本服务的令牌（POST /auth/verify），并归一化返回值。
 *
 * **clientId 缺省时是"身份预检"**：服务端只签发用户令牌（cid=''），
 * 不登记任何设备、不产生任何服务端状态，纯粹回答"这次登录的是谁"。
 * 多账号就靠这一跳先探明身份，再决定用哪个 clientId 去正式登记。
 *
 * @param {{serverHttp:string, accessToken:string, clientId?:string, deviceName?:string}} args
 * @returns {Promise<object>} 归一化结果（含 token / userId / sessionKey / device）
 * @throws {Error} 服务端拒绝时抛出；错误码放在 err.code（如 device_owned_by_other）
 */
async function verifyExchange({ serverHttp, accessToken, clientId, deviceName }) {
  const base = String(serverHttp || '').replace(/\/+$/, '');
  const body = {};
  if (clientId) body.clientId = clientId;
  // 空 deviceName 不必发送：服务端 deviceName 的兜底链是
  // `deviceName || prev.deviceName || clientId`，省略与空串等价。
  if (deviceName) body.deviceName = deviceName;

  const res = await postJson(`${base}/auth/verify`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    body,
  });
  const j = res.json || {};
  if (!res.status || res.status >= 400 || !j.ok || !j.token) {
    const err = new Error(`服务端拒绝签发令牌：${j.message || j.error || `HTTP ${res.status}`}`);
    err.code = j.error || `http_${res.status}`;
    throw err;
  }
  return {
    token: j.token,
    tokenExpiresAt: j.tokenExpiresAt,
    userId: j.userId,
    email: j.email || '',
    username: j.username || '',
    nickname: j.nickname || '',
    sessionKey: j.sessionKey || '',
    device: j.device || null,
    serverHttp: base,
  };
}

/**
 * 组 authorize 地址。
 *
 * `promptLogin=true` 时带 OIDC 标准的 `prompt=login`：让认证中心**强制重新登录**，
 * 供"换个人登录"用。认证中心如果不支持该参数会忽略它，行为退回普通登录，
 * 所以带着它总是安全的（实测 auth-hub 对未知 prompt 值不报错）。
 * @param {object} cfg  /auth/oidc/config 的返回（issuer/clientId/scopes/端点）
 * @param {object} req  createAuthRequest 的返回（state/nonce/authorizeParams）
 * @param {{promptLogin?: boolean}} [opts]
 * @returns {string} 完整 authorize URL
 */
function buildAuthorizeUrl(cfg, req, { promptLogin = false } = {}) {
  const authorizeUrl = new URL(cfg.authorizationEndpoint || `${cfg.issuer}/oauth2/auth`);
  authorizeUrl.searchParams.set('client_id', cfg.clientId);
  authorizeUrl.searchParams.set('scope', (cfg.scopes || ['openid', 'profile', 'email']).join(' '));
  authorizeUrl.searchParams.set('state', req.state);
  authorizeUrl.searchParams.set('nonce', req.nonce);
  for (const [k, v] of Object.entries(req.authorizeParams)) authorizeUrl.searchParams.set(k, v);
  if (promptLogin) authorizeUrl.searchParams.set('prompt', 'login');
  return authorizeUrl.toString();
}

/**
 * 完整登录一次。
 * @param {object} opts
 * @param {string} opts.serverHttp  服务端 HTTP 基址，如 http://1.94.101.189:8790
 * @param {string} opts.clientId    本机稳定 clientId（ensureClientId 产物）
 * @param {string} [opts.deviceName]
 * @param {boolean} [opts.noOpen]   只打印地址不弹浏览器（SSH / 无桌面环境）
 * @param {(url:string)=>void} [opts.onUrl]
 * @param {(identity:object, prevErr:Error|null)=>
 *   Promise<{clientId:string, deviceName?:string, retryOnOwnedByOther?:boolean}>} [opts.resolveClientId]
 *   多账号回调：拿到身份后决定用哪个 clientId 登记（详见第 ⑤ 步注释）。
 *   不传时退化为原来的单跳流程，行为逐字节一致。
 * @param {boolean} [opts.promptLogin] authorize 带 prompt=login，强制认证中心重新登录
 *   （换人登录用；认证中心不支持时忽略，等于普通登录）
 */
async function authLogin(opts) {
  const base = (opts.serverHttp || '').replace(/\/+$/, '');
  if (!base) throw new Error('缺少服务端地址（--url 或配置文件）');

  const cfgRes = await getJson(`${base}/auth/oidc/config`);
  const cfg = cfgRes.json || {};
  if (!cfg.enabled) {
    throw new Error('服务端未开启统一登录（RT_AUTH_ENABLED）。'
      + '旧用法仍可用：serve --key <配对key>');
  }
  if (!cfg.issuer || !cfg.clientId) {
    throw new Error(`服务端统一登录配置不完整：${JSON.stringify(cfg)}`);
  }

  const lb = openLoopback();
  const redirectUri = await lb.start();
  const req = createAuthRequest(redirectUri);

  const authorizeUrl = new URL(buildAuthorizeUrl(cfg, req, { promptLogin: opts.promptLogin === true }));

  if (opts.onUrl) opts.onUrl(authorizeUrl.toString());
  if (opts.noOpen) {
    lb.close();
    return { authorizeUrl: authorizeUrl.toString(), redirectUri, pending: true };
  }
  openBrowser(authorizeUrl.toString());

  let callback;
  try {
    callback = await lb.wait();
  } finally {
    lb.close();
  }
  // state 不匹配只有两种可能：回调被串了，或有人在伪造一次登录完成。都必须中止。
  if (callback.state !== req.state) throw new Error('state 不一致，已中止登录');

  // ④ CLI 自己换 token（公共客户端 + PKCE，无 secret）
  const tokRes = await postJson(cfg.token_endpoint || `${cfg.issuer}/oauth2/token`, {
    form: {
      grant_type: 'authorization_code',
      code: callback.code,
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      code_verifier: req.verifier,
    },
  });
  const tok = tokRes.json || {};
  if (!tokRes.status || tokRes.status >= 400 || !tok.access_token) {
    throw new Error(`换 token 失败：${tok.error || tokRes.raw || `HTTP ${tokRes.status}`}`);
  }

  // ⑤ 换本服务的设备令牌 + 会话密钥。refresh_token 到此为止：不传、不落盘。
  //
  // 多账号（给了 resolveClientId）时多一跳**身份预检**：先不带 clientId 换一次
  // 用户令牌——服务端此时不登记任何设备，只回答"这次登录的是谁"。知道是谁之后，
  // 才能决定用哪个 clientId 去正式登记：同一账号沿用原标识（只换令牌、绑定与
  // 会话密钥都不变），新账号领一个新标识。服务端的 clientId→属主 是永久一对一，
  // 拿别人的标识去登记会被 403 顶回来——所以顺序只能是"先知身份、后选标识"。
  let decision = null;
  let res;
  if (typeof opts.resolveClientId === 'function') {
    let identity;
    try {
      identity = await verifyExchange({ serverHttp: base, accessToken: tok.access_token });
    } catch (e) {
      // 保留错误码：调用方可能按 code 分辨"令牌无效"还是"服务端没开统一登录"
      const err = new Error(`身份预检失败：${e.message}`);
      err.code = e.code;
      throw err;
    }
    const choose = (prevErr) => opts.resolveClientId(identity, prevErr);
    decision = (await choose(null)) || {};
    try {
      res = await verifyExchange({
        serverHttp: base,
        accessToken: tok.access_token,
        clientId: decision.clientId || opts.clientId,
        deviceName: decision.deviceName || opts.deviceName,
      });
    } catch (e) {
      // 兜底：老配置被清过、机器默认标识其实早已被别的账号登记 → 换新标识再试一次。
      // 只对"机器默认标识"这条路生效（retryOnOwnedByOther）。条目复用的路径上撞 403
      // 意味着服务端状态与本地不一致，必须如实报出来，不能自己换个 id 蒙混过去。
      if (e.code === 'device_owned_by_other' && decision.retryOnOwnedByOther) {
        decision = (await choose(e)) || {};
        res = await verifyExchange({
          serverHttp: base,
          accessToken: tok.access_token,
          clientId: decision.clientId || opts.clientId,
          deviceName: decision.deviceName || opts.deviceName,
        });
      } else {
        throw e;
      }
    }
  } else {
    res = await verifyExchange({
      serverHttp: base,
      accessToken: tok.access_token,
      clientId: opts.clientId,
      deviceName: opts.deviceName,
    });
  }

  // 交回调用方两样它自己推不出来的东西：
  //   clientId  —— 这次实际登记的标识（cfg.clientId 未必等于它：新账号领的是新标识）
  //   deviceName —— 这次实际用的设备名（可能沿用条目里存的那个，不是 cfg.deviceName）
  // 有 decision 却没 clientId 说明决策链出了岔子：宁可当场炸，也不要静默换回一个
  // cid='' 的用户令牌（那种令牌永远注册不成 pc）。
  const usedClientId = (decision && decision.clientId) || opts.clientId || '';
  if (opts.resolveClientId && !usedClientId) {
    throw new Error('登录决策没有给出 clientId（内部错误）：请反馈这个现象');
  }
  return {
    ...res,
    clientId: usedClientId,
    deviceName: (decision && decision.deviceName) || opts.deviceName || '',
  };
}

module.exports = {
  authLogin,
  buildAuthorizeUrl,
  verifyExchange,
  getJson,
  postJson,
  createAuthRequest,
  openLoopback,
  openBrowserArgs,
};
