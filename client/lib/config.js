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
const accountsLib = require('./accounts');

/**
 * 内置默认公网服务地址（用户可用 --url 或环境变量覆盖）。
 *
 * ── 这里曾经是 `wss://remotetype.example.com/ws` ─────────────────────────
 * 那是脚手架时期的**占位域名，永远不会解析**。它在只有 `serve --url ...` 的年代
 * 无害（用户总是带 --url），但 README 把 `npx nx-rt auth login` 写成推荐用法之后，
 * 零参数路径就必然失败，而失败信息是一句裸的 `getaddrinfo ENOTFOUND`——
 * 既没说"你用的是默认地址"，也没说"该加 --url"。（真实用户在另一台机器上踩到了。）
 * 默认值要么是能用的一处，要么就该在用到它时明确报错，两者都不做就是埋雷。
 *
 * 现在指向真实部署，与 server/DEPLOY.md 的服务器档案、fr 的 kRemoteTypeServerUrl 同源。
 */
const DEFAULT_SERVE_URL = 'ws://1.94.101.189:8790/ws';

/**
 * 脚手架时代遗留的占位地址。
 *
 * 装过 0.5.2 及更早版本、且当时把默认值连配置一起存过盘的设备，配置里可能还留着
 * `.example.com`。这类值不该"试一次然后抛 DNS 错"，而该当场说清是地址没配。
 */
const PLACEHOLDER_HOSTS = ['remotetype.example.com'];

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
 * 原子写整份配置文件：同目录 tmp（0600）→ fsync → rename。
 *
 * 为什么必须整份原子替换：写入方已经不止一个了——长期运行的 serve 会在
 * 「registered 登记成功」与「服务端下发会话密钥」两个时机回写配置，而用户随时可能在
 * 另一个终端跑 auth login。非原子的半截文件会被下一次合并读（readConfigFile 解析失败
 * 返回 {}）当成空配置，等于把凭据静默清空。
 *
 * 明确**没有**跨进程互斥：两个写入方各自「读—合并—整份替换」，交错时后写的一方
 * 覆盖前一方（last-write-wins）。文件名带 pid，所以至少不会两方共写同一个 tmp。
 * 这是可接受的：可能丢的只是 serve 回写的 sessionKey/url，而 sessionKey 在下次
 * register 时会由服务端重新下发（registered 帧）自愈；反过来为一份配置上锁，
 * 会把复杂度加在所有路径上，不划算。
 *
 * rename 在 Windows 上可能被扫描器/索引器占住（EPERM/EBUSY），所以带几次短重试；
 * 仍然失败就抛错——调用方（serve 的回写路径）必须自己兜住，不能让一次写盘抖动
 * 打死一个健康的 serve。
 * @param {object} nextRaw 将要落盘的完整配置对象
 * @returns {{file: string}}
 */
function writeConfigFile(nextRaw) {
  const file = configFile();
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  let fd = null;
  try {
    // 0600 建 tmp：rename 之后到 chmod 之前有个窗口，别让别的用户读到令牌
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(nextRaw, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd); // 断电也不留半截文件（rename 只保证"要么旧的、要么完整的新的"）
    fs.closeSync(fd);
    fd = null;
    renameWithRetry(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* 清理失败无所谓 */ }
    throw e;
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // 权限收紧失败不阻断：文件在用户自己的配置目录里
    }
  }
  return { file };
}

/** rename 覆盖已存在的文件在 Windows 上可能撞上 EPERM/EBUSY（杀软扫描、索引器）。 */
function renameWithRetry(from, to) {
  let lastErr = null;
  for (let i = 0; i < 4; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
      // 忙等几毫秒：这类占用都是瞬时的
      const until = Date.now() + 20;
      while (Date.now() < until) { /* spin */ }
    }
  }
  throw lastErr;
}

/** 运行期会被服务端纠正/更新的字段（回写账号条目时只动这些）。 */
const RUN_PATCH_KEYS = ['url', 'sessionKey', 'serverHttp', 'deviceName'];

/** 把运行期字段并进条目（不动身份字段）。 */
function patchEntry(entry, relevant) {
  const patch = {};
  for (const k of RUN_PATCH_KEYS) if (relevant[k]) patch[k] = relevant[k];
  return accountsLib.mergeEntryFields(entry, patch);
}

/**
 * 条目必须有非空 clientId 才能落盘。
 *
 * 为什么是硬要求：flat 的 clientId 是"当前账号的本机标识"，而
 * buildFlatSyncPatch 会跳过空值——条目 clientId 一旦为空，切换账号时 flat 就会
 * **留着上一个账号的 clientId**，于是拿 A 的设备令牌配 B 的标识去注册
 * （4401 token_client_mismatch）。老配置迁移出来的条目正是这种情况（0.5.x 从不写
 * flat clientId），所以这里用机器默认标识兜底，保证条目一落地就自洽。
 */
function entryWithClientId(entry, relevant, existing) {
  if (entry.clientId) return entry;
  return {
    ...entry,
    clientId: relevant.clientId || existing.clientId || ensureClientId(),
  };
}

/**
 * 保存本次成功连接使用的连接参数（url / alignKey / token / 统一登录产物）到配置文件，
 * 作为下次运行的默认值——「最后一次成功连接 = 下次默认」。
 *
 * 只写传入对象里的非空字段（未携带的字段保留文件里已有的值，绝不抹掉）；
 * 与文件现状无差异时不重写。合并写入，文件里其他字段原样保留。
 *
 * 多账号下的两条路径（不变式：flat 字段永远镜像 active 账号）：
 *   - 本次运行的账号 == active（或没传 accountKey）：写 flat，**并**把运行期字段
 *     回写进该账号条目——否则条目里的 sessionKey 会停在旧值，之后切走再切回来
 *     就要拿一把陈旧密钥去解密；
 *   - 本次运行的账号 != active（serve --account 跑的是别人账号）：只写那个条目，
 *     flat 一个字节都不动，"当前激活账号"的镜像关系不被破坏。
 *
 * 老配置（文件里**还没有** accounts 表）只写 flat，绝不凭空生成账号表：
 * 这样"升级后第一次裸跑 serve"的行为与从前逐字节一致，注册与回写都不变。
 * 账号表只由 auth login / auth switch 这些显式动作建立。
 *
 * @param {object} cfg loadConfig 产物（读 url/alignKey/token/… 字段）
 * @param {{accountKey?: string}} [opts] 本次运行所属账号的 key
 * @returns {{changed: boolean, file: string}}
 */
function saveConnectionConfig(cfg, opts = {}) {
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
  // clientId 同样要落 flat：切换账号后它就是"当前账号的本机标识"，
  // 不写就会退回机器默认 id → WS register 4401 token_client_mismatch。
  if (cfg.clientId) relevant.clientId = cfg.clientId;

  const file = configFile();
  const existing = readConfigFile();

  // 只有文件里**已经有** accounts 表时才谈"哪个账号"：老配置一次都不该被我们
  // 悄悄升级成账号表（升级动作只发生在 auth login / auth switch）。
  const persistedAccounts = (existing.accounts && typeof existing.accounts === 'object')
    ? existing.accounts : null;
  const hasTable = Boolean(persistedAccounts && Object.keys(persistedAccounts).length > 0);

  let next;
  if (!hasTable) {
    next = { ...existing, ...relevant };
  } else {
    const view = accountsLib.withAccounts(existing, { defaultClientId: ensureClientId() });
    const runKey = opts.accountKey || null;
    // 本次运行的账号已经被删掉了（另一个终端 auth logout / logout --all）：
    // 一个字都不写。否则 serve 的这次回写会把刚登出的凭据又写回 flat，
    // 于是"账号表空了但 flat 显示已登录"，两台机器看到的登录态直接打架。
    if (runKey && !view.accounts[runKey]) return { changed: false, file };
    // 注意 targetKey 只从**有表**的现状里挑：--account 指定的账号，或文件里的激活账号。
    // 本次运行的账号必须由调用方在启动时就定下来（cmdServe 会传），不能在这里
    // 按"当前激活"重新解析——那样 serve 跑着的时候另一个终端切了账号，
    // 这次回写就会写进**别人的**条目，还会把别人的 flat 一起改掉。
    const targetKey = runKey && view.accounts[runKey]
      ? runKey
      : (view.activeAccountKey && view.accounts[view.activeAccountKey] ? view.activeAccountKey : null);

    if (targetKey && view.activeAccountKey !== targetKey) {
      // 借用的**别人账号**（serve --account）：只写它自己的条目。
      // flat 是"当前激活账号"的镜像，这里一个字节都不能动——否则别人的 url/key
      // 会渗进激活账号，下次裸跑 serve 就连错了账号。
      next = {
        ...existing,
        accounts: { ...persistedAccounts, ...view.accounts, [targetKey]: entryWithClientId(patchEntry(view.accounts[targetKey], relevant), relevant, existing) },
      };
    } else {
      next = { ...existing, ...relevant };
      if (targetKey) {
        // 激活账号：条目与 flat 一起更新（只写 flat 的话，切走再切回来会拿到旧 sessionKey）
        const merged = entryWithClientId(patchEntry(view.accounts[targetKey], relevant), relevant, existing);
        next.accounts = { ...persistedAccounts, ...view.accounts, [targetKey]: merged };
        next.activeAccount = targetKey; // 指针缺失时顺手补上（否则 auth logout 找不到"当前账号"）
        Object.assign(next, accountsLib.buildFlatSyncPatch(merged));
      }
    }
  }

  if (JSON.stringify(existing) === JSON.stringify(next)) return { changed: false, file };
  writeConfigFile(next);
  return { changed: true, file };
}

/** 登出时要一并抹掉的 flat 凭据（多账号下还包含 clientId——它属于那个账号）。 */
const FLAT_AUTH_KEYS = ['deviceToken', 'sessionKey', 'authUser', 'clientId'];

/**
 * 登出。
 *
 *   - 默认（多账号）：只清**当前激活**那一个账号——删它的条目、清 flat 凭据、
 *     摘掉 activeAccount 指针；其余账号原样保留，但**不自动接任**新账号
 *     （静默换成另一个人的身份比"多敲一条命令"危险得多）。清完就是"未登录"态。
 *     刻意**保留** `deviceIds`：那只是"账号 → 本机设备标识"的记忆，不是凭据。
 *     留着它，同一个账号重新登录会恢复原设备（手机端照旧连得上），
 *     而不是每登一次就多出一台连不上的新电脑。
 *   - `{all: true}`：清空整张账号表 + 设备标识记忆（本机彻底退出统一登录）。
 *
 * 两条路都刻意**不动** `alignKey` 与 `token`——那是老的"人手传配对 key / RT_TOKEN"
 * 路径，与统一登录并存，logout 不应该顺手把人家的旧配置清了。
 * 老配置（无 accounts 表）行为与从前逐字节一致。
 * @param {{all?: boolean}} [opts]
 * @returns {{changed: boolean, file: string, remaining: number}}
 */
function clearAuthCredentials(opts = {}) {
  const file = configFile();
  const existing = readConfigFile();
  const hadFlat = FLAT_AUTH_KEYS.some((k) => existing[k] !== undefined);
  const hadMap = existing.accounts !== undefined || existing.activeAccount !== undefined;

  if (opts.all) {
    const hadDeviceIds = existing.deviceIds !== undefined;
    if (!hadFlat && !hadMap && !hadDeviceIds) return { changed: false, file, remaining: 0 };
    const next = { ...existing };
    for (const k of [...FLAT_AUTH_KEYS, 'accounts', 'activeAccount', 'deviceIds']) delete next[k];
    writeConfigFile(next);
    return { changed: true, file, remaining: 0 };
  }

  const view = accountsLib.withAccounts(existing, { defaultClientId: ensureClientId() });
  const activeKey = view.activeAccountKey;
  const next = { ...existing };
  let removed = false;
  if (activeKey && view.accounts[activeKey]) {
    // 起点是**文件里原样的表**：手改坏的条目原样留着，不因为我们看不懂就删掉
    const rest = { ...(existing.accounts || {}), ...view.accounts };
    delete rest[activeKey];
    removed = true;
    if (Object.keys(rest).length > 0) next.accounts = rest;
    else delete next.accounts; // 老配置登出后不该凭空多出一个空 accounts 表
    delete next.activeAccount;
  }
  for (const k of FLAT_AUTH_KEYS) delete next[k];

  // 只有真的删掉了一个条目、或真的清掉了 flat 凭据，才算改动；
  // "存在 accounts 表"本身不是改动——否则登出会永远报"已清除"且每次重写文件。
  if (!hadFlat && !removed) return { changed: false, file, remaining: next.accounts ? Object.keys(next.accounts).length : 0 };
  writeConfigFile(next);
  return { changed: true, file, remaining: next.accounts ? Object.keys(next.accounts).length : 0 };
}

/**
 * 记下一个账号的完整登录态并（可选）激活它——`auth login` 的落盘入口。
 *
 * 惰性迁移在这里固化：老配置里的 flat 凭据会由 withAccounts 合成为首个条目，
 * 于是"第二个人登录"不会把第一个人的登录态挤掉。
 *
 * 同时记下 `deviceIds[账号] = clientId`：这份"账号 → 本机设备标识"的记忆**不随登出
 * 清掉**（见 clearAuthCredentials），于是同一账号登出再登回来会恢复原标识，
 * 不会每登一次就在服务端多出一台"再也连不上的电脑"。
 * @param {{entry: object, setActive?: boolean}} args
 * @returns {{changed: boolean, key: string, file: string}}
 */
function saveAuthAccount({ entry, setActive = true }) {
  const file = configFile();
  const existing = readConfigFile();
  // 迁移播种必须用**机器默认标识**（ensureClientId），不能用本次登录账号的
  // clientId：老配置里没有 flat clientId，拿新账号的 id 去播种会让两个账号共用
  // 同一个标识——老账号之后既登不回来（服务端 403），切过去也注册不上（4401）。
  const view = accountsLib.withAccounts(existing, { defaultClientId: ensureClientId() });
  const key = accountsLib.entryKeyOf(entry);
  const entryWithId = entry.clientId ? { ...entry } : { ...entry, clientId: ensureClientId() };
  const accounts = {
    ...(existing.accounts && typeof existing.accounts === 'object' ? existing.accounts : {}),
    ...view.accounts,
    [key]: entryWithId,
  };
  const next = { ...existing, accounts };
  // 账号 → 设备标识的记忆（与凭据分开存，登出不清）
  if (accounts[key].clientId) {
    next.deviceIds = { ...(existing.deviceIds || {}), [key]: accounts[key].clientId };
  }
  if (setActive) {
    next.activeAccount = key;
    Object.assign(next, accountsLib.buildFlatSyncPatch(accounts[key]));
  }
  if (JSON.stringify(existing) === JSON.stringify(next)) return { changed: false, key, file };
  writeConfigFile(next);
  return { changed: true, key, file };
}

/**
 * 切换激活账号：设指针 + 把该账号的条目打平成 flat
 * （deviceToken / sessionKey / **clientId** / serverHttp / url / deviceName / authUser）。
 * 跨部署切换时 url/serverHttp 必须一起走，否则会拿 A 服务器的令牌去连 B。
 * @param {string} target 序号 / 邮箱 / 用户名 / 昵称 / 完整 key
 * @param {{defaultClientId?: string}} [opts]
 * @returns {{changed: boolean, key: string, entry: object, file: string}}
 * @throws {Error} 目标找不到或有歧义时抛出（message 已含候选清单）
 */
function switchActiveAccount(target, opts = {}) {
  const file = configFile();
  const existing = readConfigFile();
  const { key, entry } = accountsLib.resolveAccountEntry(existing, target, opts);
  // 老配置迁移出来的条目可能没有 clientId；缺了就补机器默认标识并写回条目，
  // 否则 flat 会保留**上一个账号**的 clientId（正是 4401 那类故障）。
  const fixed = entry.clientId ? entry : { ...entry, clientId: existing.clientId || ensureClientId() };
  const accounts = { ...(existing.accounts || {}), [key]: fixed };
  const next = {
    ...existing, accounts, activeAccount: key, ...accountsLib.buildFlatSyncPatch(fixed),
  };
  if (JSON.stringify(existing) === JSON.stringify(next)) {
    return { changed: false, key, entry: fixed, file };
  }
  writeConfigFile(next);
  return { changed: true, key, entry: fixed, file };
}

/**
 * 按「主机名-6 位随机」生成一个 clientId（不落盘）。
 * @param {Set<string>|string[]} [exclude] 需要避让的 id（同一台机器上的其他账号）
 *   服务端 clientId→属主 是永久一对一，复用已登记的标识会直接 403
 *   device_owned_by_other，所以多账号下每个账号必须领一个自己的标识。
 */
function generateClientId(exclude) {
  const host = (os.hostname() || 'pc').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20);
  const skip = exclude instanceof Set ? exclude : new Set(exclude || []);
  let id = '';
  for (let i = 0; i < 20; i += 1) {
    id = `${host}-${Math.random().toString(36).slice(2, 8)}`;
    if (!skip.has(id)) return id;
  }
  return id; // 36^6 空间里连撞 20 次的概率可忽略；真发生也照常返回，不阻断登录
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

  const id = generateClientId();
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

/**
 * 这个地址是不是一个占位符 / 根本没配。
 * 返回说明文字表示"是"，null 表示"不是"。
 *
 * 判据放在配置层而不是散在各命令里：`auth login` 与 `serve` 都要在真正发请求之前
 * 先问这一句，否则用户拿到的将是 `getaddrinfo ENOTFOUND`——一句话都不告诉他。
 * @param {string} url
 * @returns {string|null}
 */
function placeholderUrlReason(url) {
  if (!url) return '未配置服务地址';
  let host = '';
  try {
    host = new URL(String(url)).hostname;
  } catch {
    return `服务地址无法解析：${url}`;
  }
  if (PLACEHOLDER_HOSTS.includes(host)) {
    return `服务地址还是脚手架占位值：${url}`;
  }
  // RFC 2606/6761 把这些后缀永久保留给文档与测试，不可能有公网解析结果。
  // 真出现在配置里就等于"没人把它改成过能用的地址"，比试一次抛 DNS 错诚实得多。
  const lower = host.toLowerCase();
  const reserved = ['.example.com', '.example.net', '.example.org', '.test', '.invalid', '.localhost'];
  if (reserved.some((s) => lower.endsWith(s)) || lower === 'example.com') {
    return `服务地址指向保留域名：${host}`;
  }
  return null;
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
    // 文件上传的接收目录（v0.9.0+）：手机传来的文件先落盘这里，再以
    // CF_HDROP 复制进剪贴板——剪贴板里的「文件」是磁盘引用，必须有实体路径
    receiveDir:
      flags.receiveDir ?? env.REMOTETYPE_RECEIVE_DIR ?? file.receiveDir ??
      path.join(os.homedir(), 'Downloads', 'RemoteType'),
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
    // 连通后把 url/key/token 存入配置文件（下次 serve 直连）；--no-save 本次不落盘
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
  generateClientId,
  readConfigFile,
  writeConfigFile,
  migrateLegacyConfigDir,
  saveConnectionConfig,
  saveAuthAccount,
  switchActiveAccount,
  clearAuthCredentials,
  resolveEnterMode,
  httpBaseFromWs,
  placeholderUrlReason,
  DEFAULT_SERVE_URL,
};
