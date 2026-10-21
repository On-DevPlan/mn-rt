#!/usr/bin/env node
'use strict';

/**
 * RemoteType PC 客户端 CLI 入口。
 *
 * 子命令：
 *   remotetype serve                  启动守护进程（默认对齐模式：端到端加密 + 输入框实时对齐）
 *   remotetype serve --plain          兼容旧普通模式：只接收整句明文推送（无对齐）
 *   remotetype test "文本"             本地直接测试 Rust 注入，不走公网服务
 *   remotetype auth login             统一登录（go-ah auth-hub）：免掉人工复制配对 key
 *   remotetype auth list|switch       多人共用一台电脑：查看/切换本机已存账号
 *   remotetype auth status|logout     查看/清除本机登录凭据（logout 默认只清当前账号）
 *   remotetype doctor                 环境自检（平台/二进制/权限/网络）
 *   remotetype install-driver         装 ViGEmBus 内核驱动（vpad_* 首次触发时也会自动跑）
 *   remotetype binary                 打印解析到的 Rust 二进制路径
 *
 * 全局参数：
 *   --url <ws://...>      公网服务地址
 *   --client-id <id>      本机标识（服务端据此路由）
 *   --log-level <level>   debug|info|warn|error
 *   --help / --version
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentManager } = require('../lib/agent');
const { MessageQueue } = require('../lib/queue');
const { ServeClient } = require('../lib/ws-client');
const { RtAlignSession, looksLikeEnvelope } = require('../lib/rt-align');
const { MousePump } = require('../lib/mouse');
const rtCrypto = require('../lib/rt-crypto');
const { LocalStore } = require('../lib/store');
const { Logger } = require('../lib/logger');
const { sanitize } = require('../lib/sanitize');
const { findBinary, isSupported, resolveTarget, binaryUrl, cacheDir } = require('../lib/platform');
const {
  loadConfig, parseArgs, resolveEnterMode, saveConnectionConfig, clearAuthCredentials,
  readConfigFile, placeholderUrlReason, DEFAULT_SERVE_URL,
  ensureClientId, generateClientId, saveAuthAccount, switchActiveAccount,
} = require('../lib/config');
const accountsLib = require('../lib/accounts');
const { maybeUpdateCheck } = require('../lib/update-check');
const { authLogin, getJson } = require('../lib/auth');

const pkg = require('../package.json');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

/** 打印带颜色的提示行（不走日志器，用于面向用户的交互输出）。 */
function say(msg = '') {
  process.stdout.write(`${msg}\n`);
}

function printHelp() {
  say(`
${C.bold}remotetype${C.reset} v${pkg.version} — 远程语音文字输入客户端

${C.bold}用法${C.reset}
  npx remotetype <command> [options]

${C.bold}命令${C.reset}
  ${C.cyan}(无命令)${C.reset}           显示本帮助（连接请跑 serve）
  ${C.cyan}serve${C.reset}               启动守护进程：对齐模式（端到端加密，手机输入框与电脑实时对齐，含删除）
  ${C.cyan}serve --plain${C.reset}       兼容旧普通模式：只接收整句明文推送（/push 接口、外部脚本）
  ${C.cyan}test${C.reset} "<文本>"        本地测试：直接调用注入引擎，不连公网
  ${C.cyan}auth login${C.reset}          统一登录（弹浏览器）：换回设备令牌 + 会话密钥，之后免配 key
  ${C.cyan}auth login --new-account${C.reset}  换人登录：强制认证中心重新登录（否则浏览器会话会自动授权给上一个人）
  ${C.cyan}auth list${C.reset}           列出本机已存账号（多人共用同一台电脑时各登各的）
  ${C.cyan}auth switch${C.reset} <账号>   切换当前生效账号（序号/邮箱/用户名/昵称；不带参数给选择器）
  ${C.cyan}auth status${C.reset}         查看当前身份、令牌剩余有效期、本机是否已登记
  ${C.cyan}auth logout${C.reset}         清除当前账号的登录凭据（--all 清空本机全部账号）
  ${C.cyan}doctor${C.reset}              环境自检：平台支持 / 注入二进制 / 权限 / 网络
  ${C.cyan}install-driver${C.reset}      装 ViGEmBus 内核驱动（首次 vpad_* 时也会自动触发）
  ${C.cyan}binary${C.reset}              打印解析到的注入引擎路径

${C.bold}选项${C.reset}
  --url <ws://...>       公网服务地址（默认 ${DEFAULT_SERVE_URL}）
  --client-id <id>       本机唯一标识，服务端按此路由（默认自动生成并持久化）
  --key <KEY>            手动指定配对/会话 key（统一登录下由服务端自动下发，一般不需要）
  --server-http <url>    统一登录用的 HTTP 基址（默认从 --url 推导：ws://h:p/ws → http://h:p）
  --device-name <名>     手机端「我的电脑」列表里显示的名字（默认取主机名）
  --account <账号>     serve 本次以该账号连接，不改动本机当前激活的账号
  --no-open              auth login 只打印授权地址、不弹浏览器（SSH / 无桌面环境用）
  --plain                切回旧普通模式：接收整句明文推送（无对齐、无加密）
  --align                （已默认开启，保留兼容；与 --plain 同给时 --plain 优先）
  --token <TOKEN>        注册门禁 token（服务器设 RT_TOKEN 后两端都必须携带同一值）
  --enter-mode <mode>    文本换行的注入方式：raw（默认）| enter | shift_enter。
                         微信等「Enter=发送」的输入框用 shift_enter 才能换行
  --no-save              本次连接不把 url/key/token 写入配置文件
  --log-level <level>    debug | info | warn | error（默认 info）
  --max-queue <n>        本地消息队列上限（默认 100）
  --max-text <n>         单条文本最大长度，超出截断（默认 5000）
  --agent <path>         手动指定注入引擎二进制路径
  --no-update-check      启动时不检查 npm 新版本（默认 serve 前会查一次，落后则询问是否升级）
  --help                 显示帮助
  --version              显示版本

${C.bold}示例${C.reset}
  npx remotetype auth login --url ws://1.94.101.189:8790/ws   # 统一登录，之后免配 key
  npx remotetype serve                                      # 登录过一次后直连
  npx remotetype serve --url ws://1.2.3.4:8790/ws --key MYKEY123   # 旧手动配对模式
  npx remotetype serve --plain                              # 旧普通模式（接收 /push 整句推送）
  npx remotetype test "你好，这是一条本地注入测试"
  npx remotetype doctor
`);
}

function printVersion() {
  say(`remotetype v${pkg.version} (${process.platform}-${process.arch}, node ${process.version})`);
}

/**
 * cfg.enterMode → typeText 的 opts 参数。
 * 'raw' / 缺省时不传字段，协议报文保持与旧版一致；
 * 非法值不在此拦截——rust 会拒绝并给出明确报错（宁可立即失败，不做静默回退）。
 */
function enterModeOpts(cfg) {
  return cfg.enterMode && cfg.enterMode !== 'raw' ? { enterMode: cfg.enterMode } : {};
}

/**
 * 解析注入引擎二进制路径；找不到时给出可操作的错误提示。
 * @returns {string} 二进制绝对路径
 * @throws {Error} 找不到时抛出（带友好信息）
 */
function resolveAgentPath(cfg) {
  if (cfg.agentPath) {
    if (!fs.existsSync(cfg.agentPath)) {
      throw new Error(`指定的注入引擎不存在：${cfg.agentPath}`);
    }
    return cfg.agentPath;
  }

  const found = findBinary({ extraDirs: [] });
  if (found) return found;

  const target = resolveTarget();
  const error = new Error(
    [
      `未找到适用于 ${target.key} 的注入引擎（input-agent）。`,
      '',
      '可能原因：',
      '  1) 平台分包未安装 —— 重新执行 npx 会自动拉取；',
      '  2) 处于离线环境 —— 主包只含 JS，二进制需单独获取。',
      '',
      '手动指定：remotetype serve --agent /path/to/input-agent',
      `手动放置：${path.join(cacheDir(), target.key, target.platform === 'win32' ? 'input-agent.exe' : 'input-agent')}`,
      `下载地址：${binaryUrl(target)}`,
    ].join('\n'),
  );
  error.code = 'AGENT_NOT_FOUND';
  throw error;
}

/** 检测 Linux 会话类型，返回 'x11' | 'wayland' | 'unknown'。 */
function detectLinuxSession() {
  if (process.platform !== 'linux') return null;
  const hasDisplay = Boolean(process.env.DISPLAY);
  const hasWayland = Boolean(process.env.WAYLAND_DISPLAY);
  if (hasDisplay) return 'x11';           // 含 XWayland 场景
  if (hasWayland) return 'wayland';
  return 'unknown';
}

/**
 * 平台相关的启动前提示（需求文档 6.1 / 风险清单）。
 * 不阻塞启动，只做醒目提醒。
 */
function printPlatformNotes(logger) {
  const target = resolveTarget();

  if (target.platform === 'darwin') {
    logger.warn(
      'macOS 需要手动开启辅助功能权限，否则注入会静默失败：' +
        '系统设置 → 隐私与安全性 → 辅助功能 → 勾选你的终端 / Node。',
    );
    logger.warn(
      '若二进制来自浏览器下载，可能被系统隔离。如遇「无法打开」，执行：' +
        `xattr -dr com.apple.quarantine "${path.dirname(findBinary() || '')}"`,
    );
  }

  if (target.platform === 'linux') {
    const session = detectLinuxSession();
    if (session === 'wayland') {
      logger.error(
        '检测到当前为纯 Wayland 会话（仅有 WAYLAND_DISPLAY）。' +
          '本版本注入引擎在 Wayland 下无法工作（详见文档 ENIGO_FINDINGS.md）。',
      );
      logger.error(
        '请在登录界面选择「Ubuntu on Xorg」/「GNOME on Xorg」会话后重试；' +
          '若已启用 XWayland，请确认 DISPLAY 环境变量存在。',
      );
    } else if (session === 'unknown') {
      logger.warn('未检测到 DISPLAY 环境变量；若在无图形界面环境运行，注入将失败。');
    }
  }

  if (target.platform === 'win32') {
    logger.debug(
      'Windows 下键鼠模拟可能被杀毒软件拦截；若注入失效，请将本程序加入白名单。',
    );
  }
}

// ============================ auth ============================

/**
 * 登录时的 clientId 决策：规则在 lib/accounts.js 的 planLoginClientId（纯函数、有单测），
 * 这里只负责把输入凑齐、把结果翻译成人话打出来。
 * @returns {{clientId:string, deviceName:string, retryOnOwnedByOther:boolean}}
 */
function decideLoginClientId({ view, identity, cfg, flags, prevErr }) {
  // 本机记得的该账号设备标识：登出只清凭据、不清这个，所以同一账号登回来
  // 还是原来那台"电脑"（手机端不会多出一条连不上的设备）
  const remembered = (readConfigFile().deviceIds || {})[
    accountsLib.accountKey(cfg.serverHttp, identity.userId)
  ] || null;
  const plan = accountsLib.planLoginClientId(view, identity, {
    serverHttp: cfg.serverHttp,
    machineClientId: ensureClientId(),
    explicitClientId: (flags && flags.clientId) ? cfg.clientId : null,
    rememberedClientId: remembered,
    deviceName: cfg.deviceName,
    explicitDeviceName: Boolean(flags && flags.deviceName),
    prevErr,
    generate: generateClientId,
  });
  // 决策逻辑在 lib/accounts.js（纯函数、有单测）；提示文案留在命令层
  if (plan.reason === 'retry') {
    say(`${C.yellow}! 本机默认标识在服务端已属于另一个账号${C.reset}`
      + `（服务端不允许改绑），本次为这个账号分配独立标识：${plan.clientId}`);
  } else if (plan.reason === 'remembered') {
    say(`${C.dim}沿用该账号在本机的既有标识 ${plan.clientId}（服务端那边仍是同一台设备，手机端不会多出一台）${C.reset}`);
  } else if (plan.reason === 'fresh') {
    say(`${C.dim}本机已存其他账号，本次为该账号分配独立标识 ${plan.clientId}（手机端会把它当成一台单独的电脑）${C.reset}`);
  }
  return {
    clientId: plan.clientId,
    deviceName: plan.deviceName,
    retryOnOwnedByOther: plan.retryOnOwnedByOther,
  };
}

/**
 * auth 子命令组：统一登录（认证中心 = go-ah auth-hub）+ 多账号账号簿。
 *
 *   auth login           打开浏览器完成一次授权 → 换回设备令牌 + 会话密钥并落盘
 *   auth list            列出本机已存账号（标出当前生效的那个）
 *   auth switch <账号>    切换当前生效账号——多人共用这台电脑时就是换人
 *   auth status          看当前身份、令牌还剩多久、这台机器在不在服务端登记表里
 *   auth logout          抹掉**当前账号**的凭据（--all 清空全部账号）；
 *                        服务端的设备记录保留，可被属主重新登录绑定
 *
 * ── 多账号为什么能成立 ──────────────────────────────────────────────────
 * 服务端注册表是 clientId→属主 的永久一对一，改绑一律拒绝（/auth/verify 403、
 * WS register 4403），也没有解绑途径。所以"一台电脑多账号"不能靠改绑，只能
 * **每个账号各持一个 clientId**——服务端从不拒绝新 clientId 登记为新设备。
 * 登录时先做一次身份预检（不带 clientId 换用户令牌，服务端不产生任何状态），
 * 知道是谁之后再决定沿用原标识还是领新标识。账号落在 config.json 的 accounts 表里，
 * flat 字段始终镜像当前激活账号，于是 serve/status/doctor 这些既有读路径一行都不用改。
 *
 * 与旧 `--key` 的关系：两者并存且互不覆盖。`--key` 显式传入时优先，
 * 让人能临时连一台没开统一登录的老服务器，而不必先清配置。
 */
async function cmdAuth(cfg, rest, flags = {}) {
  const action = (rest && rest[0]) || 'status';
  const target = rest && rest[1];

  if (action === 'login') {
    if (!cfg.serverHttp) {
      say(`${C.red}缺少服务端地址${C.reset}：先用 --url ws://<host>:<port>/ws 连一次，或设 REMOTETYPE_SERVER_HTTP`);
      process.exitCode = 1;
      return;
    }
    // 地址是占位/保留域名时当场说清楚，不要拿一句 getaddrinfo 去糊用户。
    // 这一条是被真实反馈逼出来的：不带 --url 直接 auth login 时，
    // 打印出来的是脚手架默认的 remotetype.example.com，报的却是裸 DNS 错。
    const badUrl = placeholderUrlReason(cfg.serverHttp) || placeholderUrlReason(cfg.url);
    if (badUrl) {
      say(`${C.red}✗ 服务端地址无效${C.reset}：${badUrl}`);
      say(`${C.dim}带上真实地址重试：npx nx-rt auth login --url ws://<服务器>:8790/ws${C.reset}`);
      process.exitCode = 1;
      return;
    }
    say(`${C.dim}服务端：${cfg.serverHttp}${C.reset}`);

    // 身份预检要用的"本机现存账号"视图；老配置的 flat 凭据在这里被合成成首个条目，
    // 所以"第二个人登录"不会把第一个人的登录态挤掉。
    const rawCfg = readConfigFile();
    const view = accountsLib.withAccounts(rawCfg, { defaultClientId: ensureClientId() });

    let res;
    try {
      res = await authLogin({
        serverHttp: cfg.serverHttp,
        clientId: cfg.clientId,
        deviceName: cfg.deviceName,
        noOpen: cfg.noOpen === true,
        promptLogin: flags.newAccount === true,
        resolveClientId: (identity, prevErr) => decideLoginClientId({
          view, identity, cfg, flags, prevErr,
        }),
        onUrl: (url) => {
          say('');
          say(`${C.yellow}请在弹出的浏览器里完成统一登录${C.reset}（未自动弹出就手动打开下面地址）`);
          if (flags.newAccount === true) {
            say(`${C.dim}已带 prompt=login：认证中心会要求重新登录账号（不支持该参数时等于普通登录）${C.reset}`);
          } else if (accountsLib.listAccounts(view).length >= 1) {
            say(`${C.dim}换个人登录：改用 npx nx-rt auth login --new-account，或把上面地址复制到无痕窗口打开（回调在本机，哪个浏览器打开都行）${C.reset}`);
          }
          say(`${C.dim}${url}${C.reset}`);
          say('');
          say(`${C.dim}等待授权回调…（5 分钟超时）${C.reset}`);
        },
      });
    } catch (e) {
      say(`${C.red}✗ 登录失败${C.reset}：${e.message}`);
      process.exitCode = 1;
      return;
    }

    // 落盘：一个账号 = 一条完整登录态（含它自己的 clientId），并激活为当前账号
    const accountEntry = {
      userId: res.userId,
      email: res.email,
      username: res.username,
      nickname: res.nickname,
      deviceToken: res.token,
      expiresAt: res.tokenExpiresAt,
      sessionKey: res.sessionKey || '',
      serverHttp: res.serverHttp,
      url: cfg.url,
      // 设备名取服务端记录里的那个：这次登录可能沿用了条目里存的名字
      // （比如 B 登录时本机还激活着 A），写 cfg.deviceName 会把 A 的名字记进 B 的条目
      deviceName: (res.device && res.device.deviceName) || res.deviceName || cfg.deviceName,
      clientId: res.clientId || cfg.clientId,
      loginAt: Date.now(),
    };
    // 登录前后是同一个账号（其实是认证中心那边还登着谁就授权给谁）：
    // 多人共用一台电脑时，这正是"我要登另一个人的账号"最容易踩空的地方
    const sameAsBefore = Boolean(view.activeAccountKey && view.activeAccountKey === accountsLib.entryKeyOf(accountEntry));
    const saved = saveAuthAccount({ entry: accountEntry, setActive: true });
    const storedCount = accountsLib.listAccounts(
      accountsLib.withAccounts(readConfigFile(), {}),
    ).length;

    say(`${C.green}✓ 登录成功${C.reset}：${accountsLib.labelOf(accountEntry)}`);
    if (accountEntry.email) say(`  邮箱    ${accountEntry.email}`);
    say(`  本机标识 ${accountEntry.clientId}    设备名 ${accountEntry.deviceName}`);
    if (res.sessionKey) {
      say(`${C.dim}会话密钥已由服务端下发（${String(res.sessionKey).slice(0, 8)}…），手机登录后会自动拿到同一把，无需再手填配对 key${C.reset}`);
    } else {
      say(`${C.yellow}! 服务端没有下发会话密钥${C.reset}：手机端仍需手填配对 key。确认服务端版本已支持统一登录`);
    }
    if (res.tokenExpiresAt) {
      const days = Math.round((res.tokenExpiresAt - Date.now()) / 86400000);
      say(`${C.dim}设备令牌有效期约 ${days} 天，过期后重新执行 npx nx-rt auth login${C.reset}`);
    }
    say(`${C.dim}已保存 → ${saved.file}${C.reset}`);
    if (sameAsBefore) {
      say(`${C.yellow}! 认证中心那边仍登录着同一个账号${C.reset}`
        + `${C.dim}（浏览器里有会话，授权是自动过的）。本意是换个人登录的话：先在浏览器里退出该账号，或换个无痕窗口重试${C.reset}`);
    }
    if (storedCount >= 2) {
      say(`${C.dim}本机已存 ${storedCount} 个账号：npx nx-rt auth list 查看，npx nx-rt auth switch <账号> 切换${C.reset}`);
    } else if (!sameAsBefore) {
      say(`${C.dim}要再登一个人：直接再执行一次 npx nx-rt auth login（两个账号并存，不必先注销）${C.reset}`);
    }
    say(`${C.green}现在直接 npx nx-rt 即可启动，手机端的「远程输入」里能看到这台电脑${C.reset}`);
    return;
  }

  // ---- auth list：本机已存账号一览 ----
  if (action === 'list') {
    const view = accountsLib.withAccounts(readConfigFile(), { defaultClientId: ensureClientId() });
    const list = accountsLib.listAccounts(view);
    if (!list.length) {
      say(`${C.yellow}本机还没有已存账号${C.reset}：先执行 npx nx-rt auth login`);
      return;
    }
    say(`${C.bold}本机已存账号${C.reset}（共 ${list.length} 个）`);
    list.forEach((a, i) => printAccountLine(i + 1, a, a.key === view.activeAccountKey));
    say(`${C.dim}切换：npx nx-rt auth switch <序号|邮箱|用户名|昵称>${C.reset}`);
    return;
  }

  // ---- auth switch：切换当前生效账号 ----
  if (action === 'switch') {
    const view = accountsLib.withAccounts(readConfigFile(), { defaultClientId: ensureClientId() });
    const list = accountsLib.listAccounts(view);
    if (!list.length) {
      say(`${C.yellow}本机还没有已存账号${C.reset}：先执行 npx nx-rt auth login`);
      process.exitCode = 1;
      return;
    }

    // 只有一个账号时没有"切换"可言：直接说清楚，不摆一个只能选 1 的选择器
    if (list.length === 1 && !target) {
      const only = list[0];
      say(`${C.dim}本机只有 1 个账号${C.reset}：${accountsLib.labelOf(only.entry)}`
        + `（clientId ${only.entry.clientId || '(无)'}）`);
      say(`${C.dim}要换别人用这台电脑：让对方执行 npx nx-rt auth login 登录他的账号，两个账号会并存，再用 auth switch 切${C.reset}`);
      return;
    }

    let picked = target;
    if (!picked) {
      // 不带参数：交互终端给编号选择器，非交互（脚本/管道）只列清单并报错——
      // 绝不在没人看着的时候猜一个账号切过去。
      if (!(process.stdin.isTTY && process.stdout.isTTY)) {
        say(`${C.yellow}未指定要切换到的账号${C.reset}。本机已存：`);
        list.forEach((a, i) => printAccountLine(i + 1, a, a.key === view.activeAccountKey));
        say(`${C.dim}用法：npx nx-rt auth switch <序号|邮箱|用户名|昵称>${C.reset}`);
        process.exitCode = 1;
        return;
      }
      try {
        picked = await pickAccountInteractively(list, view.activeAccountKey);
      } catch {
        picked = null; // Ctrl+D / 输入流关闭
      }
      if (!picked) {
        say(`${C.dim}已取消，当前账号未变${C.reset}`);
        process.exitCode = 1;
        return;
      }
    }

    let r;
    try {
      r = switchActiveAccount(picked, { defaultClientId: ensureClientId() });
    } catch (e) {
      say(`${C.red}✗ ${e.message}${C.reset}`);
      process.exitCode = 1;
      return;
    }
    if (!r.changed) {
      say(`${C.dim}当前已经就是这个账号${C.reset}：${accountsLib.labelOf(r.entry)}`);
      return;
    }
    say(`${C.green}✓ 已切换${C.reset} → ${accountsLib.labelOf(r.entry)}`);
    if (r.entry.email) say(`  邮箱    ${r.entry.email}`);
    say(`  本机标识 ${r.entry.clientId || '(无)'}    服务端 ${r.entry.serverHttp || '(未知)'}`);
    if (accountsLib.isExpired(r.entry)) {
      say(`${C.yellow}! 该账号的设备令牌已过期${C.reset}：执行 npx nx-rt auth login 重新登录它（浏览器里登这个账号）`);
    }
    say(`${C.dim}正在运行的 serve 不会自动换账号：Ctrl+C 结束它，再跑 npx nx-rt 即按新账号连接${C.reset}`);
    return;
  }

  if (action === 'logout') {
    const all = flags.all === true;
    const r = clearAuthCredentials({ all });
    if (!r.changed) {
      say(`${C.dim}本机本来就没有登录凭据${C.reset}`);
      return;
    }
    say(all
      ? `${C.green}✓ 已清除本机全部账号凭据${C.reset}（${r.file}）`
      : `${C.green}✓ 已清除当前账号的凭据${C.reset}（${r.file}）`);
    if (!all) {
      // 说清代价：登出只丢"凭据"，不丢"这台电脑的身份"——同账号重登即恢复
      say(`${C.dim}该账号在本机的设备标识仍记着：重新 npx nx-rt auth login 登录它会恢复到原来那台设备${C.reset}`);
    }
    if (r.remaining > 0) {
      say(`${C.dim}本机还剩 ${r.remaining} 个账号：npx nx-rt auth list 查看，npx nx-rt auth switch <账号> 切回某个账号${C.reset}`);
    }
    return;
  }

  if (action !== 'status') {
    say(`${C.red}未知子命令：auth ${action}${C.reset}`);
    say(`可用：login | list | switch <账号> | status | logout [--all]`);
    process.exitCode = 1;
    return;
  }

  // status —— 只读本地存的东西，不联网；联网部分失败也不影响本地结论
  const file = readConfigFile();
  const u = file.authUser || null;
  if (!file.deviceToken) {
    say(`${C.yellow}未登录${C.reset}（${file.alignKey ? '当前使用旧的手动配对 key 模式' : '也没有配对 key'}）`);
    const others = accountsLib.listAccounts(
      accountsLib.withAccounts(file, { defaultClientId: ensureClientId() }),
    );
    say(others.length > 0
      ? `${C.dim}本机还存着 ${others.length} 个账号：npx nx-rt auth switch <账号> 切回某个账号（auth list 看清单）${C.reset}`
      : `${C.dim}执行 npx nx-rt auth login 接入统一登录平台${C.reset}`);
    return;
  }
  say(`${C.bold}统一登录状态${C.reset}`);
  say(`  身份    ${u ? (u.nickname || u.username || u.email || u.userId) : '(本地令牌无身份快照)'}`);
  if (u && u.email) say(`  邮箱    ${u.email}`);
  say(`  服务端  ${file.serverHttp || cfg.serverHttp || '(未知)'}`);
  say(`  设备名  ${file.deviceName || cfg.deviceName}`);
  say(`  密钥    ${file.sessionKey ? `有（${String(file.sessionKey).slice(0, 8)}…）` : '无（手机端需手填配对 key）'}`);
  if (file.tokenExpiresAt || (u && u.expiresAt)) {
    const exp = (u && u.expiresAt) || file.tokenExpiresAt;
    const left = exp - Date.now();
    if (left <= 0) say(`  ${C.red}令牌已过期${C.reset}，请重新 npx nx-rt auth login`);
    else say(`  剩余    ${Math.floor(left / 86400000)} 天 ${Math.floor((left % 86400000) / 3600000)} 小时`);
  }
  // 多账号提示：≥2 个才提，单账号环境不必多一行噪音
  const accView = accountsLib.withAccounts(file, {});
  const accList = accountsLib.listAccounts(accView);
  if (accList.length >= 2) {
    const cur = accView.accounts[accView.activeAccountKey];
    say(`  账号    本机共 ${accList.length} 个，当前 ${cur ? accountsLib.labelOf(cur) : '(未激活)'}`
      + `（npx nx-rt auth list 查看，auth switch <账号> 切换）`);
  }

  // 向服务端验一次令牌：本地有 token 不代表服务端还认（可能已被吊销或换过 JWT_SECRET）。
  // 用 /my/devices 而不是单开的探测口——它既验令牌又顺带回答"这台机器登记上了吗"。
  const base = (file.serverHttp || cfg.serverHttp || '').replace(/\/+$/, '');
  if (base) {
    try {
      const r = await getJson(`${base}/my/devices`, { Authorization: `Bearer ${file.deviceToken}` });
      if (r.json && r.json.ok) {
        say(`  ${C.green}服务端认可此令牌${C.reset}（属主 ${r.json.userId || (r.json.devices[0] || {}).owner || ''}，名下 ${r.json.count ?? (r.json.devices || []).length} 台设备）`);
        const here = (r.json.devices || []).find((d) => d.clientId === (cfg.clientId));
        say(here
          ? `  ${C.green}✓${C.reset} 本机已在服务端登记：${here.deviceName || here.clientId}${here.online ? '（在线）' : ''}`
          : `  ${C.yellow}!${C.reset} 本机尚未登记（还没跑过 serve？）：clientId ${cfg.clientId}`);
      } else if (r.status === 401) {
        say(`  ${C.red}服务端不认此令牌${C.reset} → 重新 npx nx-rt auth login`);
        process.exitCode = 1;
      } else {
        say(`  ${C.yellow}! 服务端返回异常${C.reset}：HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
      }
    } catch (e) {
      say(`  ${C.yellow}! 无法连到服务端校验${C.reset}：${e.message}（本地凭据仍保留）`);
    }
  }
}

/** 一行账号信息：`[1] * 标签 <邮箱> — clientId — 服务端 — 剩 N 天`。 */
function printAccountLine(idx, item, isActive) {
  const e = item.entry;
  const mark = isActive ? `${C.green}*${C.reset}` : ' ';
  const left = e.expiresAt
    ? `，剩 ${Math.max(0, Math.floor((e.expiresAt - Date.now()) / 86400000))} 天`
    : '';
  say(`  ${mark} [${idx}] ${C.bold}${accountsLib.labelOf(e)}${C.reset}`
    + (e.email && e.email !== accountsLib.labelOf(e) ? ` <${e.email}>` : ''));
  say(`${C.dim}        clientId ${e.clientId || '(无)'} — ${e.serverHttp || '(未知服务端)'}${left}${C.reset}`);
}

/** 交互式编号选择器（仅 TTY）：返回用户输入的序号字符串，回车取消。 */
async function pickAccountInteractively(list, activeKey) {
  // 延迟 require：非交互路径（脚本 / CI）不必碰 readline
  const readline = require('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    list.forEach((a, i) => printAccountLine(i + 1, a, a.key === activeKey));
    for (;;) {
      const ans = String(await rl.question(`选择要切换到的账号 [1-${list.length}]（直接回车取消）：`)).trim();
      if (!ans) return null;
      if (/^\d+$/.test(ans)) {
        const n = Number.parseInt(ans, 10);
        if (n >= 1 && n <= list.length) return ans;
      }
      say(`${C.yellow}! 请输入 1-${list.length} 之间的序号${C.reset}`);
    }
  } finally {
    rl.close();
  }
}

/** --no-open 的布尔判定（parseArgs 把 --no-open 映射成 noOpen: true）。 */
function flagsTruthy(cfg) {
  return cfg.noOpen === true;
}

// ============================ serve ============================

/**
 * serve 子命令：启动守护进程。
 * 链路：Serve(WS) → 队列(串行) → AgentManager(stdio) → Rust → 系统注入
 * @param {object} cfg loadConfig 产物
 * @param {object} [flags] CLI 原始参数（--account / --key 要区分"显式传入"与"配置里的旧值"）
 */
async function cmdServe(cfg, flags = {}) {
  // --account：本次以指定账号连接（多人共用这台电脑时按人次切换），
  // 只影响本次运行，**不改动**本机当前激活的账号（那是 auth switch 的事）。
  let runAccountKey = null;
  if (flags.account !== undefined && flags.account !== null) {
    if (flags.account === true) {
      say(`${C.red}--account 需要一个账号${C.reset}：序号 / 邮箱 / 用户名 / 昵称`);
      say(`${C.dim}先看清单：npx nx-rt auth list${C.reset}`);
      process.exitCode = 1;
      return;
    }
    let picked;
    try {
      picked = accountsLib.resolveAccountEntry(readConfigFile(), flags.account, {
        defaultClientId: ensureClientId(),
      });
    } catch (e) {
      say(`${C.red}✗ ${e.message}${C.reset}`);
      process.exitCode = 1;
      return;
    }
    const e = picked.entry;
    runAccountKey = picked.key;
    const rawKey = flags.key ?? process.env.REMOTETYPE_KEY ?? null;
    const explicitKey = typeof rawKey === 'string' && rawKey ? rawKey : null;
    // 会话密钥只用这个账号自己的：显式 --key 优先，否则 entry.sessionKey。
    // 刻意**不回落**到配置里的 alignKey——那可能是本机另一个账号留下的机器级密钥，
    // 拿它配对等于跟错了人（表现为"连得上但什么都不注入"）。
    cfg.sessionKey = explicitKey || e.sessionKey || null;
    if (!explicitKey) cfg.alignKey = null;
    cfg.deviceToken = e.deviceToken;
    cfg.clientId = e.clientId || cfg.clientId;
    if (e.url) cfg.url = e.url;
    if (e.serverHttp) cfg.serverHttp = e.serverHttp;
    if (e.deviceName) cfg.deviceName = e.deviceName;
    cfg.authUser = {
      userId: e.userId,
      email: e.email,
      username: e.username,
      nickname: e.nickname,
      loginAt: e.loginAt ?? null,
      expiresAt: e.expiresAt ?? null,
    };
    say(`${C.dim}本次以账号 ${accountsLib.labelOf(e)}（clientId ${cfg.clientId}）连接；本机激活账号不变${C.reset}`);
    if (accountsLib.isExpired(e)) {
      say(`${C.yellow}! 该账号的设备令牌已过期${C.reset}：先 npx nx-rt auth login 重新登录它`);
    }
  }

  // 没给 --account 时，本次运行的账号 = 启动这一刻的激活账号，**在这里定死**。
  // 回写时若按"当前激活"重新解析，serve 跑着的时候另一个终端 auth switch 换了人，
  // 这次回写就会把本进程的运行期字段写进**别人的**条目、顺带把别人的 flat 一起改掉。
  if (!runAccountKey) {
    const rawNow = readConfigFile();
    const accNow = accountsLib.withAccounts(rawNow, { defaultClientId: ensureClientId() });
    if (rawNow.accounts && typeof rawNow.accounts === 'object'
      && Object.keys(rawNow.accounts).length > 0
      && accNow.accounts[accNow.activeAccountKey]) {
      runAccountKey = accNow.activeAccountKey;
    }
  }

  const logger = new Logger({
    level: cfg.logLevel,
    logDir: cfg.logDir,
    name: 'client',
  });

  logger.info(`${C.bold}RemoteType 客户端启动${C.reset}`, {
    version: pkg.version,
    target: cfg.target.key,
    clientId: cfg.clientId,
    url: cfg.url,
  });
  logger.info('配置', {
    logDir: cfg.logDir,
    recordFile: cfg.recordFile,
    maxQueueSize: cfg.maxQueueSize,
    maxTextLength: cfg.maxTextLength,
  });

  // 未登录、也没有配对 key：说清这次要连的是内置服务器，并给出两条路。
  // 不写成"请先用 --url 指定服务器"——内置默认值就是真部署地址，
  // 那种提示会让人以为必须带参数，而带参数的老写法恰恰不是推荐路径。
  if (!cfg.sessionKey && !cfg.deviceToken) {
    say(`${C.dim}将连接内置服务器 ${cfg.url}${C.reset}`);
    say(`${C.dim}  推荐（免配 key）：npx nx-rt auth login${C.reset}`);
    say(`${C.dim}  旧手动配对：      npx nx-rt serve --key <电脑端打印的key>${C.reset}`);
    say(`${C.dim}连上一次后参数自动保存，之后 npx nx-rt serve 直接连${C.reset}`);
  }
  // 配置里还留着 0.5.2 之前那份占位地址的设备：当场说破，别抛裸 DNS 错
  const badServeUrl = placeholderUrlReason(cfg.url);
  if (badServeUrl) {
    say(`${C.red}✗ 服务地址无效${C.reset}：${badServeUrl}`);
    say(`${C.dim}带上真实地址重试：npx nx-rt serve --url ws://<服务器>:8790/ws${C.reset}`);
    process.exitCode = 1;
    return;
  }

  printPlatformNotes(logger);

  // ---- 解析并校验注入引擎 ----
  let agentPath;
  try {
    agentPath = resolveAgentPath(cfg);
  } catch (e) {
    logger.error(e.message);
    process.exitCode = 2;
    return;
  }
  logger.info('注入引擎已就绪', { agentPath });

  const store = new LocalStore({ file: cfg.recordFile, logger });
  const agent = new AgentManager({
    binaryPath: agentPath,
    logger,
    restartDelayMs: cfg.restartDelayMs,
    heartbeatMs: cfg.heartbeatMs,
    requestTimeoutMs: cfg.requestTimeoutMs,
  });

  // 鼠标指令泵（触摸板）：绕过串行队列直通 agent，移动增量合批。
  // send 不 await——agent 对鼠标指令零延时立即应答，rejection 只记日志。
  const mousePump = new MousePump({
    send: (payload) => agent.send(payload),
    logger,
  });

  // 虚拟手柄指令泵（vpad_*）：专用串行 Promise 链直通 agent——按键
  // press/release 必须保序且不丢（丢 release = 手柄键卡死），当前控制面
  // （按钮/扳机/十字键）都是低频状态型指令，串行链足够；与文本注入的
  // 共享队列分离，互不拖延迟。轴流（摇杆 60Hz）接入时再评估合批直通。
  let vpadChain = Promise.resolve();
  // 引擎分配的句柄名未必等于手机端写的 vpad_handle：rust 端 next_index 单调
  // 自增，且 release_all 清表时计数器不复位 → 第二次 init 拿到 pad2/pad3…，
  // 而手机端把句柄写死 pad1（fr rt_page.dart 的 _vpadHandle，依赖「release_all
  // → init 必得 pad1」这条契约）。结果是 init 成功、后续按钮/十字键全撞
  // "unknown handle: pad1"。这里记住 init 应答里的真实句柄，后续命令一律
  // 重写到它；release 成功后清空，下次 init 重新学。
  let vpadHandle = null;
  const dispatchVpad = (cmd, seq) => {
    vpadChain = vpadChain.then(async () => {
      try {
        const payload = vpadHandle && cmd.vpad_handle
          ? { ...cmd, vpad_handle: vpadHandle }
          : cmd;
        const res = await agent.send(payload);
        if (res?.ok) {
          if (cmd.action === 'vpad_init' && res.handle) vpadHandle = res.handle;
          if (cmd.action === 'vpad_release' || cmd.action === 'vpad_release_all') {
            vpadHandle = null;
          }
          // vpad 全链路成功时此前零 console 输出（store 只落盘不打印），
          // 排障时无法区分「没收到」和「收到了但静默」。init / release 是
          // 一次性节点走 info（「手柄已插上/拔下」一眼可见）；按键/轴/扳机
          // 高频走 debug，避免游戏时刷屏。
          const log = (cmd.action === 'vpad_init' || cmd.action === 'vpad_release')
            ? 'info' : 'debug';
          logger[log]('vpad 指令成功', { action: cmd.action, msg: res?.msg, seq });
          store.append({ status: 'vpad_sent', action: cmd.action, source: 'align', seq });
        } else {
          logger.warn('vpad 指令失败', { action: cmd.action, msg: res?.msg, seq });
          store.append({ status: 'vpad_failed', action: cmd.action, errorMsg: res?.msg ?? 'unknown', source: 'align', seq });
        }
      } catch (e) {
        logger.warn('vpad 指令异常', { action: cmd.action, error: e.message, seq });
        store.append({ status: 'vpad_failed', action: cmd.action, errorMsg: e.message, source: 'align', seq });
      }
    });
  };

  // 对齐模式会话（可选）；serve 在其后创建，sendAck 闭包引用
  let align = null;
  let serve;
  // 本批按键计划中注入失败过的 seq：commit 到来时走 commitFailed
  // （mirror 不推进、重试），而不是 commitApplied（误以为已注入 → 永久错位）
  const failedAlignSeqs = new Set();

  // ---- 消息队列：串行消费，逐条注入 ----
  // serve 明文模式 item = {text, clientId}；对齐模式 item =
  //   {op:'type', text, seq} | {op:'backspace', count, seq}
  //   | {op:'hotkey', key, modifiers, seq} | {op:'commit', seq, text}
  const queue = new MessageQueue({
    maxSize: cfg.maxQueueSize,
    logger,
    handler: async (item, meta) => {
      const enqueuedAt = meta.enqueuedAt ?? Date.now();
      const queueWaitMs = Date.now() - enqueuedAt;
      const startedAt = Date.now();

      // commit：本批按键计划完成，推进 mirror 并回 ACK（无注入动作）
      if (item.op === 'commit') {
        if (failedAlignSeqs.has(item.seq)) {
          failedAlignSeqs.delete(item.seq);
          align?.commitFailed(item.seq);
        } else {
          align?.commitApplied(item.seq, item.text);
        }
        return;
      }

      // hotkey：快捷键指令（对齐模式 v0.5.4+）。
      // 无 mirror 推进语义：成功与否都不影响后续快照 diff，失败不重试
      //（快捷键可能已实际触发，重发有误触风险，宁少勿多）。
      if (item.op === 'hotkey') {
        const combo = [...(item.modifiers ?? []), item.key].join('+');
        try {
          const res = await agent.hotkey(item.key, item.modifiers ?? []);
          if (res?.ok) {
            logger.info('快捷键完成', { combo, queueWaitMs });
            store.append({ status: 'hotkey_sent', combo, source: meta.source, seq: item.seq });
          } else {
            logger.error('快捷键失败', { combo, msg: res?.msg });
            store.append({ status: 'hotkey_failed', combo, errorMsg: res?.msg ?? 'unknown', source: meta.source, seq: item.seq });
          }
        } catch (e) {
          logger.error('快捷键异常', { combo, error: e.message });
          store.append({ status: 'hotkey_failed', combo, errorMsg: e.message, source: meta.source, seq: item.seq });
        }
        return;
      }

      // backspace：删除原语（relay 对齐模式）
      if (item.op === 'backspace') {
        try {
          const res = await agent.backspace(item.count);
          if (res?.ok) {
            logger.debug('退格完成', { count: item.count, queueWaitMs });
            store.append({ status: 'backspaced', count: item.count, source: meta.source, seq: item.seq });
          } else {
            logger.error('退格失败', { count: item.count, msg: res?.msg });
            if (item.seq !== undefined) failedAlignSeqs.add(item.seq);
            store.append({ status: 'backspace_failed', count: item.count, errorMsg: res?.msg ?? 'unknown', source: meta.source, seq: item.seq });
          }
        } catch (e) {
          logger.error('退格异常', { count: item.count, error: e.message });
          if (item.seq !== undefined) failedAlignSeqs.add(item.seq);
          store.append({ status: 'backspace_failed', count: item.count, errorMsg: e.message, source: meta.source, seq: item.seq });
        }
        return;
      }

      // type：常规文本注入（serve 与 relay 共用，relay 的 text 是 diff 出的增量）
      // 二次预处理：即便上游已过滤，这里仍是最后一道防线。
      // 对齐模式保留纯空白：换行/空格是手机输入框的真实内容（IME 自动插入的
      // 换行不该被判失败挂起整批计划），见 sanitize 的 keepWhitespace。
      const isAlignSource = meta.source === 'align';
      const cleaned = sanitize(item.text, {
        maxLength: cfg.maxTextLength,
        keepWhitespace: isAlignSource,
      });
      if (!cleaned.ok) {
        logger.warn('文本预处理后丢弃', { reason: cleaned.reason, clientId: item.clientId });
        if (meta.source === 'align' && item.seq !== undefined) failedAlignSeqs.add(item.seq);
        store.append({
          text: item.text,
          status: 'dropped',
          errorMsg: cleaned.reason,
          clientId: item.clientId,
          source: meta.source,
          queueWaitMs,
        });
        return;
      }
      if (isAlignSource && cleaned.text.length === 0) {
        // 整条只含不可见字符：无可注入内容，也不算失败——commit 仍会推进 mirror
        logger.debug('对齐空操作（仅不可见字符），跳过注入', { seq: item.seq });
        return;
      }
      if (cleaned.truncated) {
        logger.warn('文本超长已截断', {
          originalLength: cleaned.originalLength,
          maxLength: cfg.maxTextLength,
        });
      }

      logger.info('开始注入', {
        textLen: cleaned.text.length,
        queueWaitMs,
        clientId: item.clientId,
        source: meta.source,
        preview: cleaned.text.slice(0, 40),
      });

      try {
        // 换行方式：手机快照字段优先，CLI --enter-mode 兜底（对齐模式 item.enterMode 才有值）
        const opts = enterModeOpts({ enterMode: resolveEnterMode(item.enterMode, cfg.enterMode) });
        const res = await agent.typeText(cleaned.text, undefined, null, opts);
        const durationMs = Date.now() - startedAt;
        if (res?.ok) {
          logger.info('注入完成', { durationMs, textLen: cleaned.text.length });
          store.append({
            text: cleaned.text,
            status: 'injected',
            clientId: item.clientId,
            source: meta.source,
            queueWaitMs,
            durationMs,
            truncated: Boolean(cleaned.truncated),
          });
        } else {
          logger.error('注入失败', { msg: res?.msg, durationMs });
          if (meta.source === 'align' && item.seq !== undefined) failedAlignSeqs.add(item.seq);
          store.append({
            text: cleaned.text,
            status: 'inject_failed',
            errorMsg: res?.msg ?? 'unknown',
            clientId: item.clientId,
            source: meta.source,
            queueWaitMs,
            durationMs,
          });
        }
      } catch (e) {
        const durationMs = Date.now() - startedAt;
        logger.error('注入异常', { error: e.message, durationMs });
        if (meta.source === 'align' && item.seq !== undefined) failedAlignSeqs.add(item.seq);
        store.append({
          text: cleaned.text,
          status: 'inject_failed',
          errorMsg: e.message,
          clientId: item.clientId,
          source: meta.source,
          queueWaitMs,
          durationMs,
        });
      }
    },
  });

  // ---- 拉起子进程 ----
  try {
    agent.start();
  } catch (e) {
    logger.error('注入引擎启动失败', { error: e.message });
    process.exitCode = 3;
    return;
  }

  // ---- 对齐模式（可选）：密文信封 → 按键计划 → ACK ----
  if (cfg.align) {
    // 密钥来源优先级：显式 --key / 统一登录存下的 sessionKey > 老的 alignKey > 临时自生成。
    // 走统一登录时这把 key 由服务端按属主下发，手机端登录同一账号会自动拿到同一把，
    // 两端不再有任何人工复制。
    const key = cfg.sessionKey || cfg.alignKey || rtCrypto.generateKey();
    const keyIsGenerated = !(cfg.sessionKey || cfg.alignKey);
    align = new RtAlignSession({
      key,
      logger,
      sendAck: (envelope) => serve.send({ type: 'ack', phoneId: align.phoneId, ack: envelope }),
    });

    if (keyIsGenerated) {
      say('');
      say(`${C.bold}${C.green}  ┌──────────────────────────────────────────┐${C.reset}`);
      say(`${C.bold}${C.green}  │  配对 key（输入到 fr「远程输入」demo）：  │${C.reset}`);
      say(`${C.bold}${C.green}  │                                          │${C.reset}`);
      say(`${C.bold}${C.green}  │            ${key}            │${C.reset}`);
      say(`${C.bold}${C.green}  └──────────────────────────────────────────┘${C.reset}`);
      say(`${C.dim}  key 即凭据：泄漏 = 任何人可向本机注入文本。勿外传。${C.reset}`);
      say(`${C.dim}  想免掉这一步：npx nx-rt auth login 接入统一登录平台${C.reset}`);
      say('');
    } else if (cfg.deviceToken) {
      logger.info('对齐密钥来自统一登录（服务端下发），手机端登录同一账号即可直连');
    }

    align.on('decrypt-error', ({ seq }) => {
      logger.error('解密失败：两端 key 不一致？', { seq });
    });
    align.on('op', (op) => {
      // 鼠标事件（v0.6.0+ 触摸板）：高频、可丢可合并——绝不进串行队列，
      // 否则会被文本/组合键的注入延时拖出可见卡顿（见 lib/mouse.js 头注释）。
      if (op.op === 'mouse') {
        mousePump.dispatch(op.mouse);
        return;
      }
      // 虚拟手柄指令（v0.7.0+）：专用串行链，保序不丢，不进文本共享队列。
      if (op.op === 'vpad') {
        dispatchVpad(op.cmd, op.seq);
        return;
      }
      const accepted = queue.push(op, { source: 'align', enqueuedAt: Date.now() });
      if (!accepted) {
        logger.warn('队列溢出，丢弃计划', { op: op.op, seq: op.seq });
        store.append({ status: 'dropped', errorMsg: 'queue_overflow', source: 'align', seq: op.seq });
      }
    });
  }

  // ---- 连接公网服务（明文 / 对齐两种模式共用 ServeClient）----
  serve = new ServeClient({
    url: cfg.url,
    clientId: cfg.clientId,
    token: cfg.token,
    deviceToken: cfg.deviceToken,
    deviceName: cfg.deviceName,
    sessionKey: cfg.sessionKey,
    logger,
  });

  serve.on('connected', () => {
    logger.info(
      align
        ? `${C.green}已连接公网服务（对齐模式），等待手机配对…${C.reset}`
        : `${C.green}已连接公网服务，等待远程文本…${C.reset}`,
      { clientId: cfg.clientId },
    );
  });
  serve.on('reconnecting', ({ delayMs, attempt }) => {
    logger.warn(`连接断开，${delayMs}ms 后重连`, { attempt });
  });
  serve.on('disconnected', ({ code, reason }) => {
    logger.warn('与服务端连接已断开', { code, reason });
  });
  serve.on('registered', (msg) => {
    logger.info('服务端已登记本机', {
      clientId: msg.clientId, role: msg.role, owner: msg.device && msg.device.owner,
    });
    // 连通即保存：本次成功连接的 url/key/token 成为下次默认（--no-save 跳过）。
    // accountKey 让回写落到"本次运行的那个账号"条目上：是激活账号就顺带打平 flat，
    // 是 --account 借用的别人账号就只写它自己的条目，不动 flat 的镜像关系。
    if (!cfg.noSave) {
      let saved = { changed: false };
      try {
        saved = saveConnectionConfig({
          url: cfg.url,
          alignKey: cfg.alignKey,
          token: cfg.token,
          deviceToken: cfg.deviceToken,
          sessionKey: serve.sessionKey || cfg.sessionKey,
          deviceName: cfg.deviceName,
          serverHttp: cfg.serverHttp,
        }, { accountKey: runAccountKey });
      } catch (e) {
        // 连接已经通了：配置里这次没记住不该让 serve 倒下（下次成功连接还会再存一遍）
        logger.warn('连接配置保存失败（不影响本次连接）', { error: e.message });
      }
      if (saved.changed) {
        say(`${C.dim}已保存连接配置 → ${saved.file}${C.reset}`);
        say(`${C.dim}下次直接 npx nx-rt 即可用同样参数连接${C.reset}`);
      }
    }
  });

  // 服务端下发的权威会话密钥：热切 align 会话，不让用户为重连一次而重启进程
  serve.on('session-key', (key) => {
    const swapped = align ? align.setKey(key) : false;
    logger.info('采纳服务端下发的会话密钥', { appliedToAlign: swapped, preview: String(key).slice(0, 8) });
    if (!cfg.noSave) {
      try {
        saveConnectionConfig({ sessionKey: key }, { accountKey: runAccountKey });
      } catch (e) {
        logger.warn('会话密钥保存失败（不影响本次连接）', { error: e.message });
      }
    }
  });

  serve.on('text', (msg) => {
    if (align) {
      // 对齐模式：只接受 RT1 加密信封；明文一律拒绝（防旁路注入）
      const outcome = align.handleIncoming(msg.text);
      if (outcome === 'plaintext') {
        store.append({
          text: String(msg.text ?? '').slice(0, 200),
          status: 'plaintext_rejected',
          clientId: msg.clientId,
          source: 'align',
        });
      }
      return;
    }
    logger.info('收到远程文本', { textLen: msg.text.length, clientId: msg.clientId });
    const accepted = queue.push(
      { text: msg.text, clientId: msg.clientId },
      { source: 'serve', enqueuedAt: Date.now() },
    );
    if (!accepted) {
      store.append({
        text: msg.text,
        status: 'dropped',
        errorMsg: 'queue_overflow',
        clientId: msg.clientId,
        source: 'serve',
      });
    }
  });

  // 注册门禁拒绝：4403 = 老的 RT_TOKEN 不匹配；4401 = 统一登录凭据缺失/过期。
  // 两者都需要人工介入，重连无意义，直接退出。
  serve.on('auth-rejected', ({ code }) => {
    if (code === 4401) {
      logger.error(runAccountKey
        ? '服务端要求统一登录：本次 --account 指定账号的令牌缺失或已过期，请重新 npx nx-rt auth login 登录该账号'
        : '服务端要求统一登录：执行 npx nx-rt auth login（令牌过期同理）');
    } else {
      logger.error('token 无效或缺失：请核对 --token / REMOTETYPE_TOKEN 与服务器 RT_TOKEN 是否一致');
    }
    shutdown('auth-rejected', 1);
  });

  serve.connect();

  // ---- 状态摘要（每 60s 打印一次，便于长期运行观测） ----
  const summary = setInterval(() => {
    logger.info('运行状态', {
      queueDepth: queue.depth,
      queue: queue.stats,
      agent: agent.stats,
      serve: serve ? serve.stats : null,
      align: align ? align.stats : null,
      mouse: mousePump.stats,
      store: store.stats(),
    });
  }, 60000);
  summary.unref?.();

  // ---- 优雅退出 ----
  let shuttingDown = false;
  const shutdown = async (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(summary);
    logger.info(`收到 ${signal}，开始优雅退出`);
    queue.pause();
    align?.dispose();
    mousePump.stop();
    serve?.close();
    // 给队列里剩余消息一点时间跑完
    const drained = await queue.waitIdle(8000);
    if (!drained) logger.warn('队列未在超时内消费完毕，剩余消息将被丢弃', { depth: queue.depth });
    await agent.stop();
    logger.info('已退出', { queue: queue.stats, agent: agent.stats, store: store.stats() });
    logger.close();
    process.exit(code);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 保持进程存活
  await new Promise(() => {});
}

// ============================ test ============================

/**
 * test 子命令：不连公网，直接本地注入，用于快速验证环境。
 * 退出码：0 成功；4 注入失败；2 找不到二进制。
 */
async function cmdTest(cfg, positional) {
  const logger = new Logger({ level: cfg.logLevel, logDir: null, name: 'client' });

  const raw = positional.join(' ');
  if (!raw) {
    say(`${C.red}错误：请提供要注入的文本${C.reset}`);
    say(`示例：npx remotetype test "你好，这是一条本地注入测试"`);
    process.exitCode = 1;
    return;
  }

  const cleaned = sanitize(raw, { maxLength: cfg.maxTextLength });
  if (!cleaned.ok) {
    say(`${C.red}文本预处理后为空（${cleaned.reason}），已丢弃${C.reset}`);
    process.exitCode = 1;
    return;
  }
  if (cleaned.truncated) {
    logger.warn('文本超长已截断', { originalLength: cleaned.originalLength, maxLength: cfg.maxTextLength });
  }

  let agentPath;
  try {
    agentPath = resolveAgentPath(cfg);
  } catch (e) {
    // 复用统一提示（--agent 指定错误时同样走这里）
    throw e;
  }

  say(`${C.dim}注入引擎：${agentPath}${C.reset}`);
  say(`${C.dim}将注入 ${Array.from(cleaned.text).length} 个字符到当前焦点窗口…${C.reset}`);

  printPlatformNotes(logger);

  const agent = new AgentManager({
    binaryPath: agentPath,
    logger,
    restartDelayMs: cfg.restartDelayMs,
    heartbeatMs: 0,       // 单次测试不需要心跳
    requestTimeoutMs: cfg.requestTimeoutMs,
  });

  try {
    agent.start();
    const startedAt = Date.now();
    const res = await agent.typeText(cleaned.text, undefined, null, enterModeOpts(cfg));
    const durationMs = Date.now() - startedAt;

    if (res?.ok) {
      say(`${C.green}✓ 注入成功${C.reset}（${durationMs}ms）`);
      say(`${C.dim}请确认当前焦点输入框中已出现文字；若没有，请检查辅助功能权限或会话类型。${C.reset}`);
    } else {
      say(`${C.red}✗ 注入失败${C.reset}：${res?.msg ?? 'unknown'}（${durationMs}ms）`);
      process.exitCode = 4;
    }
  } catch (e) {
    say(`${C.red}✗ 注入异常${C.reset}：${e.message}`);
    process.exitCode = 4;
  } finally {
    await agent.stop();
  }
}

// =========================== doctor ===========================

/** doctor 子命令：环境自检，逐项给出结论与建议。 */
async function cmdDoctor(cfg) {
  const lines = [];
  const ok = (m) => lines.push(`${C.green}✓${C.reset} ${m}`);
  const bad = (m) => lines.push(`${C.red}✗${C.reset} ${m}`);
  const warn = (m) => lines.push(`${C.yellow}!${C.reset} ${m}`);
  const info = (m) => lines.push(`  ${C.dim}${m}${C.reset}`);

  say(`\n${C.bold}RemoteType 环境自检${C.reset}\n`);

  // 1) 运行时
  ok(`操作系统：${process.platform} ${os.release()} (${process.arch})`);
  ok(`Node.js：${process.version}`);
  if (Number.parseInt(process.versions.node, 10) >= 18) {
    ok('Node 版本满足要求（>= 18）');
  } else {
    bad('Node 版本过低，需要 >= 18');
  }

  // 2) 平台支持
  const target = resolveTarget();
  if (isSupported()) {
    ok(`目标平台 ${target.key} 受支持`);
  } else {
    bad(`目标平台 ${target.key} 不在支持列表内`);
  }

  // 3) Linux 会话类型
  if (process.platform === 'linux') {
    const session = detectLinuxSession();
    if (session === 'x11') {
      ok(`图形会话：X11（DISPLAY=${process.env.DISPLAY}）`);
    } else if (session === 'wayland') {
      bad('图形会话：纯 Wayland —— 注入引擎不支持（请改用 Xorg 会话）');
      info('详见项目文档 ENIGO_FINDINGS.md');
    } else {
      warn('未检测到 DISPLAY / WAYLAND_DISPLAY，可能无图形环境');
    }
  }

  // 4) 注入引擎
  try {
    const agentPath = resolveAgentPath(cfg);
    const st = fs.statSync(agentPath);
    ok(`注入引擎：${agentPath}`);
    info(`大小 ${(st.size / 1024 / 1024).toFixed(2)} MB`);
    if (process.platform !== 'win32' && !(st.mode & 0o111)) {
      warn('二进制缺少可执行权限，启动时会自动 chmod 修复');
    }

    // 5) 实机注入测试（ping + 可选的空跑）
    const logger = new Logger({ level: 'error', logDir: null, name: 'doctor' });
    const agent = new AgentManager({
      binaryPath: agentPath,
      logger,
      heartbeatMs: 0,
      requestTimeoutMs: 8000,
      maxRestarts: 1,
    });
    try {
      agent.start();
      const res = await agent.send({ action: 'ping' }, 8000);
      if (res?.ok) {
        ok('注入引擎通信正常（stdio IPC 应答 pong）');
      } else {
        bad(`注入引擎应答异常：${JSON.stringify(res)}`);
      }
    } catch (e) {
      bad(`注入引擎无法通信：${e.message}`);
      if (process.platform === 'darwin') {
        info('macOS 请检查：系统设置 → 隐私与安全性 → 辅助功能');
      }
      if (process.platform === 'linux') {
        info('Linux 请确认在 X11 会话下运行，且 DISPLAY 正确');
      }
    } finally {
      await agent.stop();
    }
  } catch (e) {
    bad(e.message);
  }

  // 6) 网络连通性（仅解析地址，不强制连接）
  try {
    const u = new URL(cfg.url);
    ok(`服务地址：${cfg.url}`);
    info(`协议 ${u.protocol.replace(':', '')} / 主机 ${u.host}`);
    if (u.protocol === 'wss:') {
      info('使用 TLS 加密传输');
    } else {
      warn('使用明文 ws:// 传输，公网环境建议改用 wss://');
    }
  } catch {
    bad(`服务地址格式不合法：${cfg.url}`);
  }

  // 7) 数据目录可写性
  for (const [label, p] of [['日志目录', cfg.logDir], ['记录文件', cfg.recordFile]]) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.accessSync(path.dirname(p), fs.constants.W_OK);
      ok(`${label}可写：${p}`);
    } catch (e) {
      bad(`${label}不可写：${p}（${e.message}）`);
    }
  }

  ok(`本机标识 clientId：${cfg.clientId}`);

  say(lines.join('\n'));
  say(`\n${C.dim}提示：doctor 只做自检，不会真正向焦点窗口输入文字。${C.reset}`);
  say(`${C.dim}要实测注入，请运行：npx remotetype test "测试文本"${C.reset}\n`);
}

// =========================== binary ===========================

function cmdBinary(cfg) {
  try {
    const agentPath = resolveAgentPath(cfg);
    say(agentPath);
  } catch (e) {
    say(`${C.red}${e.message}${C.reset}`);
    process.exitCode = 2;
  }
}

// ============================ install-driver ============================
// 仅 Windows：有 vpad_* 指令时若 ViGEmBus 驱动缺失，会自动跑这个脚本，
// 弹一次 UAC。提前手动跑也行：npx remotetype install-driver [--check]。
const VIGEMBUS_SYS = path.join(
  process.env.windir || 'C:\\Windows',
  'System32', 'drivers', 'ViGEmBus.sys',
);
/** npm 内的 install-vigembus.ps1 路径（dev 布局也能兜住）。 */
function findInstallVigembusScript() {
  const candidates = [
    // 装在 node_modules/nx-rt/ 下（npm 全局或 npx 缓存）
    path.join(__dirname, '..', 'scripts', 'install-vigembus.ps1'),
    // 装在 <repo>/node_modules/nx-rt/ 下（项目内本地 install）
    path.join(process.cwd(), 'node_modules', 'nx-rt', 'scripts', 'install-vigembus.ps1'),
    // 兜底：v0.7.2 之前的脚本留在仓库根目录（dev 安装）
    path.join(__dirname, '..', '..', 'scripts', 'install-vigembus.ps1'),
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 不存在跳 */ }
  }
  return null;
}

/** 包内脚本不存在时给出清晰定位提示。 */
function cmdInstallDriverMissingScript() {
  say(`${C.red}✗ 找不到 install-vigembus.ps1${C.reset}`);
  say(`  安装包未自带脚本（nx-rt@0.7.0 / 0.7.1 / 0.7.1 之前）；0.7.2 起内置。`);
  say(`  若你用的是本地 dev 安装，可手动跑：`);
  say(`    ${C.cyan}pwsh -ExecutionPolicy Bypass -File scripts/install-vigembus.ps1${C.reset}`);
  say(`  或去 ${C.underline}https://github.com/ViGEm/ViGEmBus/releases/latest${C.reset} 下载安装包（exe /quiet /norestart）自装。`);
  process.exitCode = 2;
}

async function cmdInstallDriver(cfg, flags = {}) {
  const script = findInstallVigembusScript();
  const present = (() => { try { return fs.statSync(VIGEMBUS_SYS).isFile(); } catch { return false; } })();

  // --check：只查不装
  if (flags.check) {
    if (present) {
      say(`${C.green}✓ ViGEmBus 驱动已安装${C.reset}（${VIGEMBUS_SYS}）`);
    } else {
      say(`${C.yellow}! ViGEmBus 驱动未安装${C.reset}`);
      say(`  跑 \`npx remotetype install-driver\` 一键装；vpad_* 首次使用时也会自动触发。`);
      process.exitCode = 1;
    }
    return;
  }

  if (!script) {
    cmdInstallDriverMissingScript();
    return;
  }

  if (present) {
    say(`${C.green}✓ ViGEmBus 驱动已安装${C.reset}（${VIGEMBUS_SYS}）— 跳过安装`);
    return;
  }

  say(`${C.yellow}! ViGEmBus 驱动未安装${C.reset}`);
  say(`  即将弹 UAC 提升安装 ${path.basename(script)}（脚本会装驱动 + 启服务）…`);
  say(`  ${C.dim}提示：UAC 点"否"或超时则保持未装状态；过期不会多次弹${C.reset}`);

  // 用 PowerShell Start-Process -Verb RunAs 提权子进程。
  // 子进程退出码约定（install-vigembus.ps1）：
  //   0=装好  1=装完服务未起  2=下载/安装器失败  3=非 admin
  // 提权本身失败（用户拒 UAC / 取消）由本层用 98 表达。
  //
  // ⚠️ 不要再加 -NoNewWindow：它与 -Verb RunAs 是互斥参数集
  //（Start-Process 报 AmbiguousParameterSet），且该错误一旦被
  // -ErrorAction SilentlyContinue 吞掉，安装压根没执行、退出码退化成 99，
  // 表现为「UAC 被拒」——实际是根本没弹 UAC。提权只能新开控制台。
  const { execFile } = require('child_process');
  const psCmd = [
    '$ErrorActionPreference = \'Stop\';',
    'try {',
    `  $p = Start-Process -Verb RunAs -FilePath powershell.exe ` +
    `    -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}' ` +
    '    -Wait -PassThru -ErrorAction Stop;',
    '  exit [int]$p.ExitCode;',
    '} catch {',
    // 注意：这里不能用 Write-Error —— $ErrorActionPreference='Stop' 会让
    // catch 里的 Write-Error 本身变成终止性错误，脚本当场以 1 退出，
    // 永远走不到下面的 exit 98（提权失败会被误报成「服务未起」）。
    // [Console]::Error.WriteLine 直写 stderr，不经过 PowerShell 错误机制。
    "  [Console]::Error.WriteLine('elevation failed: ' + $_.Exception.Message);",
    '  exit 98;',
    '}',
  ].join(' ');

  let exitCode = 0;
  await new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
      { stdio: 'inherit' },
      (err) => {
        // 非零退出时 err.code 就是子进程退出码（正常退出时是数字）。
        // err.code 为字符串（ENOENT 之类）时按 99 兜底。
        exitCode = err
          ? (typeof err.code === 'number' ? err.code : 99)
          : 0;
        resolve();
      },
    );
  });

  // 复检（权威判定：驱动文件在不在，而不是脚本报的什么）
  const after = (() => { try { return fs.statSync(VIGEMBUS_SYS).isFile(); } catch { return false; } })();
  if (after) {
    say(`${C.green}✓ ViGEmBus 驱动安装成功${C.reset}（${VIGEMBUS_SYS}）`);
    if (exitCode === 1) {
      say(`${C.yellow}! 驱动文件已就位但服务未启动${C.reset}——重启后自愈，或手动：`);
      say(`    ${C.cyan}sc start ViGEmBus${C.reset}`);
    }
  } else {
    say(`${C.red}✗ ViGEmBus 安装未生效${C.reset}（退出码 ${exitCode}）`);
    const reasons = {
      98: '提权失败：UAC 被拒绝或已取消',
      2: '安装器下载或执行失败（网络 / 哈希校验 / 安装器本身报错）',
      3: '当前不是管理员，无法安装内核驱动',
      1: '脚本退出码 1：驱动文件已装但服务未启动（也可能是脚本自身报错，见上方输出）',
    };
    if (reasons[exitCode]) say(`  原因：${reasons[exitCode]}`);
    else say('  原因：未知（详见上方脚本输出）');
    say(`  手动跑：${C.cyan}pwsh -ExecutionPolicy Bypass -File '${script}'${C.reset}`);
    process.exitCode = 2;
  }
}

// ============================ main ============================

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  const rest = positional.slice(1);

  if (flags.version || command === 'version') return printVersion();
  if (flags.help && !command) return printHelp();
  if (!command) {
    // 裸命令 = 显示帮助（0.7.6 起不再隐式 serve；连接请显式跑 npx nx-rt serve）
    return printHelp();
  }

  const cfg = loadConfig(flags);

  switch (command) {
    case 'serve':
      if (await maybeUpdateCheck({ flags, argv })) return undefined;
      return cmdServe(cfg, flags);
    case 'test':
      return cmdTest(cfg, rest);
    case 'doctor':
      return cmdDoctor(cfg);
    case 'install-driver':
      return cmdInstallDriver(cfg, flags);
    case 'auth':
      return cmdAuth(cfg, rest, flags);
    case 'binary':
      return cmdBinary(cfg);
    case 'help':
      return printHelp();
    default:
      say(`${C.red}未知命令：${command}${C.reset}\n`);
      printHelp();
      process.exitCode = 1;
      return undefined;
  }
}

main().catch((e) => {
  process.stderr.write(`${C.red}致命错误：${e.message}${C.reset}\n`);
  if (process.env.REMOTETYPE_DEBUG) process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
