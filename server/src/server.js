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
const path = require('path');
const { WebSocketServer } = require('ws');
const { Logger } = require('./logger');
const { RecordStore } = require('./store');

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
      const list = [...pcs.entries()].map(([id, ws]) => ({
        clientId: id,
        readyState: ws.readyState,
        peerId: peers.get(ws)?.peerId,
        connectedAt: peers.get(ws)?.connectedAt,
      }));
      return send(200, { ok: true, count: list.length, clients: list });
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
        const clientId = body?.clientId;
        const text = body?.text;
        if (!clientId || typeof text !== 'string') {
          return send(400, { ok: false, error: 'clientId and text are required' });
        }
        const result = routeMessage(clientId, text, 'http-test');
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
  function routeMessage(clientId, text, source) {
    stats.messagesIn += 1;

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
        logger.info('peer registered', { peerId, role, clientId, phoneId });
        sendJson(ws, { type: 'registered', role, clientId, phoneId });
        return;
      }

      // --- 2) 心跳 ---
      if (msg.type === 'ping') {
        sendJson(ws, { type: 'pong', ts: Date.now() });
        return;
      }

      // --- 2.5) 注册门禁：设了 RT_TOKEN 后，注册之外的任何消息都要求先完成合法注册 ---
      // 否则「跳过 register 直接发 text/ack」即可绕过 token 校验（2026-10-09 审查发现）
      if (config.token && !meta.registered) {
        stats.rejected += 1;
        logger.warn('message before register while token enabled', { peerId, type: msg.type });
        sendJson(ws, { type: 'error', error: 'register required (token enabled)' });
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

      const result = routeMessage(clientId, text, meta.role === 'pc' ? 'pc' : 'phone');
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
    _internal: { routeMessage, pcs, peers, stats },
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
