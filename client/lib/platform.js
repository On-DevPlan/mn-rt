'use strict';

/**
 * 平台识别 + Rust 二进制定位。
 *
 * 分发策略（需求文档 5.1 的「优化方案」）：
 *   1. 优先本地 binaries/<platform>-<arch>/input-agent[.exe]，便于 monorepo / 离线场景；
 *   2. 其次查找平台分包 @remotetype/input-agent-<platform>-<arch>（推荐：主包极小）；
 *   3. 最后回退到运行时按需下载（从 GitHub Releases），带缓存。
 *
 * 这样主包只含 JS 代码，npx 下载体积最小，同时保留离线可用路径。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 解析目标平台标识，例如 win32-x64 / darwin-arm64 / linux-x64 */
function resolveTarget(platform = process.platform, arch = process.arch) {
  const p = platform === 'win32' ? 'win32' : platform;
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  return { platform: p, arch: a, key: `${p}-${a}` };
}

/** 当前平台的二进制文件名 */
function binaryName(platform) {
  return platform === 'win32' ? 'input-agent.exe' : 'input-agent';
}

/**
 * 判断平台是否受支持。
 * 需求：Windows x64 / macOS(x64,arm64) / Linux X11(x64)
 */
function isSupported(platform, arch) {
  const t = resolveTarget(platform, arch);
  const supported = [
    'win32-x64',
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-arm64', // 额外宽松支持（源码可编译）
  ];
  return supported.includes(t.key);
}

/**
 * 在若干候选目录中查找二进制。
 * @returns {string|null} 二进制绝对路径
 */
function findBinary({ platform = process.platform, arch = process.arch, extraDirs = [] } = {}) {
  const target = resolveTarget(platform, arch);
  const file = binaryName(target.platform);

  const candidates = [];

  // 1) 显式额外目录（测试 / 自定义安装）
  for (const dir of extraDirs) candidates.push(path.join(dir, file));

  // 2) 包内 binaries/<key>/（发布时随包分发，或本地编译产物）
  candidates.push(path.join(__dirname, '..', 'binaries', target.key, file));

  // 3) 平台分包 @remotetype/input-agent-<key>
  try {
    const pkg = `@remotetype/input-agent-${target.key}`;
    const pkgJson = require.resolve(`${pkg}/package.json`);
    candidates.push(path.join(path.dirname(pkgJson), file));
  } catch {
    // 未安装平台分包，忽略
  }

  // 4) 运行时缓存目录（按需下载后落到这里）
  candidates.push(path.join(cacheDir(), target.key, file));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // 忽略单个候选的读取错误，继续下一个
    }
  }
  return null;
}

/** 缓存目录：~/.remotetype/binaries */
function cacheDir() {
  const base =
    process.env.REMOTETYPE_CACHE ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'remotetype')
      : path.join(os.homedir(), '.remotetype'));
  return path.join(base, 'binaries');
}

/** 二进制默认下载源（GitHub Releases）。可用环境变量覆盖。 */
function downloadBaseUrl() {
  const version = process.env.REMOTETYPE_VERSION || 'v0.1.0';
  return (
    process.env.REMOTETYPE_BINARY_BASE ||
    `https://github.com/ZHLX2005/mn-rt/releases/download/${version}`
  );
}

/**
 * 二进制下载地址。
 *
 * GitHub Release 的资产是扁平的，无法保留目录层级，
 * 因此名义为 `input-agent-<platform>-<arch>[.exe]`
 * （与 build-input-agent.yml 中 release job 的命名保持一致）。
 */
function binaryUrl(target = resolveTarget()) {
  const ext = target.platform === 'win32' ? '.exe' : '';
  return `${downloadBaseUrl()}/input-agent-${target.key}${ext}`;
}

module.exports = {
  resolveTarget,
  binaryName,
  isSupported,
  findBinary,
  cacheDir,
  binaryUrl,
  downloadBaseUrl,
};
