'use strict';

/**
 * 客户端本地转录记录持久化（需求文档 4.2.2 第 5 条）。
 * jsonlines，字段：timestamp / text / status / errorMsg
 */

const fs = require('fs');
const path = require('path');

class LocalStore {
  constructor({ file, logger }) {
    this.file = file;
    this.logger = logger;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '');
    } catch (e) {
      this.logger?.warn('cannot init local record file', { file, error: e.message });
      this.disabled = true;
    }
  }

  append(entry) {
    const record = {
      timestamp: new Date().toISOString(),
      text: entry.text ?? '',
      status: entry.status ?? 'unknown',
      errorMsg: entry.errorMsg ?? null,
      clientId: entry.clientId ?? null,
      queueWaitMs: entry.queueWaitMs ?? null,
      durationMs: entry.durationMs ?? null,
      truncated: entry.truncated ?? false,
      source: entry.source ?? null,
    };
    if (this.disabled) return record;
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (e) {
      this.logger?.warn('failed to append local record', { error: e.message });
    }
    return record;
  }

  /** 读取最近 N 条，倒序。 */
  tail(limit = 50) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      return lines
        .slice(-Math.max(1, limit))
        .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } })
        .reverse();
    } catch {
      return [];
    }
  }

  /** 简单统计：成功 / 失败 条数。 */
  stats() {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      let ok = 0;
      let failed = 0;
      for (const l of lines) {
        if (l.includes('"status":"injected"')) ok += 1;
        else if (l.includes('"status":"inject_failed"') || l.includes('"status":"dropped"')) failed += 1;
      }
      return { total: lines.length, injected: ok, failed };
    } catch {
      return { total: 0, injected: 0, failed: 0 };
    }
  }
}

module.exports = { LocalStore };
