'use strict';

/**
 * RemoteType 公网 Serve 服务端
 *
 * 职责（对应需求文档 4.1）：
 *   1. WebSocket 监听，同时接受「手机端」与「PC 客户端」两类连接
 *   2. 会话管理：PC 客户端上报 clientId，按 clientId 维护在线表
 *   3. 消息路由：手机端推送文本 -> 按 clientId 转发给对应在线 PC
 *   4. 消息持久化：jsonlines 记录 时间戳/clientId/text/转发状态
 *   5. 分级日志（控制台 + 文件）
 *   6. HTTP 测试接口：/push、/health、/stats、/records、/clients
 *   7. 优雅关闭
 *
 * 协议：
 *   手机端 -> 服务端  {"clientId":"pc-001","text":"..."}
 *   服务端 -> PC端    {"text":"..."}
 *   服务端 -> 手机端  {"ok":true,"status":"forwarded","clientId":"pc-001"}
 *                   {"ok":false,"status":"target_offline","clientId":"pc-001"}
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Logger } = require('./logger');
const { RecordStore } = require('./store');
const { AuthHub } = require('./auth');

/**
 * 从请求里取 Bearer。支持 `Authorization: Bearer x` 与 `?token=x` 两种，
 * 后者是为了让浏览器/ curl 手工调试不必处理 header；**设备令牌不走 query**
 * 的顾虑（会进访问日志）在这里不成立：本服务的日志不落 query 值。
 */
function bearerOf(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  try {
    const u = new URL(req.url, 'http://x');
    return u.searchParams.get('token') || '';
  } catch { return ''; }
}

/**
 * 设备记录的对外视图。
 *
 * 刻意不含任何签名密钥或令牌原文；`sessionKey` 是唯一敏感字段，
 * 而它**只在属主自己的响应里出现**（见 /my/devices 与 register 的返回）。
 */
function publicDevice(d) {
  return {
    clientId: d.clientId,
    deviceName: d.deviceName,
    owner: d.userId,
    email: d.email || '',
    registeredAt: d.registeredAt,
    lastSeenAt: d.lastSeenAt,
  };
}

/** 网页控制台静态文件白名单（相对 server/public，防目录穿越只放行清单内文件）。 */
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/rt1-core.js': { file: 'rt1-core.js', type: 'text/javascript; charset=utf-8' },
};

/**
 * 解析配置：默认值 + 环境变量 + 命令行参数。
 * 命令行参数优先级最高，例如：node server.js --port 9000
 */
function loadConfig(argv = process.argv.slice(2)) {
  const cli = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inlineValue] = arg.slice(2).split('=');
      const value = inlineValue !== undefined ? inlineValue : argv[i + 1];
      if (inlineValue === undefined) i += 1;
      cli[key] = value;
    }
  }

  const root = path.resolve(__dirname, '..');
  const num = (v, d) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };

  /**
   * 布尔开关解析：认 1/true/yes/on 与 0/false/no/off（大小写无关）。
   *
   * 写成 `v === 'true'` 是真实踩过的位置：`RT_AUTH_ENABLED=1` 是 compose 里最自然的
   * 写法，却会被判成 false —— 服务照常起、/auth/oidc/config 照答，整套属主隔离
   * **静默不存在**，而运维那边看起来是"配好了"。开关解析出错的方向只能是抛错，
   * 不能落到默认值上。所以这里遇到认不出的非空值直接抛，让容器起不来。
   *
   * 注意 `--auth-enabled` 这种裸命令行开关在上面的解析里会带 true（布尔），一并支持。
   */
  const bool = (v, d, name) => {
    if (v === undefined || v === null || v === '') return d;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
    throw new Error(`${name || '布尔开关'} 取值无法识别：${JSON.stringify(v)}（可用 1/true/yes/on 或 0/false/no/off）`);
  };

  const port = num(cli.port ?? process.env.RT_PORT, 8790);

  return {
    port,
    // WebSocket 挂在与 HTTP 同一个端口下，路径 /ws；手机上直接连 ws://host:port/ws 即可
    wsPath: cli.wsPath ?? process.env.RT_WS_PATH ?? '/ws',
    // 供客户端展示的对外地址
    publicUrl: cli.publicUrl ?? process.env.RT_PUBLIC_URL ?? null,
    logDir: cli.logDir ?? process.env.RT_LOG_DIR ?? path.join(root, 'logs'),
    recordFile:
      cli.recordFile ?? process.env.RT_RECORD_FILE ?? path.join(root, 'data', 'records.jsonl'),
    logLevel: cli.logLevel ?? process.env.RT_LOG_LEVEL ?? 'info',
    // 可选：客户端接入 token（MVP 默认关闭，V0.2 启用以满足鉴权需求）
    token: cli.token ?? process.env.RT_TOKEN ?? null,
    maxPayload: num(cli.maxPayload, 1024 * 100), // 100KB，防超大 payload

    // ── 统一登录（auth-hub / OIDC）────────────────────────────────────────
    // 默认关闭：关掉时所有鉴权判据短路、绝不碰网络，行为与改造前完全一致。
    // 这样这次改动可以先合进去而不影响任何现有部署，开启与否是部署决策。
    auth: {
      // 开关必须认 1/true/yes/on。写成 `=== 'true'` 是个真实踩过的位置：
      // docker-compose 里 `RT_AUTH_ENABLED=1` 是最自然的写法，而它会被判成 false——
      // 服务照常起、/auth/oidc/config 照答，整套属主隔离**静默不存在**，
      // 看起来"配了"。开关解析失败的方向必须是"响亮报错"或"按字面认"，
      // 绝不能是"默认关"。认不出来的值走下面 bool() 抛错。
      enabled: bool(cli.authEnabled ?? process.env.RT_AUTH_ENABLED, false, 'RT_AUTH_ENABLED'),
      // 必须与认证中心 IDP_ISSUER 逐字一致，且是**浏览器可达**地址
      issuer: cli.idpIssuer ?? process.env.RT_AUTH_ISSUER ?? 'http://47.110.80.47:8082',
      clientId: cli.authClientId ?? process.env.RT_AUTH_CLIENT_ID ?? 'mn-rt',
      // 授权回调地址：这是**绑定用的标签**，不是任何人会去打开的页面。
      //
      // 本服务只有两类发起方，都不经过浏览器跳转到这里：
      //   ① PC CLI 自己在 127.0.0.1 随机端口收码（那是真监听，真的收包）；
      //   ② 手机端 fr 用已有的统一登录态直接调 /oauth2/auth + 提交 consent，
      //      授权码从 302 的 Location 里取出来再 POST 给本服务——同样没有浏览器落地。
      // 但 redirect_uri 在协议里必须在客户端白名单内，且 authorize 与换 token 两次
      // 必须逐字相同，所以这里给一个稳定值让两端共用。
      //
      // 形状被认证中心的规则钉死：回环通配只放行 `http://127.0.0.1:*/callback`
      // （主机限回环、端口通配、**路径必须逐字 /callback**），公网地址则不许通配。
      // 所以不能写成本服务的 /auth/oidc/callback——那条根本不匹配白名单，
      // 表现是"配置看起来都对，authorize 一直 400"。
      redirectUri: cli.authRedirectUri ?? process.env.RT_AUTH_REDIRECT_URI
        ?? `http://127.0.0.1:${port}/callback`,
      scopes: (cli.authScopes ?? process.env.RT_AUTH_SCOPES ?? 'openid profile email')
        .split(' ').filter(Boolean),
      // 设备令牌签名密钥。开启统一登录却没配它属于**配置错误**，
      // 必须启动即失败——用硬编码默认值签发的令牌等于任何人都能伪造属主。
      jwtSecret: cli.authJwtSecret ?? process.env.RT_AUTH_JWT_SECRET ?? '',
      deviceFile: cli.authDeviceFile ?? process.env.RT_AUTH_DEVICE_FILE
        ?? path.join(root, 'data', 'devices.json'),
      httpTimeoutMs: num(cli.authHttpTimeout, 10_000),
    },
  };
}

function createServer(userConfig = {}) {
  const config = { ...loadConfig(), ...userConfig };
  const logger = new Logger({
    level: config.logLevel,
    logDir: config.logDir,
    name: 'server',
  });
  const store = new RecordStore({ file: config.recordFile, logger });

  // 开启统一登录但没配签名密钥 → 启动即失败。
  // 硬编码一个默认密钥的话，任何读过源码的人都能伪造"某用户的一台电脑"的令牌，
  // 而这正是这套鉴权唯一依赖的东西。宁可起不来，也不要"看起来在跑"。
  if (config.auth.enabled && !config.auth.jwtSecret) {
    throw new Error(
      'RT_AUTH_ENABLED=true 但 RT_AUTH_JWT_SECRET 为空：拒绝启动。'
      + '请注入随机长串（例如 openssl rand -hex 32）。',
    );
  }
  const auth = new AuthHub({
    ...config.auth,
    // redirectUri 在 loadConfig 里已按端口给出回环默认值（形状受白名单约束，见那里）。
    // 这里只兜"调用方直接构造 config 且没给"的情况——测试与嵌入式启动走的就是这条。
    redirectUri: config.auth.redirectUri
      || `http://127.0.0.1:${config.port}/callback`,
    logger,
  });
  if (config.auth.enabled) {
    logger.info('统一登录已启用', {
      issuer: auth.issuer, clientId: auth.clientId, redirectUri: auth.redirectUri,
    });
    // 预热发现文档：失败不致命（只有成功才固化，后续请求会重试）
    auth.discover().catch((e) => logger.warn('预热发现文档失败，将在首次使用时重试', { error: e.message }));
  }

  // ---- 会话表 ----
  /** clientId -> ws  （PC 客户端） */
  const pcs = new Map();
  /** phoneId -> ws （手机端，用于 PC→手机 的 ACK 反向路由） */
  const phones = new Map();
  /** ws -> 连接元信息 */
  const peers = new Map();
  let nextPeerId = 1;

  const stats = { connections: 0, messagesIn: 0, forwarded: 0, offline: 0, rejected: 0 };

  // ================= HTTP 层（健康检查 + 测试接口） =================
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const send = (code, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end(payload);
    };

    if (req.method === 'OPTIONS') return send(204, {});

    if (url.pathname === '/health') {
      return send(200, { ok: true, service: 'remotetype-server', uptime: process.uptime() });
    }

    if (url.pathname === '/stats') {
      return send(200, { ok: true, stats, onlineClients: [...pcs.keys()], records: store.stats() });
    }

    if (url.pathname === '/clients') {
      // 开启统一登录后这里必须收口：原来它把**所有人**的在线 clientId 无条件公开，
      // 而 clientId 是路由地址——配合"知道 key 就能注入"，等于把靶子清单挂在网上。
      if (config.auth.enabled) {
        const me = auth.verifyDeviceToken(bearerOf(req));
        if (!me) return send(401, { ok: false, error: 'unauthorized' });
        return send(200, { ok: false, error: 'use /my/devices', hint: '统一登录模式下只返回本人设备' });
      }
      const list = [...pcs.entries()].map(([id, ws]) => ({
        clientId: id,
        readyState: ws.readyState,
        peerId: peers.get(ws)?.peerId,
        connectedAt: peers.get(ws)?.connectedAt,
      }));
      return send(200, { ok: true, count: list.length, clients: list });
    }

    // ── 统一登录：公开参数 ────────────────────────────────────────────────
    // 与 dev_ctr_hello 同形：客户端先拉这里，拿到 issuer/clientId/redirectUri 后
    // 自己生成 PKCE 并打开浏览器。**响应里绝不含任何 secret**。
    if (url.pathname === '/auth/oidc/config') {
      return send(200, { ok: true, ...auth.publicConfig() });
    }

    // ── 统一登录：浏览器回调落在服务端这条路**尚未实现**，但必须能自解释 ──────
    //
    // 服务端要能在 GET 回调上收下 code，就得先自己发起 authorize 并持有对应的
    // PKCE verifier——那需要一份 RP 会话（cookie/存储）。没有它，这里永远收不到
    // 一个"能用的" code。落到这里的请求只会来自有人手工把 redirect_uri 指过来，
    // 所以给它一句能照着往下走的话，而不是一个没有解释的 404。
    if (url.pathname === '/auth/oidc/callback' && req.method === 'GET') {
      return send(400, {
        ok: false,
        error: 'browser_callback_flow_not_implemented',
        message: '服务端不代理浏览器授权流程。PC 请在电脑上执行 `mn-rt auth login`'
          + '（本机回环收码、自己换 token）；手机端请带认证中心的 access_token 调 POST /auth/verify。',
      });
    }

    // ── 统一登录：授权码 → 本服务设备令牌 ─────────────────────────────────
    // PC CLI 与 fr 手机端走同一个端点；差别在 body 里带不带 clientId/deviceName。
    if (url.pathname === '/auth/oidc/callback' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return send(400, { ok: false, error: 'invalid json body' }); }
        try {
          const who = await auth.exchange({
            code: body.code, codeVerifier: body.codeVerifier, redirectUri: body.redirectUri,
          });
          const out = {
            ok: true,
            userId: who.userId,
            sub: who.sub,
            email: who.email,
            username: who.preferredUsername,
            nickname: who.name,
          };
          // 带 clientId 才登记设备并签发令牌；不带就只是"我是谁"（手机端用）
          if (body.clientId) {
            const { rec, rejected } = auth.upsertDevice({
              clientId: body.clientId, userId: who.userId, email: who.email,
              deviceName: body.deviceName,
            });
            // 这台电脑已在别人名下：不发令牌、不给密钥。能确定的只有"归属不在你这"。
            if (rejected) {
              return send(403, {
                ok: false, error: 'device_owned_by_other', clientId: body.clientId,
                message: '该 clientId 已绑定到其他账号。若是你本人的电脑，请在原机上重新登记。',
              });
            }
            const t = auth.issueDeviceToken({ userId: who.userId, clientId: body.clientId, deviceName: rec.deviceName });
            out.token = t.token;
            out.tokenExpiresAt = t.expiresAt;
            out.jti = t.jti;
            out.sessionKey = rec.sessionKey; // 设备自己需要它来解对齐信封
            out.device = publicDevice(rec);
          } else {
            // 手机端：签发一枚"用户令牌"（无 cid）。它代表身份，不代表某台设备。
            const t = auth.issueDeviceToken({ userId: who.userId, clientId: '', deviceName: body.deviceName || 'phone' });
            out.token = t.token;
            out.tokenExpiresAt = t.expiresAt;
            out.jti = t.jti;
          }
          return send(200, out);
        } catch (e) {
          logger.warn('统一登录换令牌失败', { error: e.message, code: e.code });
          return send(e.code === 'bad_request' ? 400 : 401, { ok: false, error: e.code || 'auth_failed', message: e.message });
        }
      });
      return undefined;
    }

    // ── 统一登录：用认证中心 access_token 换本服务设备令牌 ────────────────
    // 给 PC CLI 用（CLI 自己完成 PKCE + 回环收码 + 换 token，无需复制粘贴）。
    // 与 /auth/oidc/callback 的区别只在"客户端手里已经有 token 还是有 code"，
    // 两者产出的属主结论同源，所以后面的签发/登记逻辑完全共用。
    if (url.pathname === '/auth/verify' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return send(400, { ok: false, error: 'invalid json body' }); }
        const bearer = bearerOf(req) || body.accessToken || '';
        try {
          const who = await auth.verifyBearer(bearer);
          const out = { ok: true, userId: who.userId, sub: who.sub, email: who.email, username: who.preferredUsername, nickname: who.name };
          const cid = body.clientId || null;
          if (cid) {
            const { rec, rejected } = auth.upsertDevice({
              clientId: cid, userId: who.userId, email: who.email,
              deviceName: body.deviceName, sessionKey: body.sessionKey,
            });
            // 关键：被拒时 rec 是**真属主**的记录，含真 sessionKey。
            // 这里早先是无条件回传 rec.sessionKey 的，等于任何登录用户都能
            // 通过枚举别人的 clientId 拿到那台电脑的会话密钥 → 直接注入其键盘。
            if (rejected) {
              return send(403, {
                ok: false, error: 'device_owned_by_other', clientId: cid,
                message: '该 clientId 已绑定到其他账号，无法登记为你的设备。',
              });
            }
            const t = auth.issueDeviceToken({ userId: who.userId, clientId: cid, deviceName: rec.deviceName });
            out.token = t.token; out.tokenExpiresAt = t.expiresAt; out.jti = t.jti;
            out.sessionKey = rec.sessionKey; // 设备自己需要它来解对齐信封
            out.device = publicDevice(rec);
          } else {
            const t = auth.issueDeviceToken({ userId: who.userId, clientId: '', deviceName: body.deviceName || 'client' });
            out.token = t.token; out.tokenExpiresAt = t.expiresAt; out.jti = t.jti;
          }
          return send(200, out);
        } catch (e) {
          logger.warn('Bearer 校验失败', { error: e.message, code: e.code });
          return send(e.code === 'bad_request' ? 400 : 401, { ok: false, error: e.code || 'invalid_token', message: e.message });
        }
      });
      return undefined;
    }

    // ── 我的设备列表 ──────────────────────────────────────────────────────
    // 跨用户不可见是这套设计的核心约束：只按令牌里的 sub 过滤。
    if (url.pathname === '/my/devices') {
      const me = auth.verifyDeviceToken(bearerOf(req));
      if (!me) return send(401, { ok: false, error: 'unauthorized' });
      const list = auth.listDevicesByUser(me.sub).map((d) => ({
        ...publicDevice(d),
        // 会话密钥只随"属主自己的设备列表"下发——这是手机端能解密/加密的唯一凭据。
        // 上面 listDevicesByUser 已按令牌 sub 过滤，所以这里不会外泄给他人。
        sessionKey: d.sessionKey,
        online: pcs.has(d.clientId),
        connectedAt: peers.get(pcs.get(d.clientId))?.connectedAt || null,
      }));
      return send(200, { ok: true, userId: me.sub, count: list.length, devices: list });
    }

    if (url.pathname === '/records') {
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      return send(200, { ok: true, records: store.tail(limit) });
    }

    // 测试接口：curl -X POST http://host:port/push -d '{"clientId":"pc-001","text":"hi"}'
    // 也支持 GET：/push?clientId=pc-001&text=hi
    if (url.pathname === '/push' && (req.method === 'POST' || req.method === 'GET')) {
      // 设了 RT_TOKEN 时 /push 同样需要 token（query 或 body 任一携带），堵住绕过注册门禁的旁路
      const finish = (body) => {
        if (config.token && (body?.token ?? url.searchParams.get('token')) !== config.token) {
          return send(401, { ok: false, error: 'invalid token' });
        }
        // 统一登录模式下 /push 是一条**注入通道**，必须带调用者身份，
        // 否则前面所有的属主校验都能从这个口绕过去。
        let callerUserId = null;
        if (config.auth.enabled) {
          const me = auth.verifyDeviceToken(
            bearerOf(req) || body?.deviceToken || url.searchParams.get('deviceToken') || '',
          );
          if (!me) return send(401, { ok: false, error: 'unauthorized' });
          callerUserId = me.sub;
        }
        const clientId = body?.clientId;
        const text = body?.text;
        if (!clientId || typeof text !== 'string') {
          return send(400, { ok: false, error: 'clientId and text are required' });
        }
        const result = routeMessage(clientId, text, 'http-test', callerUserId);
        return send(result.ok ? 200 : 404, result);
      };

      if (req.method === 'GET') {
        return finish(Object.fromEntries(url.searchParams.entries()));
      }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          finish(JSON.parse(raw || '{}'));
        } catch {
          send(400, { ok: false, error: 'invalid json body' });
        }
      });
      return undefined;
    }

    // 网页控制台静态文件（GET / 直接用浏览器当手机端，免装 app）
    if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
      const entry = STATIC_FILES[url.pathname];
      const file = path.join(__dirname, '..', 'public', entry.file);
      try {
        const body = fs.readFileSync(file);
        return res.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': body.length }).end(body);
      } catch (_) {
        return send(500, { ok: false, error: 'static file missing' });
      }
    }

    return send(404, { ok: false, error: 'not found' });
  });

  // ================= WebSocket 层 =================
  const wss = new WebSocketServer({
    server: httpServer,
    path: config.wsPath,
    maxPayload: config.maxPayload,
  });

  /** 向 socket 发送 JSON，自动处理未就绪的情况。 */
  function sendJson(ws, obj) {
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      logger.warn('failed to send to socket', { error: e.message });
      return false;
    }
  }

  /**
   * 核心路由：把文本转发给指定 clientId 的在线 PC，并落盘记录。
   * 被 WS 消息处理与 HTTP /push 共用，保证行为一致。
   */
  function routeMessage(clientId, text, source, callerUserId) {
    stats.messagesIn += 1;

    // ── 跨属主注入拦截 ────────────────────────────────────────────────────
    // 这是整套身份化改造里唯一真正兜住安全的判据：路由前必须确认
    // "发消息的人"和"目标电脑"属于同一个 userId。
    // 少了这一条，任何登录用户只要猜到/枚举到别人的 clientId，就能向那台电脑
    // 注入任意文本——而注入文本在这个产品里等价于"以受害者身份敲键盘"。
    if (config.auth.enabled) {
      const target = auth.getDevice(clientId);
      if (!target) {
        stats.rejected += 1;
        logger.warn('rejected: 目标设备未登记属主', { clientId, source });
        return { ok: false, status: 'unregistered_target', clientId };
      }
      if (!callerUserId || String(callerUserId) !== String(target.userId)) {
        stats.rejected += 1;
        // 必须落 warning：这是最像"有人在试探别人电脑"的信号
        logger.warn('rejected: 跨属主注入尝试', {
          clientId, targetOwner: target.userId, caller: callerUserId || '(none)', source,
        });
        return { ok: false, status: 'forbidden', clientId };
      }
    }

    // 文本预处理（服务端做一层基础校验，客户端还会再做一次）
    if (typeof text !== 'string' || text.trim().length === 0) {
      stats.rejected += 1;
      store.append({ clientId, text, status: 'rejected_empty', source });
      logger.warn('rejected empty text', { clientId, source });
      return { ok: false, status: 'rejected_empty', clientId };
    }

    const target = pcs.get(clientId);
    if (!target) {
      stats.offline += 1;
      store.append({ clientId, text, status: 'target_offline', source });
      logger.warn('target pc offline, message dropped', { clientId, source, textLen: text.length });
      return { ok: false, status: 'target_offline', clientId };
    }

    const delivered = sendJson(target, { text, clientId, ts: Date.now() });
    if (!delivered) {
      stats.offline += 1;
      store.append({
        clientId,
        text,
        status: 'send_failed',
        errorMsg: 'socket not open',
        source,
      });
      logger.error('forward failed, socket not open', { clientId, source });
      return { ok: false, status: 'send_failed', clientId };
    }

    stats.forwarded += 1;
    store.append({ clientId, text, status: 'forwarded', source });
    logger.info('message forwarded', { clientId, source, textLen: text.length });
    return { ok: true, status: 'forwarded', clientId };
  }

  wss.on('connection', (ws, req) => {
    const peerId = `peer-${nextPeerId++}`;
    peers.set(ws, {
      peerId,
      clientId: null,
      role: 'unknown',
      // 显式初值：注册门禁用 `!meta.registered` 判断。靠 undefined 也能工作，
      // 但"没这个字段"和"没注册"是两件事，写出来才读得懂。
      registered: false,
      connectedAt: new Date().toISOString(),
      ip: req.socket.remoteAddress,
    });
    stats.connections += 1;
    logger.info('peer connected', { peerId, ip: req.socket.remoteAddress });

    // 连接后立即下发欢迎帧，便于客户端确认链路，也便于手机端自测
    sendJson(ws, {
      type: 'welcome',
      peerId,
      server: 'remotetype-server',
      wsPath: config.wsPath,
    });

    // 对端保活：ws 库自带 ping/pong，30s 检测一次，防止半开连接堆积
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        stats.rejected += 1;
        logger.warn('received invalid json', { peerId });
        sendJson(ws, { type: 'error', error: 'invalid json' });
        return;
      }

      const meta = peers.get(ws);

      // --- 1) 握手 / 身份注册 ---
      // PC 客户端：{"type":"register","role":"pc","clientId":"pc-001"}
      // 手机端：{"type":"register","role":"phone","phoneId":"phone-xxx","token":"..."}
      //   phoneId 用于 PC→手机 的 ACK 反向路由；不传则服务端生成并在 registered 帧里下发
      if (msg.type === 'register') {
        // 接入 token（RT_TOKEN / --token）：设置后注册必须携带，否则 4403
        if (config.token && msg.token !== config.token) {
          stats.rejected += 1;
          logger.warn('register rejected: bad token', { peerId, role: msg.role });
          sendJson(ws, { type: 'error', error: 'invalid token' });
          try { ws.close(4403, 'invalid token'); } catch { /* ignore */ }
          return;
        }

        const clientId = msg.clientId ? String(msg.clientId) : null;
        const role = msg.role === 'pc' ? 'pc' : msg.role === 'phone' ? 'phone' : 'unknown';

        // ── 统一登录门禁 ──────────────────────────────────────────────────
        // 开启后 register 必须携带本服务签发的设备/用户令牌，否则拒绝。
        // 这一步取代了原来"人手传配对 key + RT_TOKEN"的全部作用：
        // 身份由认证中心断言，归属由服务端记录，两端不再需要交换任何秘密。
        let ident = null;
        if (config.auth.enabled) {
          ident = auth.verifyDeviceToken(msg.deviceToken || '');
          if (!ident) {
            stats.rejected += 1;
            logger.warn('register rejected: 缺少或无效的设备令牌', { peerId, role, clientId });
            sendJson(ws, { type: 'error', error: 'auth_required', hint: '请先执行 mn-rt auth login' });
            try { ws.close(4401, 'auth required'); } catch { /* ignore */ }
            return;
          }
          // 以 pc 角色登记一台可被连接的电脑，必须持**绑定了这个 clientId 的设备令牌**。
          // 早先写的是 `if (ident.cid && clientId && ident.cid !== clientId)`——空 cid 的
          // 用户令牌（手机端登录产物）会整个跳过这条判断，于是任何登录用户都能用
          // 用户令牌 + 别人的 clientId 注册成 pc，把手机流量吸到自己的连接上。
          if (role === 'pc') {
            if (!clientId || ident.cid !== clientId) {
              stats.rejected += 1;
              logger.warn('register rejected: pc 角色需要绑定该 clientId 的设备令牌',
                { peerId, clientId, tokenCid: ident.cid || '(用户令牌)' });
              sendJson(ws, { type: 'error', error: 'token_client_mismatch', hint: '在该电脑上执行 mn-rt auth login' });
              try { ws.close(4401, 'token_client_mismatch'); } catch { /* ignore */ }
              return;
            }
          } else if (ident.cid && clientId && ident.cid !== clientId) {
            // 非 pc 角色一般不带 clientId；带了就必须自洽，别留一条"带错 cid 也能过"的缝
            stats.rejected += 1;
            logger.warn('register rejected: 令牌与 clientId 不匹配',
              { peerId, clientId, tokenCid: ident.cid });
            sendJson(ws, { type: 'error', error: 'token_client_mismatch' });
            try { ws.close(4401, 'token_client_mismatch'); } catch { /* ignore */ }
            return;
          }
        }

        if (role === 'pc') {
          if (!clientId) {
            logger.warn('register without clientId', { peerId });
            sendJson(ws, { type: 'error', error: 'clientId required for pc role' });
            return;
          }
          // 同一 clientId 重复上线：踢掉旧连接，保证消息只投递一次
          const existing = pcs.get(clientId);
          if (existing && existing !== ws) {
            logger.warn('clientId re-registered, closing previous connection', { clientId, peerId });
            sendJson(existing, { type: 'error', error: 'replaced by a new connection' });
            try { existing.close(4001, 'replaced'); } catch { /* ignore */ }
          }
          pcs.set(clientId, ws);
        }

        // 登记设备并取回会话密钥。只有 PC 角色才登记（手机不是"可被连接的设备"）。
        let device = null;
        if (config.auth.enabled && role === 'pc' && ident) {
          const r = auth.upsertDevice({
            clientId,
            userId: ident.sub,
            deviceName: msg.deviceName,
            sessionKey: msg.sessionKey, // 客户端可自带；缺省由服务端生成
          });
          if (r.rejected) {
            // 令牌与 clientId 是自洽的，却登记到别人名下——只可能是注册表被手工改过
            // 或 clientId 被刻意复用。此时 rec 里带着真属主的密钥，一个字节都不能回。
            stats.rejected += 1;
            logger.warn('register rejected: 设备归属与令牌属主不一致', {
              clientId, tokenOwner: ident.sub, deviceOwner: r.rec && r.rec.userId,
            });
            sendJson(ws, { type: 'error', error: 'device_owned_by_other' });
            try { ws.close(4403, 'device owned by another user'); } catch { /* ignore */ }
            return;
          }
          device = r.rec;
        }

        let phoneId = null;
        if (role === 'phone') {
          phoneId = msg.phoneId ? String(msg.phoneId) : `phone-${peerId}`;
          // 同一 phoneId 重复上线：踢旧
          const existingPhone = phones.get(phoneId);
          if (existingPhone && existingPhone !== ws) {
            logger.warn('phoneId re-registered, closing previous connection', { phoneId, peerId });
            try { existingPhone.close(4001, 'replaced'); } catch { /* ignore */ }
          }
          phones.set(phoneId, ws);
        }

        meta.role = role;
        meta.clientId = clientId;
        meta.phoneId = phoneId;
        meta.registered = true;
        // 属主绑定进连接元信息：后续所有路由判据都读它，
        // 而不是在每条消息上重新解析令牌（那会让"连接时的身份"与"发消息时的身份"可能不一致）
        if (ident) meta.userId = ident.sub;

        logger.info('peer registered', { peerId, role, clientId, phoneId, userId: meta.userId });
        const ack = { type: 'registered', role, clientId, phoneId };
        if (device) {
          // 会话密钥只发给**已通过该设备令牌认证的这条连接**。
          // 手机端则从 /my/devices 取——那里按令牌 sub 过滤，拿不到别人的。
          ack.sessionKey = device.sessionKey;
          ack.device = publicDevice(device);
        }
        sendJson(ws, ack);
        return;
      }

      // --- 2) 心跳 ---
      if (msg.type === 'ping') {
        sendJson(ws, { type: 'pong', ts: Date.now() });
        return;
      }

      // --- 2.5) 注册门禁：注册之外的任何消息都要求先完成合法注册 ---
      // 否则「跳过 register 直接发 text/ack」即可绕过 token 校验（2026-10-09 审查发现）。
      // 统一登录开启时必须同样生效：text 路径靠 routeMessage 的属主比对兜住了，
      // 但 ack 反向路由没有任何属主概念——不注册就能往任意 phoneId 上投递帧。
      if ((config.token || config.auth.enabled) && !meta.registered) {
        stats.rejected += 1;
        logger.warn('message before register while gate enabled', { peerId, type: msg.type, auth: config.auth.enabled });
        sendJson(ws, { type: 'error', error: 'register required' });
        try { ws.close(4403, 'register required'); } catch { /* ignore */ }
        return;
      }

      // --- 3) PC → 手机 的 ACK 反向路由 ---
      // PC 端：{"type":"ack","phoneId":"phone-xxx","ack":{sid,seq,nonce,ct}}
      // 服务端不解析 ack 内容，按 phoneId 转发：{"type":"ack","ack":{...}}
      if (msg.type === 'ack') {
        const targetPhone = msg.phoneId ? phones.get(String(msg.phoneId)) : null;
        if (!targetPhone) {
          stats.offline += 1;
          logger.warn('ack target phone offline', { phoneId: msg.phoneId, peerId });
          sendJson(ws, { type: 'ack_status', ok: false, status: 'target_offline', phoneId: msg.phoneId });
          return;
        }
        const delivered = sendJson(targetPhone, { type: 'ack', ack: msg.ack });
        logger.info('ack forwarded', { phoneId: msg.phoneId, delivered });
        sendJson(ws, { type: 'ack_status', ok: delivered, status: delivered ? 'forwarded' : 'send_failed', phoneId: msg.phoneId });
        return;
      }

      // --- 3) 文本推送（手机端主流程） ---
      // 兼容两种 payload：{"clientId","text"} 或 {"type":"text","clientId","text"}
      const clientId = msg.clientId ?? meta.clientId;
      const text = msg.text;

      if (typeof text !== 'string') {
        stats.rejected += 1;
        logger.warn('message without text field', { peerId, clientId });
        sendJson(ws, { type: 'error', error: 'text field required' });
        return;
      }
      if (!clientId) {
        stats.rejected += 1;
        logger.warn('message without clientId', { peerId });
        sendJson(ws, { type: 'error', error: 'clientId required' });
        return;
      }

      const result = routeMessage(clientId, text, meta.role === 'pc' ? 'pc' : 'phone', meta.userId);
      sendJson(ws, { type: 'ack', ...result });
    });

    ws.on('close', (code) => {
      const meta = peers.get(ws);
      // 只有当前注册的那条连接才能摘除 clientId，避免「踢旧连」时误删新连接
      if (meta?.clientId && meta.role === 'pc' && pcs.get(meta.clientId) === ws) {
        pcs.delete(meta.clientId);
        logger.info('pc client offline', { clientId: meta.clientId, peerId });
      }
      if (meta?.phoneId && phones.get(meta.phoneId) === ws) {
        phones.delete(meta.phoneId);
        logger.info('phone offline', { phoneId: meta.phoneId, peerId });
      }
      peers.delete(ws);
      logger.info('peer disconnected', { peerId, code });
    });

    ws.on('error', (e) => {
      logger.error('socket error', { peerId, error: e.message });
    });
  });

  // 心跳巡检
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        logger.warn('heartbeat timeout, terminating peer');
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  heartbeat.unref?.();

  /** 优雅关闭：清理定时器、断开所有连接、关闭 HTTP 与日志流。 */
  async function close() {
    clearInterval(heartbeat);
    logger.info('shutting down, disconnecting all peers', { peers: wss.clients.size });
    for (const ws of wss.clients) {
      try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    logger.info('shutdown complete');
    logger.close();
  }

  /** 监听端口。返回一个 Promise，resolve 时服务已就绪。 */
  function listen() {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.port, () => {
        const addr = httpServer.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : config.port;
        logger.info(`remotetype-server listening on port ${actualPort}`, {
          wsPath: config.wsPath,
          wsUrl: `ws://0.0.0.0:${actualPort}${config.wsPath}`,
          recordFile: config.recordFile,
          logDir: config.logDir,
        });
        logger.info(`test endpoint: POST http://127.0.0.1:${actualPort}/push`);
        resolve({ port: actualPort, config });
      });
    });
  }

  return {
    config,
    logger,
    store,
    httpServer,
    wss,
    listen,
    close,
    // 便于测试内部逻辑
    _internal: { routeMessage, pcs, peers, stats, auth },
  };
}

// ---- 作为 CLI 直接运行时启动 ----
if (require.main === module) {
  const server = createServer();
  server.listen().catch((e) => {
    server.logger.error('failed to start server', { error: e.message });
    process.exit(1);
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    server.logger.info(`received ${signal}, graceful shutdown`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createServer, loadConfig };
