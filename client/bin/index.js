#!/usr/bin/env node
'use strict';

/**
 * RemoteType PC 客户端 CLI 入口。
 *
 * 子命令：
 *   remotetype serve                  启动守护进程（默认对齐模式：端到端加密 + 输入框实时对齐）
 *   remotetype serve --plain          兼容旧普通模式：只接收整句明文推送（无对齐）
 *   remotetype test "文本"             本地直接测试 Rust 注入，不走公网服务
 *   remotetype doctor                 环境自检（平台/二进制/权限/网络）
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
const rtCrypto = require('../lib/rt-crypto');
const { LocalStore } = require('../lib/store');
const { Logger } = require('../lib/logger');
const { sanitize } = require('../lib/sanitize');
const { findBinary, isSupported, resolveTarget, binaryUrl, cacheDir } = require('../lib/platform');
const { loadConfig, parseArgs, resolveEnterMode } = require('../lib/config');

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
  ${C.cyan}serve${C.reset}               启动守护进程：对齐模式（端到端加密，手机输入框与电脑实时对齐，含删除）
  ${C.cyan}serve --plain${C.reset}       兼容旧普通模式：只接收整句明文推送（/push 接口、外部脚本）
  ${C.cyan}test${C.reset} "<文本>"        本地测试：直接调用注入引擎，不连公网
  ${C.cyan}doctor${C.reset}              环境自检：平台支持 / 注入二进制 / 权限 / 网络
  ${C.cyan}binary${C.reset}              打印解析到的注入引擎路径

${C.bold}选项${C.reset}
  --url <ws://...>       公网服务地址（默认 ${require('../lib/config').DEFAULT_SERVE_URL}）
  --client-id <id>       本机唯一标识，服务端按此路由（默认自动生成并持久化）
  --key <KEY>            对齐模式配对 key（不传则自动生成强随机并打印；手机端输入同一 key）
  --plain                切回旧普通模式：接收整句明文推送（无对齐、无加密）
  --align                （已默认开启，保留兼容；与 --plain 同给时 --plain 优先）
  --token <TOKEN>        注册门禁 token（服务器设 RT_TOKEN 后两端都必须携带同一值）
  --enter-mode <mode>    文本换行的注入方式：raw（默认）| enter | shift_enter。
                         微信等「Enter=发送」的输入框用 shift_enter 才能换行
  --log-level <level>    debug | info | warn | error（默认 info）
  --max-queue <n>        本地消息队列上限（默认 100）
  --max-text <n>         单条文本最大长度，超出截断（默认 5000）
  --agent <path>         手动指定注入引擎二进制路径
  --help                 显示帮助
  --version              显示版本

${C.bold}示例${C.reset}
  npx remotetype serve --url ws://1.2.3.4:8790/ws   # 对齐模式，自动生成 key，复制到手机
  npx remotetype serve --key MYKEY123               # 两端用同一个 key
  npx remotetype serve --plain                      # 旧普通模式（接收 /push 整句推送）
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

// ============================ serve ============================

/**
 * serve 子命令：启动守护进程。
 * 链路：Serve(WS) → 队列(串行) → AgentManager(stdio) → Rust → 系统注入
 */
async function cmdServe(cfg) {
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

  // 对齐模式会话（可选）；serve 在其后创建，sendAck 闭包引用
  let align = null;
  let serve;
  // 本批按键计划中注入失败过的 seq：commit 到来时走 commitFailed
  // （mirror 不推进、重试），而不是 commitApplied（误以为已注入 → 永久错位）
  const failedAlignSeqs = new Set();

  // ---- 消息队列：串行消费，逐条注入 ----
  // serve 明文模式 item = {text, clientId}；对齐模式 item =
  //   {op:'type', text, seq} | {op:'backspace', count, seq} | {op:'commit', seq, text}
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
    const key = cfg.alignKey || rtCrypto.generateKey();
    align = new RtAlignSession({
      key,
      logger,
      sendAck: (envelope) => serve.send({ type: 'ack', phoneId: align.phoneId, ack: envelope }),
    });

    if (!cfg.alignKey) {
      say('');
      say(`${C.bold}${C.green}  ┌──────────────────────────────────────────┐${C.reset}`);
      say(`${C.bold}${C.green}  │  配对 key（输入到 fr「远程输入」demo）：  │${C.reset}`);
      say(`${C.bold}${C.green}  │                                          │${C.reset}`);
      say(`${C.bold}${C.green}  │            ${key}            │${C.reset}`);
      say(`${C.bold}${C.green}  └──────────────────────────────────────────┘${C.reset}`);
      say(`${C.dim}  key 即凭据：泄漏 = 任何人可向本机注入文本。勿外传。${C.reset}`);
      say('');
    }

    align.on('decrypt-error', ({ seq }) => {
      logger.error('解密失败：两端 key 不一致？', { seq });
    });
    align.on('op', (op) => {
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
    logger.info('服务端已登记本机', { clientId: msg.clientId, role: msg.role });
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

  // 注册门禁拒绝（4403）：token 配置错误需要人工介入，重连无意义，直接退出
  serve.on('auth-rejected', () => {
    logger.error('token 无效或缺失：请核对 --token / REMOTETYPE_TOKEN 与服务器 RT_TOKEN 是否一致');
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

// ============================ main ============================

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  const rest = positional.slice(1);

  if (flags.version || command === 'version') return printVersion();
  if (flags.help && !command) return printHelp();
  if (!command) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig(flags);

  switch (command) {
    case 'serve':
      return cmdServe(cfg);
    case 'test':
      return cmdTest(cfg, rest);
    case 'doctor':
      return cmdDoctor(cfg);
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
