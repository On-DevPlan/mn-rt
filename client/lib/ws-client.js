'use strict';

/**
 * WebSocket 客户端：连接公网 Serve，断线自动重连（指数退避 1s→2s→4s…最大 10s）。
 * 对应需求文档 4.2.2 第 1 条。
 *
 * 连接后立即发送 register 帧声明身份与 clientId，
 * 服务端据此建立 clientId -> socket 的路由表。
 */

const EventEmitter = require('events');
const WebSocket = require('ws');

class ServeClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url             ws:// 或 wss:// 地址
   * @param {string} opts.clientId        本机唯一标识（用于服务端路由）
   * @param {string} [opts.token]         注册门禁 token（服务器设 RT_TOKEN 后必须携带）
   * @param {object} opts.logger
   * @param {number} [opts.maxBackoffMs]  退避上限，默认 10000
   * @param {number} [opts.baseBackoffMs] 退避基数，默认 1000
   * @param {number} [opts.pingIntervalMs]应用层心跳间隔，默认 25000
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.clientId = opts.clientId;
    this.token = opts.token ?? null;
    this.logger = opts.logger;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 25000;
    // 允许注入自定义 WebSocket 实现（便于测试）
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket;

    this.ws = null;
    this.closedByUser = false;
    this.backoffMs = this.baseBackoffMs;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.attempts = 0;

    this.stats = { connects: 0, reconnects: 0, messages: 0, errors: 0 };
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === this.WebSocketImpl.OPEN);
  }

  /** 建立连接（幂等：已连接或有重连计划时直接返回）。 */
  connect() {
    if (this.ws && (this.ws.readyState === this.WebSocketImpl.OPEN || this.ws.readyState === this.WebSocketImpl.CONNECTING)) {
      return;
    }
    this.closedByUser = false;
    this.logger?.info('connecting to serve', { url: this.url, clientId: this.clientId });

    let ws;
    try {
      ws = new this.WebSocketImpl(this.url, {
        handshakeTimeout: 10000,
        // 应用层自己做心跳；ws 内置 ping 仍保留用于链路探测
        perMessageDeflate: false,
      });
    } catch (e) {
      this.logger?.error('failed to create websocket', { error: e.message });
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.on('open', () => {
      this.attempts += 1;
      this.stats.connects += 1;
      this.backoffMs = this.baseBackoffMs; // 成功后重置退避
      this.logger?.info('connected to serve', { url: this.url });
      // 声明身份，服务端据此建立路由；token 仅在配置时携带
      this._send({ type: 'register', role: 'pc', clientId: this.clientId, token: this.token || undefined });
      this._startPing();
      this.emit('connected');
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.logger?.warn('received invalid json from serve');
        return;
      }

      // 服务端非文本帧：welcome / registered / ack / error / pong
      if (msg.type === 'error') {
        this.stats.errors += 1;
        this.logger?.error('serve reported error', { error: msg.error });
        this.emit('serve-error', msg);
        return;
      }
      if (msg.type === 'welcome' || msg.type === 'registered' || msg.type === 'pong') {
        this.logger?.debug(`serve frame: ${msg.type}`, msg);
        if (msg.type === 'registered') this.emit('registered', msg);
        return;
      }
      if (msg.type === 'ack') {
        this.logger?.debug('serve ack', msg);
        return;
      }

      // 转发下来的文本
      if (typeof msg.text === 'string') {
        this.stats.messages += 1;
        this.emit('text', { text: msg.text, clientId: msg.clientId, ts: msg.ts });
        return;
      }

      this.logger?.debug('unhandled message from serve', { keys: Object.keys(msg) });
    });

    ws.on('close', (code, reason) => {
      this._stopPing();
      const why = reason ? reason.toString() : '';
      if (this.closedByUser) {
        this.logger?.info('websocket closed by user', { code, reason: why });
        return;
      }
      // 4403 = 注册门禁拒绝（token 缺失/错误）：同样的 token 重连必然同样被拒，
      // 无限重试只会刷屏，这里停止重连并上抛，交给上层提示用户检查配置。
      if (code === 4403) {
        this.logger?.error('注册被服务端拒绝（token 无效或缺失），已停止重连', { reason: why });
        this.authRejected = true;
        this.emit('auth-rejected', { reason: why });
        return;
      }
      this.logger?.warn('websocket closed, will reconnect', { code, reason: why });
      this.emit('disconnected', { code, reason: why });
      this._scheduleReconnect();
    });

    ws.on('error', (e) => {
      this.stats.errors += 1;
      // ECONNREFUSED 在服务端未启动时很常见，降为 warn 避免刷屏
      const level = e.code === 'ECONNREFUSED' ? 'warn' : 'error';
      this.logger?.[level]('websocket error', { error: e.message, code: e.code });
      // error 之后 close 必然触发，重连交给 close 处理
    });
  }

  /** 指数退避：1s, 2s, 4s, 8s, 10s, 10s... */
  _scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = Math.min(this.backoffMs, this.maxBackoffMs);
    this.stats.reconnects += 1;
    this.logger?.info(`reconnecting in ${delay}ms`, { attempt: this.stats.reconnects });
    this.emit('reconnecting', { delayMs: delay, attempt: this.stats.reconnects });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();

    // 指数增长
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  _startPing() {
    this._stopPing();
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      this._send({ type: 'ping', ts: Date.now() });
      // ws 内置 ping，帮助中间代理保持连接
      try { this.ws.ping(); } catch { /* ignore */ }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _send(obj) {
    if (!this.connected) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      this.logger?.warn('failed to send to serve', { error: e.message });
      return false;
    }
  }

  /** 发送一条 JSON 消息到服务端（公共接口，如 PC→手机 的 ACK 路由帧）。 */
  send(obj) {
    return this._send(obj);
  }

  /** 主动关闭，不再重连。用于优雅退出。 */
  close() {
    this.closedByUser = true;
    this._stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'client shutdown'); } catch { /* ignore */ }
    }
  }
}

module.exports = { ServeClient };
