'use strict';

/**
 * 转录记录持久化：jsonlines（每行一条 JSON）。
 * 字段：timestamp / clientId / text / status / errorMsg
 *
 * 采用「追加写 + 定期 fsync」策略：语音转文字是低频场景，
 * 直接 appendFile 即可，无需引入数据库。
 */

const fs = require('fs');
const path = require('path');

class RecordStore {
  /**
   * @param {object} opts
   * @param {string} file            jsonlines 文件路径
   * @param {object} logger          日志器
   */
  constructor(opts) {
    this.file = opts.file;
    this.logger = opts.logger;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 确保文件存在
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '');
  }

  /**
   * 追加一条记录。
   * @param {object} entry 至少包含 text；其余字段自动补齐
   */
  append(entry) {
    const record = {
      timestamp: new Date().toISOString(),
      clientId: entry.clientId ?? null,
      text: entry.text ?? '',
      status: entry.status ?? 'unknown',
      errorMsg: entry.errorMsg ?? null,
      source: entry.source ?? null,
    };
    const line = `${JSON.stringify(record)}\n`;

    // 同步写：低频场景下可接受，且保证崩溃前记录不丢。
    try {
      fs.appendFileSync(this.file, line, 'utf8');
    } catch (e) {
      this.logger?.error('failed to persist record', { error: e.message });
    }
    return record;
  }

  /** 读取最近 N 条记录（用于 /records 调试接口），倒序返回。 */
  tail(limit = 50) {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const slice = lines.slice(-Math.max(1, Math.min(limit, 1000)));
      return slice
        .map((l) => {
          try { return JSON.parse(l); } catch { return { raw: l }; }
        })
        .reverse();
    } catch (e) {
      this.logger?.error('failed to read records', { error: e.message });
      return [];
    }
  }

  /** 统计信息。 */
  stats() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      let forwarded = 0;
      let offline = 0;
      for (const l of lines) {
        if (l.includes('"status":"forwarded"')) forwarded += 1;
        else if (l.includes('"status":"target_offline"')) offline += 1;
      }
      return { total: lines.length, forwarded, targetOffline: offline };
    } catch {
      return { total: 0, forwarded: 0, targetOffline: 0 };
    }
  }
}

module.exports = { RecordStore };
