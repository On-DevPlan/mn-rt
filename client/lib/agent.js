'use strict';

/**
 * Rust input-agent 子进程管理器。
 *
 * 关键设计（需求文档 4.2.2 第 4 条）：
 *   * Node 业务层 <-> Rust 子进程通过 stdio 管道通信，单行 JSON，`\n` 分隔；
 *   * 刻意不使用 FFI/ABI，子进程崩溃不会拖垮 Node 主进程（故障隔离）；
 *   * exit/close 事件触发自动重启（等待 2s）；
 *   * 心跳检测（ping）判定卡死，超时强制重启；
 *   * 正常退出时优雅关闭子进程。
 *
 * 由于「一条输入完成再处理下一条」（串行队列在 queue.js），
 * 这里对每条指令采用独立 Promise 的方式按顺序调用即可，
 * 同时仍保留 inFlight 标记防止误用。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/** 子进程状态 */
const STATE = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  RESTARTING: 'restarting',
  STOPPING: 'stopping',
};

class AgentManager {
  /**
   * @param {object} opts
   * @param {string} opts.binaryPath        Rust 二进制绝对路径
   * @param {object} opts.logger
   * @param {number} [opts.restartDelayMs]  崩溃后重启延迟，默认 2000
   * @param {number} [opts.requestTimeoutMs]单条指令超时（作为心跳兜底），默认 30000
   * @param {number} [opts.heartbeatMs]     空闲心跳间隔，默认 15000
   * @param {number} [opts.maxRestarts]     连续快速重启上限，超过则停止并告警，默认 10
   */
  constructor(opts) {
    this.binaryPath = opts.binaryPath;
    this.logger = opts.logger;
    this.restartDelayMs = opts.restartDelayMs ?? 2000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30000;
    this.heartbeatMs = opts.heartbeatMs ?? 15000;
    this.maxRestarts = opts.maxRestarts ?? 10;

    this.child = null;
    this.state = STATE.STOPPED;
    this.shuttingDown = false;
    this.restartCount = 0;
    this.lastStartAt = 0;
    this.heartbeatTimer = null;
    this.restartTimer = null;

    this._stdoutBuffer = '';
    /** 等待中的请求：FIFO，子进程按序应答，因此队首即当前请求 */
    this._pending = [];

    this.stats = { spawned: 0, restarts: 0, crashes: 0, timeouts: 0, commands: 0, failures: 0 };
  }

  /** 启动子进程。若已启动则直接返回。 */
  start() {
    if (this.child) return this.child;

    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`input-agent binary not found: ${this.binaryPath}`);
    }
    try {
      fs.accessSync(this.binaryPath, fs.constants.X_OK);
    } catch {
      // 从 npm 包解压后可能丢失可执行位，这里自动补上
      try {
        fs.chmodSync(this.binaryPath, 0o755);
        this.logger?.debug('restored executable bit', { binaryPath: this.binaryPath });
      } catch (e) {
        this.logger?.warn('binary is not executable and chmod failed', {
          binaryPath: this.binaryPath,
          error: e.message,
        });
      }
    }

    this.state = STATE.STARTING;
    this.lastStartAt = Date.now();
    this._stdoutBuffer = '';

    this.logger?.info('spawning rust input-agent', { binaryPath: this.binaryPath });

    this.child = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // 不继承 shell，避免注入风险
      shell: false,
    });
    this.stats.spawned += 1;

    this.child.stdout.setEncoding('utf8');
    this.child.stdin.setDefaultEncoding?.('utf8');

    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) this.logger?.debug(`[input-agent] ${text}`);
    });

    this.child.on('error', (e) => {
      this.logger?.error('failed to spawn input-agent', { error: e.message });
      this._failAllPending(new Error(`input-agent spawn error: ${e.message}`));
      this._scheduleRestart('spawn-error');
    });

    this.child.on('exit', (code, signal) => {
      const wasShuttingDown = this.shuttingDown;
      const uptime = Date.now() - this.lastStartAt;
      this.logger?.warn('input-agent exited', { code, signal, uptimeMs: uptime });
      this._failAllPending(new Error(`input-agent exited (code=${code}, signal=${signal})`));
      this.child = null;
      this._clearHeartbeat();

      if (wasShuttingDown) {
        this.state = STATE.STOPPED;
        return;
      }
      // 非正常退出视为崩溃
      if (code !== 0 || signal) this.stats.crashes += 1;
      this._scheduleRestart(`exit code=${code} signal=${signal}`);
    });

    this.state = STATE.READY;
    this._startHeartbeat();
    return this.child;
  }

  /** 处理子进程 stdout：按行切分并交给等待队列队首。 */
  _onStdout(chunk) {
    this._stdoutBuffer += String(chunk);
    let idx;
    // 逐行消费，最后一段可能是不完整行，留在 buffer 里等下一个 data 事件
    while ((idx = this._stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this._stdoutBuffer.slice(0, idx).trim();
      this._stdoutBuffer = this._stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      this._deliverLine(line);
    }
    // 防御：buffer 异常膨胀说明协议错乱
    if (this._stdoutBuffer.length > 1024 * 1024) {
      this.logger?.error('stdout buffer overflow, resetting');
      this._stdoutBuffer = '';
    }
  }

  _deliverLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.logger?.warn('unparseable line from input-agent', { line: line.slice(0, 300) });
      return; // 无法解析的行无法对应到具体请求，丢弃并继续
    }
    const pending = this._pending.shift();
    if (!pending) {
      this.logger?.debug('unexpected response with no pending request', { parsed });
      return;
    }
    clearTimeout(pending.timer);
    pending.resolve(parsed);
  }

  _failAllPending(err) {
    while (this._pending.length) {
      const p = this._pending.shift();
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  _clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    if (this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      // 仅在空闲时心跳，避免与正常指令抢答
      if (this._pending.length > 0 || this.state !== STATE.READY) return;
      this._send({ action: 'ping' }, this.heartbeatMs)
        .then((res) => {
          if (!res?.ok) this.logger?.warn('heartbeat returned not-ok', { res });
        })
        .catch((e) => {
          this.stats.timeouts += 1;
          this.logger?.error('heartbeat failed, agent considered hung', { error: e.message });
          this._killAndRestart('heartbeat-timeout');
        });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  /** 按需求：崩溃后等待 2s 自动重启；连续快速重启超限则告警停止。 */
  _scheduleRestart(reason) {
    if (this.shuttingDown) return;
    if (this.restartTimer) return;

    const uptime = Date.now() - this.lastStartAt;
    // 存活 < 5s 视为快速重启
    if (uptime < 5000) {
      this.restartCount += 1;
    } else {
      this.restartCount = 0;
    }

    if (this.restartCount > this.maxRestarts) {
      this.state = STATE.STOPPED;
      this.logger?.error(
        'input-agent keeps crashing, giving up auto-restart. check platform permissions.',
        { restarts: this.restartCount, binaryPath: this.binaryPath },
      );
      return;
    }

    this.state = STATE.RESTARTING;
    this.stats.restarts += 1;
    this.logger?.warn(`restarting input-agent in ${this.restartDelayMs}ms`, { reason });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown) return;
      try {
        this.start();
      } catch (e) {
        this.logger?.error('restart failed', { error: e.message });
        this._scheduleRestart('restart-failed');
      }
    }, this.restartDelayMs);
    this.restartTimer.unref?.();
  }

  _killAndRestart(reason) {
    const child = this.child;
    this._failAllPending(new Error(`agent killed: ${reason}`));
    if (!child) {
      this._scheduleRestart(reason);
      return;
    }
    this.shuttingDown = false; // 仍属「重启」而非「退出」
    this._childExitReason = reason;
    this.logger?.warn('killing hung input-agent', { reason, pid: child.pid });
    // 先 SIGTERM，超时后 SIGKILL
    child.kill('SIGTERM');
    const escalate = setTimeout(() => {
      if (this.child === child) {
        this.logger?.warn('SIGTERM ineffective, sending SIGKILL', { pid: child.pid });
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 2000);
    escalate.unref?.();
  }

  /**
   * 发送一条指令并等待结果。
   * @param {object} payload 例如 { action: 'type_text', text: '...' }
   * @param {number} [timeoutMs]
   * @returns {Promise<{ok:boolean,msg?:string}>}
   */
  send(payload, timeoutMs = this.requestTimeoutMs) {
    this.stats.commands += 1;
    return this._send(payload, timeoutMs);
  }

  _send(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
        // 子进程不可用时尝试拉起一次，仍失败则直接报错
        try {
          this.start();
        } catch (e) {
          this.stats.failures += 1;
          return reject(new Error(`input-agent unavailable: ${e.message}`));
        }
      }

      const line = `${JSON.stringify(payload)}\n`;
      const entry = {
        payload,
        resolve,
        reject,
        timer: setTimeout(() => {
          // 从等待队列里摘除自己
          const i = this._pending.indexOf(entry);
          if (i >= 0) this._pending.splice(i, 1);
          this.stats.timeouts += 1;
          this.stats.failures += 1;
          reject(new Error(`input-agent request timeout after ${timeoutMs}ms`));
          // 超时说明子进程可能卡死，主动重启
          this._killAndRestart('request-timeout');
        }, timeoutMs),
      };
      entry.timer.unref?.();
      this._pending.push(entry);

      try {
        this.child.stdin.write(line, (err) => {
          if (err) {
            const i = this._pending.indexOf(entry);
            if (i >= 0) this._pending.splice(i, 1);
            clearTimeout(entry.timer);
            this.stats.failures += 1;
            reject(err);
          }
        });
      } catch (e) {
        const i = this._pending.indexOf(entry);
        if (i >= 0) this._pending.splice(i, 1);
        clearTimeout(entry.timer);
        this.stats.failures += 1;
        reject(e);
      }
    });
  }

  /** 便捷方法：注入文本。 */
  async typeText(text, timeoutMs) {
    const res = await this.send({ action: 'type_text', text }, timeoutMs);
    return res;
  }

  /** 便捷方法：向焦点输入框发送 N 次退格（relay 对齐模式的删除原语）。 */
  async backspace(count, timeoutMs) {
    const res = await this.send({ action: 'backspace', count }, timeoutMs);
    return res;
  }

  /** 优雅关闭：结束 stdin -> 等待退出 -> 超时强杀。 */
  async stop() {
    this.shuttingDown = true;
    this._clearHeartbeat();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.child;
    if (!child) {
      this.state = STATE.STOPPED;
      return;
    }
    this.state = STATE.STOPPING;
    this._failAllPending(new Error('agent shutting down'));

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', done);
      // 关闭 stdin 让 agent 的 read loop 自然结束
      try { child.stdin.end(); } catch { /* ignore */ }
      const t = setTimeout(() => {
        this.logger?.warn('agent did not exit in time, killing', { pid: child.pid });
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        done();
      }, 3000);
      t.unref?.();
    });

    this.child = null;
    this.state = STATE.STOPPED;
    this.logger?.info('input-agent stopped', { stats: this.stats });
  }
}

module.exports = { AgentManager, STATE };
