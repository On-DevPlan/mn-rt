# RemoteType — 远程语音转文字输入系统

[![build-input-agent](https://github.com/ZHLX2005/mn-rt/actions/workflows/build-input-agent.yml/badge.svg)](https://github.com/ZHLX2005/mn-rt/actions/workflows/build-input-agent.yml)
[![node-ci](https://github.com/ZHLX2005/mn-rt/actions/workflows/node-ci.yml/badge.svg)](https://github.com/ZHLX2005/mn-rt/actions/workflows/node-ci.yml)
[![npm version](https://img.shields.io/npm/v/@ondevplann/remotetype)](https://www.npmjs.com/package/@ondevplann/remotetype)

把手机上的语音识别结果，实时注入到电脑当前焦点输入框。

```
手机 (ASR 文本)
   │  WebSocket
   ▼
公网 Serve 服务端  ──按 clientId 路由──►  PC 客户端 (npx @ondevplann/remotetype serve)
                                              │  Node 业务层
                                              │  stdio IPC（单行 JSON）
                                              ▼
                                        Rust input-agent 子进程
                                              │  enigo
                                              ▼
                                      系统级字符注入 → 当前焦点输入框
```

设计上的两条硬边界：

- **Node 与 Rust 之间只走 stdio 管道**，不用 FFI / ABI。Rust 子进程崩溃不影响 Node 主进程，可以独立重启。
- **serve 默认对齐模式**（v0.2.0 起）：端到端加密 + 输入实时对齐；旧普通模式降级为 `--plain` 显式开启（见下文）。

---

## 对齐模式（serve 默认 · 端到端加密 · 输入实时对齐）

RT1 协议：手机端（网页控制台 / fr「远程输入」demo）上传**加密全文快照**，
PC 端解密后 diff 出「退格 N 次 + 插入 M 字」的按键计划，经既有 queue→rust-agent 管线注入——
**手机输入框与电脑焦点输入框完全对齐，包括删除与中段编辑**。

### 用法

```bash
# 电脑：启动（不传 --key 则自动生成强随机 key 并打印）
npx @ondevplann/remotetype serve
npx @ondevplann/remotetype serve --key MYKEY123     # 两端用同一个 key

# 手机方式一（免装 app）：浏览器直接打开 http://<server>:8790/
#   网页控制台已内置 RT1 实时同步——输入/删除实时对齐，无发送按钮；
#   非加密上下文（http）里浏览器语音不可用，用输入法自带语音键即可
# 手机方式二：fr app → Lab → 远程输入（联机）→ 填服务器地址 + key → 连接电脑
# 服务器：node server/src/server.js，建议同时设置 RT_TOKEN 注册门禁
#   设了 RT_TOKEN 后，PC 端须携带同一 token（--token 或环境变量 REMOTETYPE_TOKEN / RT_TOKEN）：
npx @ondevplann/remotetype serve --token SECRET
```

### 协议要点（RT1 直连版）

- **一 key 三用**：key 归一化后 PBKDF2→HKDF 派生 配对盐/AAD 上下文/双方向 AES 密钥；
  房间号派生仅作 AAD 标签，不再是路由地址。
- **无配对握手**：中转服务器是哑路由（按 clientId 转发），没有广播房间要保护——
  「第一个能通过 GCM tag 校验的信封」即会话确立，tag 本身就是持钥证明。
- **对齐**：手机每次输入框变更上传全文快照（AES-256-GCM，随机 nonce，
  AAD 绑定 `RT1|<派生标签>|方向|seq`），PC diff（grapheme 级 + 后缀优化）→ 注入 → 累积 ACK
  （经服务端按 phoneId 反向路由）；手机能解开 ACK = 端到端闭环成立。
- **防重放**：seq 单调去重；手机重启换会话号自动重置 seq 域；明文流量在 align 模式下一律拒绝。

### 安全边界（务必阅读）

- **key 即凭据**：拿到 key = 可向这台电脑注入任意文本 + 解密全部输入内容。勿外传、勿入库。
- 中转链路为明文 WS（机密性由端侧加密承担）；元数据（clientId、时序、长度）不设防。
- 服务器可设 `RT_TOKEN`（或 `--token`）注册门禁：防陌生人注册灌包。PC 端以 `--token`
  （或 `REMOTETYPE_TOKEN` / `RT_TOKEN` 环境变量）携带同一值，不符会被 4403 拒绝并停止重连；
  PC 端对齐模式本身也会丢弃一切非信封/解密失败的流量。
- 对齐语义限制：PC 侧用户手工移动光标/打字会破坏对齐（与同类工具一致的已知限制）；
  清空超长文本靠逐键退格，耗时与长度成正比。
- v0.4.0 起焦点注入策略 = 总是跟随 PC 当前焦点（v0.3.0 的"焦点绑定 + 漂移暂停"
  安全网被有意移除——用户希望手动切焦点立刻换绑）。代价：误点其他窗口后，后续
  字符会进错地方且 mirror 与目标真实内容脱钩；此时需 PC 端 Ctrl+C 杀 serve 重连
  让 mirror 从零开始重建，或先 Ctrl+A 选中目标框已有内容并删除让手机重发整段。

---

## 目录结构

```
remotetype/
├── server/                     # 公网 Serve 服务端
│   ├── src/
│   │   ├── server.js           # WS 路由 + HTTP 测试接口 + 网页控制台托管
│   │   ├── logger.js           # 分级日志（debug/info/warn/error）
│   │   └── store.js            # jsonlines 转录记录持久化
│   └── public/                 # 网页控制台（RT1 实时同步客户端，免装 app）
│       ├── index.html          # 输入/删除实时对齐，无发送按钮
│       └── rt1-core.js         # RT1 WebCrypto 实现（与 Node/Dart 三方向量对拍）
├── client/                     # PC 客户端（npm 包）
│   ├── bin/index.js            # CLI 入口（serve / test / doctor / binary）
│   ├── lib/
│   │   ├── agent.js            # Rust 子进程管理（spawn + 心跳 + 自动重启）
│   │   ├── queue.js            # FIFO 串行队列
│   │   ├── ws-client.js        # WS 指数退避重连
│   │   ├── sanitize.js         # 文本预处理（控制字符过滤）
│   │   ├── platform.js         # 平台识别 + 二进制查找
│   │   ├── config.js           # 配置合并（默认 < 文件 < env < CLI）
│   │   └── store.js            # 本地 jsonlines 记录
│   └── binaries/<platform>/    # 各平台预编译注入引擎
├── rust/
│   ├── input-agent/            # 注入引擎（enigo）
│   └── vendor/xkeysym/         # 打过补丁的 xkeysym（见下文「已知问题」）
├── docs/ENIGO_FINDINGS.md      # enigo / xkeysym 实测结论与修复记录
├── test/e2e.sh                 # 端到端测试（Linux，19 项断言）
└── .github/workflows/          # 多平台 CI 编译
```

---

## 快速开始

### 1. 启动公网服务端

```bash
cd server
npm install
npm start
# 默认监听 0.0.0.0:8899
```

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RT_PORT` | `8899` | 监听端口 |
| `RT_HOST` | `0.0.0.0` | 监听地址 |
| `RT_TOKEN` | （空） | 注册门禁 token：设置后 WS 注册与 HTTP `/push` 都必须携带，未注册连接的任何消息被 4403 拒绝 |
| `RT_RECORD_FILE` | `./data/records.jsonl` | 转录记录文件 |
| `RT_LOG_DIR` | `./logs` | 日志目录 |
| `RT_LOG_LEVEL` | `info` | 日志级别 |

### 2. 启动 PC 客户端

```bash
npx @ondevplann/remotetype serve --url ws://your-server.example.com:8790/ws
```

serve 默认**对齐模式**：自动生成配对 key 并打印，手机端（网页控制台 / fr app）填同一 key 即可实时对齐。也可以全局安装后使用短命令：

```bash
npm install -g @ondevplann/remotetype
remotetype serve --url ws://your-server.example.com:8790/ws
```

首次运行会自动生成并持久化 `clientId`（存于 `~/.remotetype/client-id`），用于服务端按目标路由。

常用参数：

```bash
npx @ondevplann/remotetype serve --url <ws-url> --client-id <id> --log-level debug
npx @ondevplann/remotetype serve --key MYKEY123       # 两端用同一个 key
npx @ondevplann/remotetype serve --plain              # 旧普通模式（见下）
npx @ondevplann/remotetype test "这是一段测试文本"     # 本地注入测试，不经过公网
npx @ondevplann/remotetype doctor                     # 环境自检（平台/权限/二进制）
npx @ondevplann/remotetype binary                     # 查看注入引擎二进制路径
```

**旧普通模式（`--plain`）**：v0.2.0 前的 serve 行为——接收 `/push` 接口与外部脚本推来的整句明文，
打完即注入，无对齐、无加密。仅建议 curl / 自动化脚本场景使用：

```bash
npx @ondevplann/remotetype serve --plain --url ws://your-server.example.com:8790/ws
curl -X POST http://127.0.0.1:8899/push -H 'Content-Type: application/json' \
  -d '{"clientId":"pc-abc123","text":"明天上午十点开会"}'
```

### 3. 推送文本（`--plain` 模式 / 模拟手机端）

PC 端以 `--plain` 启动时，用 HTTP 测试接口直接推送整句文本：

```bash
curl -X POST http://127.0.0.1:8899/push \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"pc-abc123","text":"明天上午十点开会"}'
```

对齐模式（默认）不走此接口——手机输入经 RT1 加密信封直达 PC 端。

---

## 通信协议

### 服务端 HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活探针 |
| GET | `/stats` | 连接数 / 消息数 / 转发成功率 |
| GET | `/clients` | 当前在线客户端列表 |
| GET | `/records?limit=N` | 最近 N 条转录记录 |
| POST | `/push` | 推送文本，body `{clientId, text}` |

`/push` 返回的 `status` 取值：

- `forwarded` — 成功转发给目标客户端
- `target_offline` — 目标 PC 未上线
- `rejected_empty` — 文本为空或纯空白
- `send_failed` — 写入 WS 失败

### WebSocket 消息

客户端上线后先发 `register`（区分 `pc` / `phone` 角色），服务端回 `registered`。

文本推送走单行 JSON：

```jsonc
// 手机 → 服务端
{ "type": "text", "clientId": "pc-abc123", "text": "明天上午十点开会" }

// 服务端 → PC 客户端
{ "type": "text", "text": "明天上午十点开会", "ts": 1730000000000 }
```

同一 `clientId` 重复上线时，服务端踢掉旧连接，保证路由目标唯一。

### Node ↔ Rust stdio 协议

单行 JSON，`\n` 分隔：

```jsonc
// Node → Rust
{ "action": "type_text", "text": "要注入的文本" }
{ "action": "ping" }

// Rust → Node
{ "ok": true,  "msg": "input complete", "chars": 8 }
{ "ok": false, "msg": "错误原因" }
```

---

## 关键实现说明

### 断线重连（`client/lib/ws-client.js`）

指数退避：1s → 2s → 4s → 8s，上限 10s；连接成功后重置退避计数。应用层 25s 发一次 `ping` 保活。

### 串行队列（`client/lib/queue.js`）

严格 FIFO，保证「先说的话先注入」，不会因为并发而交叉乱序。队列满时丢弃**新**消息（而非旧消息），避免丢失用户更早的内容。

### 子进程管理（`client/lib/agent.js`）

- 空闲时定期 `ping` 做心跳，超时视为卡死并重启
- 进程退出后 2s 自动重启；若短时间内连续快速重启超过 10 次则放弃，避免疯狂重启
- 停止时先 `SIGTERM`，2s 后仍未退出再 `SIGKILL`
- 二进制自动补可执行位（`chmod +x`）

### 文本预处理（`client/lib/sanitize.js`）

过滤零宽字符（`\u200B-\u200D`、`\uFEFF`）与 C0/C1 控制字符，**保留** `\n`、`\t`、`\r`，统一换行符，空串直接丢弃，超长截断（默认 5000 字符）。

### 长文本分片（`rust/input-agent/src/main.rs`）

单次 `text()` 调用注入超长文本时，部分应用会丢字。因此按 32 字符分片、片间 25ms 延时；超过 400 字符的文本把延时提升到 45ms。每片最多重试 3 次。

---

## 平台支持

| 平台 | 架构 | 状态 |
|---|---|---|
| Windows | x64 | ✅ 支持 |
| macOS | x64 / arm64 | ✅ 支持（需手动授权） |
| Linux | x64（X11） | ✅ 支持 |
| Linux | x64（Wayland） | ❌ **不支持** |

### macOS：必须手动开启辅助功能权限

系统设置 → 隐私与安全性 → 辅助功能 → 勾选运行 `remotetype` 的终端（Terminal / iTerm）。

未授权时注入会被系统静默拦截，`remotetype doctor` 会提示。

### Linux：仅支持 X11

**Wayland 不支持**。原因是 enigo 的 Wayland 后端存在缺陷：`wl_seat` 分支未记录 `keyboard_manager`，存在注册表公告顺序竞态，即使对着正常运行的 Weston 也返回 `EstablishCon("no successful connection")`（对应上游 issue #297）。

客户端检测到纯 Wayland 会话时会明确降级提示。XWayland 下部分应用可用，但不受支持。

### Windows：杀软白名单

注入引擎会被部分杀软误报为键盘记录器，需要加白名单。

---

## 已知问题与修复：xkeysym 错误 keysym 映射

这是本项目踩过的最隐蔽的坑，记录在 [`docs/ENIGO_FINDINGS.md`](docs/ENIGO_FINDINGS.md)。

**现象**：注入中文句号 `。` 时，目标程序收到的是 `kana_fullstop` 而非句号。日文假名、韩文谚文、CJK 标点（`。、「」`）、数学/制图符号都受影响。

**根因链路**：

```
'。' → Key::Unicode → xkeysym::Keysym::from_char
     → KEYSYMTAB 命中 CodePair { keysym: 0x04a1, ucs: 0x3002 }
     → 发出 0x04a1 (kana_fullstop)  ✗ 应该是 0x1003002
```

上游 `from_char` 会优先在传统 keysym 表里找匹配，找到就返回**传统 keysym**。而 X11 规范要求 Unicode 字符应使用 `0x01000000 + codepoint` 形式的 keysym。扫描 763 条表项，**286 条**属于这种「传统 keysym 指向较高码位」的歧义映射。

**修复**：vendor 一份 `xkeysym` 到 `rust/vendor/xkeysym/`，patch `from_char`，对 Unicode 码位统一返回规范 keysym：

```rust
let _ = KEYSYMTAB;              // 不再查传统表，避免歧义
Self::new(ucs | 0x01000000)
```

再用 `[patch.crates-io]` 让 enigo 使用本地版本：

```toml
[patch.crates-io]
xkeysym = { path = "../vendor/xkeysym" }
```

修复后 252 字长文本、含 `。、「」、` 的短句均逐字一致。

> 中途走过一段弯路：曾尝试在 Rust 层把字符分流为 `Unit::Plain` / `Unit::Special` 并单独注入特殊字符，但 enigo 未暴露原始 keysym 接口，该方案实际是 no-op，已删除。

---

## 测试

### 端到端测试（Linux）

```bash
bash test/e2e.sh          # 全部 6 用例，19 项断言
bash test/e2e.sh 2 6      # 只跑用例 2 和 6
```

依赖 `Xvfb`、`xev`、`xdotool`、`python3`、`curl`。

覆盖：

| # | 用例 | 断言数 |
|---|---|---|
| 1 | 正向链路（服务端 → 客户端 → 窗口） | 6 |
| 2 | 本地单测（不走公网，含中文标点） | 2 |
| 3 | 子进程崩溃容错（kill 后自动重启） | 3 |
| 4 | 队列串行（连发 5 条，顺序不乱） | 1 |
| 5 | 异常文本过滤（空 / 控制字符） | 4 |
| 6 | 长文本分片（无丢字、无错误 keysym） | 3 |

当前结果：**19 / 19 通过 ✅**

> 脚本会自行拉起私有 Xvfb 并在结束时销毁。之所以不复用已有的 X server，是因为长期运行、反复开关客户端后 X server 的 client 资源会退化——新连接以 `no connection could be established` 失败，但 `xdpyinfo` 仍正常响应，健康检查无法察觉。脚本在环境检查阶段会做一次真实注入探测，失败就重建 Xvfb。

验证手法：用 `xev` 打开一个观测窗口，把收到的 `KeyPress` 事件里的 keysym 还原成字符，与目标文本逐字比对。这样能区分「真的注入了正确字符」和「注入了一个看起来像但实际错误的 keysym」。

### CI

仓库 `mn-rt` 配有三个工作流：

**`build-input-agent.yml`** — 4 平台并行编译 Rust 注入引擎（win32-x64 / darwin-x64 / darwin-arm64 / linux-x64），产出 `SHA256SUMS.txt`，并在 Linux 上跑冒烟测试（ping / 非法 JSON / 未知 action 后进程存活 / 空输入）。push tag `v*` 时自动创建 GitHub Release 并上传产物。

**`node-ci.yml`** — JS 侧检查：

| job | 内容 |
|---|---|
| `server` | Node 20/22 语法检查 + `/health`、`/stats`、`/push` 启动冒烟 |
| `client` | 3 平台 × Node 20/22，语法检查 + CLI 冒烟 + 25 项单元测试 |
| `rust unit` | `cargo test` / `cargo fmt --check` / `cargo clippy -D warnings` |

**`fuck-npm.yml`** — push 到 main 自动发布 npm 包 `@ondevplann/remotetype`（见下节）。

### 发布

发布 = bump `client/package.json` 版本 + push 到 main，其余全部由 CI 完成：

1. `fuck-npm.yml` 自动打 git tag `v<版本>` 并 `npm publish --provenance`（npm 上已有该版本则幂等跳过）；
2. **手动补一步编译发布**：GitHub 防递归机制下，GITHUB_TOKEN 推的 tag 不会触发其他工作流，
   需在 tag 上手动 dispatch（该 run 做 4 平台编译 + 自动创建 GitHub Release、上传产物）：

   ```bash
   gh workflow run build-input-agent.yml --ref v0.1.x   # 换成实际版本
   ```

```bash
# 唯一的手动步骤：改 client/package.json 的 version 后
git add client/package.json && git commit -m "chore(release): v0.1.x" && git push
```

两层幂等保护：git tag 已存在则跳过创建；npm 上已有该版本则跳过发布 —— 重复 push 安全。

发布后产物地址形如：

```
https://github.com/ZHLX2005/mn-rt/releases/download/v0.1.0/linux-x64/input-agent
```

**版本纪律**：npm 包版本、git tag、GitHub Release 三者必须同步（运行时二进制下载回退按 `v<npm版本>` 拼地址）。改了 Rust 代码 → 先确认 Release 资产已就位，再发 npm。

**平台分包**（`@ondevplann/input-agent-{win32-x64,linux-x64,darwin-x64,darwin-arm64}`）不在自动发布范围：Rust 产物变更后从 Release 取对应二进制手动 `npm publish`（版本号与 Release tag 一致），darwin 分包待补。

可用 `REMOTETYPE_BINARY_BASE` 覆盖下载源，`REMOTETYPE_VERSION` 覆盖版本号。

---

## 配置优先级

客户端配置合并顺序（后者覆盖前者）：

```
内置默认值  <  配置文件  <  环境变量  <  CLI 参数
```

环境变量：`REMOTETYPE_URL`、`REMOTETYPE_CLIENT_ID`、`REMOTETYPE_HOME`、`REMOTETYPE_LOG_LEVEL`。

---

## 已知限制（MVP 范围）

- serve 默认对齐模式已内置端到端加密；`--plain` 模式无鉴权无加密，公网部署前必须自行加 TLS 与访问控制（RT_TOKEN 可作注册门禁）。
- 无 GUI。
- 手机端 ASR 已接入 fr「远程输入」demo（对齐模式，即默认 serve）；`--plain` 模式仍用 HTTP `/push` 模拟。
- Wayland 不支持。
- macOS 需手动授权，无法自动完成。
- 服务端为单进程内存态连接表，不支持多实例水平扩展。
