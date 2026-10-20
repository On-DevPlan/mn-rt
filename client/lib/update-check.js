'use strict';

/**
 * 启动时自更新检查（仅 serve 命令路径调用）。
 *
 * 流程：查 npm registry 上的 latest → 本地落后则询问 → 同意则 npm 升级并以新版本重启。
 * 设计要点：
 *   - registry 逐源尝试：NX_RT_REGISTRY → ~/.npmrc → 官方源 → npmmirror 镜像兜底
 *     （国内直连 npmjs 经常瞬断，镜像基本必通）；
 *   - 10 分钟内查过就直接用缓存结果（~/.nx-rt/update-check.json），不重复打网络；
 *   - 任何失败（断网/超时/解析失败）都不阻塞正常启动（最多打一行暗色提示）；
 *   - stdin 已关闭（管道/NUL）立刻视为「否」，不等待；
 *   - TTY 下 PROMPT_TIMEOUT_MS 无输入也视为「否」——人走开了别把守护进程卡在提问上；
 *   - 升级成功自动用新版本重启（继承原 argv）；失败打一行手动命令继续跑旧版；
 *   - 仓库开发目录（路径不在 node_modules 下）不自动升级，只给提示。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');
const readline = require('readline');
const { configDir } = require('./config');

const pkg = require('../package.json');

const PKG_NAME = pkg.name;
const CHECK_TIMEOUT_MS = 2000;
const CHECK_RETRY_GAPS_MS = [500, 1000];
const CACHE_TTL_MS = 10 * 60 * 1000;
const PROMPT_TIMEOUT_MS = 15 * 1000;
const INSTALL_TIMEOUT_MS = 180 * 1000;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

function say(msg = '') {
  process.stdout.write(`${msg}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 比较 x.y.z 版本号：a 是否严格大于 b（忽略预发布后缀，本包版本不含）。 */
function semverGt(a, b) {
  const pa = String(a || '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10));
  const pb = String(b || '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** registry 候选：NX_RT_REGISTRY → ~/.npmrc 的 registry= → 官方源 → npmmirror 兜底。 */
function npmRegistryBases() {
  const bases = [];
  const push = (u) => {
    if (!u) return;
    const clean = String(u).replace(/\/+$/, '');
    if (!bases.includes(clean)) bases.push(clean);
  };
  push(process.env.NX_RT_REGISTRY);
  try {
    const npmrc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
    const m = npmrc.match(/^\s*registry\s*=\s*(\S+)/m);
    if (m) push(m[1]);
  } catch (_) { /* 没有 ~/.npmrc 就用默认 */ }
  push('https://registry.npmjs.org');
  push('https://registry.npmmirror.com');
  return bases;
}

function cacheFile() {
  return path.join(configDir(), 'update-check.json');
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return j && typeof j.version === 'string' && Number.isFinite(j.at) ? j : null;
  } catch (_) {
    return null;
  }
}

function writeCache(version) {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), version }));
  } catch (_) { /* 缓存写失败无所谓 */ }
}

async function fetchOnce(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/${PKG_NAME}/latest`, {
      signal: ctrl.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data.version === 'string' && data.version ? data.version : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 逐源查 latest：主源重试一次，其余源（含镜像兜底）各一次。 */
async function fetchLatestVersion() {
  const bases = npmRegistryBases();
  for (let b = 0; b < bases.length; b += 1) {
    const attempts = b === 0 ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const v = await fetchOnce(bases[b]);
      if (v) return v;
      if (attempt < attempts) await sleep(CHECK_RETRY_GAPS_MS[attempt - 1]);
    }
  }
  return null;
}

/** 问一次 Y/n。Enter=是；n/N/其他=否；超时或 stdin 关闭=否。 */
function promptYesNo(question, timeoutMs) {
  return new Promise((resolve) => {
    if (!process.stdin.readable) return resolve(false);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      resolve(val);
    };
    const timer = setTimeout(() => {
      process.stdout.write('\n');
      finish(false);
    }, timeoutMs);
    rl.once('close', () => finish(false));
    rl.question(question, (answer) => {
      finish(/^\s*[yY]\s*$/.test(answer || ''));
    });
  });
}

/**
 * 判断本包的安装方式：
 *   - pkgRoot 的上级目录名是 node_modules → 用户安装（local 或 global），可自动升级；
 *   - 否则视为仓库开发目录，返回 null（不自动动仓库）。
 */
function resolvePkgRoot() {
  const pkgRoot = path.resolve(__dirname, '..');
  if (path.basename(path.dirname(pkgRoot)) !== 'node_modules') return null;
  return pkgRoot;
}

function isGlobalInstall(pkgRoot) {
  return new Promise((resolve) => {
    exec('npm root -g', { timeout: CHECK_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(false);
      resolve(path.resolve(stdout.trim()) === path.dirname(pkgRoot));
    });
  });
}

/** 跑 npm install，stdio 直通让用户看到进度。返回是否 0 退出。 */
function runNpmInstall(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** 用升级后的代码重启自身（继承原 argv），退出当前进程。返回 true 表示已交接。 */
function respawnWith(pkgRoot, argv) {
  const entry = path.join(pkgRoot, 'bin', 'index.js');
  try {
    const child = spawn(process.execPath, [entry, ...argv], { stdio: 'inherit', windowsHide: true });
    child.once('exit', (code) => process.exit(code || 0));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * serve 前的自更新入口。返回值仅表示「是否已交接给新进程」，
 * 调用方拿到 true 后直接 return，不要继续起旧版 serve。
 */
async function maybeUpdateCheck({ flags = {}, argv = [] } = {}) {
  if (flags.noUpdateCheck || process.env.NX_RT_NO_UPDATE_CHECK) return false;
  const pkgRoot = resolvePkgRoot();
  if (!pkgRoot) return false; // 仓库开发目录：不动

  // 10 分钟内查过 → 直接用缓存版本比对，不打网络
  const cached = readCache();
  let latest = cached && Date.now() - cached.at < CACHE_TTL_MS ? cached.version : null;
  if (!latest) {
    latest = await fetchLatestVersion();
    if (latest) writeCache(latest);
  }
  if (!latest) {
    say(`${C.dim}版本检查未完成（网络不稳定），跳过${C.reset}`);
    return false;
  }
  if (!semverGt(latest, pkg.version)) return false;

  say(`${C.cyan}发现新版本 ${C.bold}v${latest}${C.reset}${C.cyan}（当前 v${pkg.version}），是否下载更新？${C.reset}${C.dim}[Y/n] 15s 内未输入则跳过${C.reset}`);
  const yes = await promptYesNo('> ', PROMPT_TIMEOUT_MS);
  if (!yes) {
    say(`${C.dim}已跳过更新，继续使用 v${pkg.version}（--no-update-check 可关掉启动检查）${C.reset}`);
    return false;
  }

  const global = await isGlobalInstall(pkgRoot);
  say(`${C.cyan}正在更新 ${PKG_NAME} → v${latest}（${global ? 'global' : 'local'}）…${C.reset}`);
  const args = global
    ? ['install', '-g', `${PKG_NAME}@${latest}`]
    : ['install', `${PKG_NAME}@${latest}`];
  const ok = await runNpmInstall(args, global ? undefined : path.dirname(path.dirname(pkgRoot)));
  if (!ok) {
    say(`${C.red}✗ 更新失败，继续使用 v${pkg.version}。可手动执行：npm install ${global ? '-g ' : ''}${PKG_NAME}@latest${C.reset}`);
    return false;
  }

  // 落盘校验：package.json 的版本确实变了再重启
  let newVersion = null;
  try {
    newVersion = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
  } catch (_) { /* 读不到就当失败 */ }
  if (!newVersion || !semverGt(newVersion, pkg.version)) {
    say(`${C.yellow}! 更新未生效，继续使用 v${pkg.version}${C.reset}`);
    return false;
  }

  say(`${C.green}✓ 已更新到 v${newVersion}，正在重启…${C.reset}`);
  if (respawnWith(pkgRoot, argv)) return true;
  say(`${C.yellow}! 自动重启失败，请手动重新运行${C.reset}`);
  return false;
}

module.exports = {
  maybeUpdateCheck,
  semverGt,
  npmRegistryBases,
  fetchLatestVersion,
};
