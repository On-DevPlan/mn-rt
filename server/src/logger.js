'use strict';

/**
 * 分级日志器：控制台彩色输出 + 本地文件落盘。
 * 日志文件按日期切分：<logDir>/server-YYYY-MM-DD.log
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

/** 转成单行 JSON，便于结构化检索；超长字段截断避免日志爆炸。 */
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
   * @param {string} [opts.level]     最低输出级别
   * @param {string} [opts.logDir]    日志目录，传 null 则只输出控制台
   * @param {string} [opts.name]      日志文件名前缀
   * @param {boolean} [opts.console]  是否输出控制台
   */
  constructor(opts = {}) {
    this.level = LEVELS[opts.level] ?? LEVELS.info;
    this.name = opts.name || 'server';
    this.printToConsole = opts.console !== false;
    this.stream = null;
    this.currentDay = null;

    if (opts.logDir) {
      this.logDir = opts.logDir;
      fs.mkdirSync(this.logDir, { recursive: true });
      this._rotate();
    }
  }

  _rotate() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.currentDay === day && this.stream) return;
    if (this.stream) this.stream.end();
    this.currentDay = day;
    const file = path.join(this.logDir, `${this.name}-${day}.log`);
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }

  _write(level, msg, meta) {
    if (LEVELS[level] < this.level) return;

    const ts = new Date().toISOString();
    const metaStr = safeStringify(meta);
    const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${msg}${metaStr ? ` ${metaStr}` : ''}`;

    if (this.printToConsole) {
      const color = COLORS[level] || '';
      process.stdout.write(`${color}${line}${COLORS.reset}\n`);
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
