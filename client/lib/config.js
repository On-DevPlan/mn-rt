'use strict';

/**
 * 配置解析：默认值 < 配置文件 < 环境变量 < 命令行参数。
 *
 * 配置文件位置：~/.nx-rt/config.json
 * 环境变量前缀：REMOTETYPE_
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveTarget } = require('./platform');

/** 内置默认公网服务地址（用户可用 --url 或环境变量覆盖）。 */
const DEFAULT_SERVE_URL = 'wss://remotetype.example.com/ws';

/** 配置目录：~/.nx-rt（旧版 ~/.remotetype / %APPDATA%\remotetype 首次访问自动迁移） */
let legacyDirMigrated = false;
function configDir() {
  const base =
    process.env.NX_RT_HOME ||
    process.env.REMOTETYPE_HOME || // 0.5.1 及以前的变量名，仍兼容
    path.join(os.homedir(), '.nx-rt');
  if (!legacyDirMigrated) {
    legacyDirMigrated = true;
    // 显式指定了目录（测试/多实例）时不做迁移，避免碰真实用户目录
    if (!process.env.NX_RT_HOME && !process.env.REMOTETYPE_HOME) {
      migrateLegacyConfigDir(base);
    }
  }
  return base;
}

/** 旧版配置目录（0.5.1 及以前）。 */
function legacyConfigDirs() {
  const dirs = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, 'remotetype'));
  }
  dirs.push(path.join(os.homedir(), '.remotetype'));
  return dirs;
}

/**
 * 一次性迁移：新目录尚不存在时，从旧目录拷贝有状态的小文件
 * （client-id 保身份、config.json 保连接记忆）；logs/data 属历史产物不迁。
 * 幂等、静默：任何失败都放弃迁移（大不了重新配对），绝不阻断启动。
 * @param {string} newDir 新配置目录
 * @returns {boolean} 是否发生了拷贝
 */
function migrateLegacyConfigDir(newDir) {
  try {
    if (fs.existsSync(newDir)) return false;
    for (const oldDir of legacyConfigDirs()) {
      if (!fs.existsSync(oldDir)) continue;
      fs.mkdirSync(newDir, { recursive: true });
      let copied = false;
      for (const name of ['client-id', 'config.json']) {
        const src = path.join(oldDir, name);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(newDir, name));
          copied = true;
        }
      }
      return copied;
    }
    return false;
  } catch {
    return false;
  }
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

/**
 * 保存本次成功连接使用的连接参数（url / alignKey / token）到配置文件，
 * 作为下次运行的默认值——「最后一次成功连接 = 下次默认」。
 *
 * 只写传入对象里的非空字段（未携带的字段保留文件里已有的值，绝不抹掉）；
 * 与文件现状无差异时不重写。合并写入，文件里其他字段原样保留。
 * @param {object} cfg loadConfig 产物（读 url/alignKey/token 字段）
 * @returns {{changed: boolean, file: string}}
 */
function saveConnectionConfig(cfg) {
  const relevant = {};
  if (cfg.url) relevant.url = cfg.url;
  if (cfg.alignKey) relevant.alignKey = cfg.alignKey;
  if (cfg.token) relevant.token = cfg.token;
  // 统一登录产物。三个要一起有：只有 deviceToken 而没有 sessionKey，
  // 下次 serve 就还得退回"人手传配对 key"，等于白登录一趟。
  if (cfg.deviceToken) relevant.deviceToken = cfg.deviceToken;
  if (cfg.sessionKey) relevant.sessionKey = cfg.sessionKey;
  if (cfg.deviceName) relevant.deviceName = cfg.deviceName;
  if (cfg.authUser) relevant.authUser = cfg.authUser;
  if (cfg.serverHttp) relevant.serverHttp = cfg.serverHttp;

  const file = configFile();
  const existing = readConfigFile();
  const changed = Object.keys(relevant).some((k) => existing[k] !== relevant[k]);
  if (!changed) return { changed: false, file };

  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, ...relevant }, null, 2)}\n`, 'utf8');
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // 权限收紧失败不阻断：文件在用户自己的配置目录里
    }
  }
  return { changed: true, file };
}

/**
 * 登出：抹掉统一登录产物（设备令牌 / 会话密钥 / 身份快照）。
 *
 * 刻意**不动** `alignKey` 与 `token`——那是老的"人手传配对 key / RT_TOKEN"路径，
 * 与统一登录并存，logout 不应该顺手把人家的旧配置清了。
 * @returns {{changed: boolean, file: string}}
 */
function clearAuthCredentials() {
  const file = configFile();
  const existing = readConfigFile();
  const keys = ['deviceToken', 'sessionKey', 'authUser'];
  const changed = keys.some((k) => existing[k] !== undefined);
  if (!changed) return { changed: false, file };

  const next = { ...existing };
  for (const k of keys) delete next[k];
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* 不阻断 */ }
  }
  return { changed: true, file };
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
      const [rawKey, inline] = arg.slice(2).split('=');
      // --client-id → clientId：loadConfig 按驼峰读取，
      // 曾因不做映射导致所有多词参数（--client-id/--log-level/…）静默失效
      const key = rawKey.replace(/-([a-zA-Z])/g, (_, c) => c.toUpperCase());
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
/**
 * 从 WS 地址推出同源的 HTTP 基址。
 *
 * 统一登录的接口（/auth/oidc/config、/auth/verify、/my/devices）都挂在
 * 与 WS **同一个端口**的 HTTP 上（服务端把 WebSocketServer 挂在 httpServer 上），
 * 所以 ws://host:8790/ws → http://host:8790。让用户再填一遍服务器地址是没必要的摩擦。
 */
function httpBaseFromWs(wsUrl) {
  if (!wsUrl) return null;
  try {
    const u = new URL(String(wsUrl));
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${proto}//${u.host}`;
  } catch {
    return null;
  }
}

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
    // 对齐模式（serve 默认开启；--plain 切回旧普通模式，--align 保留兼容）
    align: flags.plain === true ? false : true,
    alignKey: flags.key ?? env.REMOTETYPE_KEY ?? file.alignKey ?? null,
    // 注册门禁 token（服务器设 RT_TOKEN 后必须携带同一值才能注册）
    token: flags.token ?? env.REMOTETYPE_TOKEN ?? env.RT_TOKEN ?? file.token ?? null,
    // ── 统一登录产物 ────────────────────────────────────────────────────────
    // deviceToken 是服务端签发的设备令牌；sessionKey 取代人手传的配对 key。
    // 命令行显式给的 --key 优先级高于存盘的 sessionKey：
    // 让人能临时连一台未走统一登录的老服务器，而不必先清配置。
    deviceToken: flags.deviceToken ?? env.REMOTETYPE_DEVICE_TOKEN ?? file.deviceToken ?? null,
    sessionKey: flags.key ?? env.REMOTETYPE_KEY ?? file.sessionKey ?? file.alignKey ?? null,
    // 设备显示名：fr「我的电脑」列表里看到的那一行。默认取主机名，够用且零配置。
    deviceName: flags.deviceName ?? env.REMOTETYPE_DEVICE_NAME ?? file.deviceName
      ?? (os.hostname() || 'pc'),
    authUser: file.authUser || null,
    serverHttp: flags.serverHttp ?? env.REMOTETYPE_SERVER_HTTP
      ?? file.serverHttp ?? httpBaseFromWs(url),
    // 文本中 '\n' 的换行方式（透传 rust 的 enter_mode）：
    //   'raw'（默认）旧行为；'enter' 单击 Enter；'shift_enter' 敲 Shift+Enter。
    //   后两者用于「Enter=发送」的输入框（IM、Web 聊天框）；非法值由 rust 拒绝并报错。
    enterMode: flags.enterMode ?? env.REMOTETYPE_ENTER_MODE ?? file.enterMode ?? 'raw',
    // 连通后把 url/key/token 存入配置文件（下次裸命令直连）；--no-save 本次不落盘
    noSave: flags.noSave === true,
    configDir: configDir(),
    configFile: configFile(),
    target,
  };

  return cfg;
}

/**
 * 合并手机快照携带的 enterMode 与本地配置，得到本次注入生效的换行方式。
 * 优先级：手机字段 > CLI/配置文件 > 'raw'。
 * 手机端只允许 'enter' | 'shift_enter'（'raw' 是老手机缺省时的 PC 侧兜底，
 * 不作为手机端合法取值），非法值一律视为未携带。
 * cfg 侧的非法值不做拦截——透传给 rust，由 rust 拒绝并给出明确报错。
 * @param {string|undefined} phoneMode 手机快照里的 enterMode
 * @param {string|undefined} cfgMode   本地配置的 enterMode
 * @returns {'enter'|'shift_enter'|'raw'|string}
 */
function resolveEnterMode(phoneMode, cfgMode) {
  if (phoneMode === 'enter' || phoneMode === 'shift_enter') return phoneMode;
  if (typeof cfgMode === 'string' && cfgMode !== '') return cfgMode;
  return 'raw';
}

module.exports = {
  loadConfig,
  parseArgs,
  configDir,
  configFile,
  ensureClientId,
  readConfigFile,
  migrateLegacyConfigDir,
  saveConnectionConfig,
  clearAuthCredentials,
  resolveEnterMode,
  httpBaseFromWs,
  DEFAULT_SERVE_URL,
};
