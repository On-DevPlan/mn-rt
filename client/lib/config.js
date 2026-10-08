'use strict';

/**
 * 配置解析：默认值 < 配置文件 < 环境变量 < 命令行参数。
 *
 * 配置文件位置：~/.remotetype/config.json
 * 环境变量前缀：REMOTETYPE_
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveTarget } = require('./platform');

/** 内置默认公网服务地址（用户可用 --url 或环境变量覆盖）。 */
const DEFAULT_SERVE_URL = 'wss://remotetype.example.com/ws';

/** 配置目录：~/.remotetype */
function configDir() {
  const base =
    process.env.REMOTETYPE_HOME ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'remotetype')
      : path.join(os.homedir(), '.remotetype'));
  return base;
}

function configFile() {
  return path.join(configDir(), 'config.json');
}

function readConfigFile() {
  const file = configFile();
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** 生成/持久化 clientId：首次运行按 主机名-随机串 生成并落盘，保证稳定路由。 */
function ensureClientId() {
  const dir = configDir();
  const file = path.join(dir, 'client-id');
  try {
    if (fs.existsSync(file)) {
      const id = fs.readFileSync(file, 'utf8').trim();
      if (id) return id;
    }
  } catch { /* 忽略，继续生成 */ }

  const host = (os.hostname() || 'pc').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20);
  const rand = Math.random().toString(36).slice(2, 8);
  const id = `${host}-${rand}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, id, 'utf8');
  } catch { /* 不可写则每次生成，仅影响路由稳定性 */ }
  return id;
}

/** 解析 CLI 参数：支持 --key value 与 --key=value，以及 -h/--help 等布尔位。 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) {
        flags[key] = inline;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const short = arg.slice(1);
      const map = { h: 'help', v: 'version' };
      flags[map[short] || short] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/** 组装最终配置。 */
function loadConfig(flags = {}) {
  const file = readConfigFile();
  const env = process.env;
  const target = resolveTarget();

  const num = (v, d) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };

  const url =
    flags.url ?? env.REMOTETYPE_URL ?? file.url ?? DEFAULT_SERVE_URL;

  const cfg = {
    url,
    clientId: flags.clientId ?? env.REMOTETYPE_CLIENT_ID ?? file.clientId ?? ensureClientId(),
    logLevel: flags.logLevel ?? env.REMOTETYPE_LOG_LEVEL ?? file.logLevel ?? 'info',
    logDir: flags.logDir ?? env.REMOTETYPE_LOG_DIR ?? file.logDir ?? path.join(configDir(), 'logs'),
    recordFile:
      flags.recordFile ?? env.REMOTETYPE_RECORD_FILE ?? file.recordFile ??
      path.join(configDir(), 'data', 'records.jsonl'),
    // 队列与预处理
    maxQueueSize: num(flags.maxQueueSize ?? env.REMOTETYPE_MAX_QUEUE ?? file.maxQueueSize, 100),
    maxTextLength: num(flags.maxTextLength ?? env.REMOTETYPE_MAX_TEXT ?? file.maxTextLength, 5000),
    // 子进程
    restartDelayMs: num(flags.restartDelayMs ?? env.REMOTETYPE_RESTART_DELAY ?? file.restartDelayMs, 2000),
    heartbeatMs: num(flags.heartbeatMs ?? env.REMOTETYPE_HEARTBEAT ?? file.heartbeatMs, 15000),
    requestTimeoutMs: num(flags.requestTimeoutMs ?? env.REMOTETYPE_REQUEST_TIMEOUT ?? file.requestTimeoutMs, 30000),
    // 二进制
    agentPath: flags.agent ?? env.REMOTETYPE_AGENT ?? file.agentPath ?? null,
    configDir: configDir(),
    configFile: configFile(),
    target,
  };

  return cfg;
}

module.exports = {
  loadConfig,
  parseArgs,
  configDir,
  configFile,
  ensureClientId,
  readConfigFile,
  DEFAULT_SERVE_URL,
};
