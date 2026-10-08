'use strict';

/**
 * 客户端日志器：控制台（带时间戳与级别色）+ 本地文件。
 * 与 server/src/logger.js 行为保持一致，便于两端日志对照排查。
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

function safeStringify(value) {
  if (value === undefined) return undefined;
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value);
    return s.length > 2000 ? `${s.slice(0, 2000)}...(truncated)` : s;
  } catch {
    return String(value);
  }
}

class Logger {
  /**
   * @param {object} opts
   * @param {string} [opts.level]
   * @param {string|null} [opts.logDir]
   * @param {string} [opts.name]
   * @param {boolean} [opts.console]
   */
  constructor(opts = {}) {
    this.level = LEVELS[opts.level] ?? LEVELS.info;
    this.name = opts.name || 'client';
    this.printToConsole = opts.console !== false;
    this.stream = null;
    this.currentDay = null;

    if (opts.logDir) {
      this.logDir = opts.logDir;
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
        this._rotate();
      } catch {
        // 日志目录不可写时降级为纯控制台，不影响主流程
        this.stream = null;
      }
    }
  }

  _rotate() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.currentDay === day && this.stream) return;
    if (this.stream) this.stream.end();
    this.currentDay = day;
    this.stream = fs.createWriteStream(path.join(this.logDir, `${this.name}-${day}.log`), {
      flags: 'a',
    });
  }

  _write(level, msg, meta) {
    if (LEVELS[level] < this.level) return;
    const ts = new Date().toISOString();
    const metaStr = safeStringify(meta);
    const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${msg}${metaStr ? ` ${metaStr}` : ''}`;
    if (this.printToConsole) {
      process.stdout.write(`${COLORS[level] || ''}${line}${COLORS.reset}\n`);
    }
    if (this.stream) {
      this._rotate();
      this.stream.write(`${line}\n`);
    }
  }

  debug(msg, meta) { this._write('debug', msg, meta); }
  info(msg, meta) { this._write('info', msg, meta); }
  warn(msg, meta) { this._write('warn', msg, meta); }
  error(msg, meta) { this._write('error', msg, meta); }

  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

module.exports = { Logger, LEVELS };
