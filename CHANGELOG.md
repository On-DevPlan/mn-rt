# Changelog

所有对外发布的版本变更记录。版本号即 npm 包 `nx-rt` 的版本，与 git tag
（`v<版本>`）和 GitHub Release 三者同步（发版流程见 README「发布」一节）。

本文件自 v0.6.1 起维护；此前版本由 git tag / commit 历史回溯补录。

## [0.7.11] — 2026-10-21

### chore(client): 移除平台分包依赖——安装时不再触发 deprecated 警告

`nx-rt` 此前把 `@ondevplann/input-agent-*@0.2.0` 挂在 `optionalDependencies`
上：这些包在 npm 上已被标记 deprecated，用户 `npm i -g nx-rt` 时会看到
「npm warn deprecated」——而实际上**主包 `binaries/` 内置的引擎才是运行时
唯一使用的二进制**（`findBinary` 解析顺序：包内副本 → 分包 → 缓存），分包
从未被真正用到，还停留在 0.2.0 旧引擎。

- `optionalDependencies` 整组移除：安装不再拉分包，警告消失。
- 分包作为独立渠道保留并刷新至 0.7.10（与 Release 同源、四平台齐备），
  0.2.0 的 deprecated 标记已清除；直装分包的用户拿到的也是新引擎。
- `findBinary` 的分包回退分支保留（无害）：分包缺失时静默跳过。

## [0.7.10] — 2026-10-21

### feat(vpad): 驱动安装进度可视化 + 隐藏提权控制台窗口

此前装 ViGEmBus 驱动会弹出一个独立的 PowerShell 黑窗口，安装输出全在那里，
nx-rt 自己的窗口毫无反馈。现在：

- **不弹窗**：CLI 提权调用与 rust 惰性路径的提权调用均加 `-WindowStyle
  Hidden`（实测提权进程 `MainWindowHandle == 0`）；安装脚本另做自我隐藏
  （`ShowWindow(SW_HIDE)`）兜底任何漏传参数的启动路径。
  UAC 确认框无法隐藏（Windows 安全边界），它本来也不是那个黑窗口。
- **进度可见**：安装脚本按 `<百分比>|<阶段>` 写进度文件，CLI `install-driver`
  在终端渲染单行进度条（█░ + 百分比 + 阶段 + 秒数），serve 期间手机触发的
  惰性安装则以日志行实时显示（`⏳ 虚拟手柄驱动：45% 正在静默安装驱动…`）。
  Windows 安装器无可读字节进度，故为阶段进度。
- 内嵌安装器不变：正常情况优先用包内自带副本（零下载），仅包内缺失/哈希
  不符才退化到官方源下载。

捆绑引擎刷新为本轮 CI 产物（含 rust 侧 `-WindowStyle Hidden`，惰性路径
零闪现）。

## [0.7.9] — 2026-10-21

### fix(client): vpad 入站解析补发——此前**从未进入任何已发布版本**

`3d169be` 给 rt-align 加了 vpad 入站分支（手机 `vpad_*` 信封 → op → 引擎），
但版本号没跟着 bump，代码没进过 npm：已发布的 0.7.0–0.7.8 里
`lib/rt-align.js` 一行 vpad 都没有。手机发的 vpad 包被当未知字段**静默丢弃**
——无 op、无日志、无报错，PC 端 `records.jsonl` 里一条 vpad 记录都不会出现，
虚拟手柄永远不出现，Steam 也就识别不到。

症状与排查成本都极不对称：引擎无罪（ViGEmBus 正常、捆绑二进制含 vpad 通道），
驱动无罪（`vpad_status` 正常应答），服务端也无罪（转发记录全是 `forwarded`），
唯一断点在客户端解析层，且**不打任何日志**。

### fix(client): vpad 句名映射——手机写死 `pad1`，引擎发的名字未必是它

rust 端句柄名由单调自增的 `next_index` 生成（`pad1`→`pad2`→…），且
`release_all` 清表时**不复位**。手机端把句柄写死 `pad1`（fr `rt_page.dart`
的 `_vpadHandle`，依赖「release_all → init 必得 pad1」这条契约），于是
**第二次** init 拿到 `pad2` 之后，手机后续所有按钮/十字键指令全撞
`unknown handle: pad1`——表现为「init 成功但手柄完全没反应」。

客户端现在记住 `vpad_init` 应答里的真实句柄（`handle` 字段），后续命令一律
重写到它；`vpad_release` / `vpad_release_all` 成功后清空，下次 init 重新学。
rust 侧同时治本：全部句柄释放后 `next_index` 归 1，引擎自己兑现那条契约。

### feat(client): vpad 指令成功不再静默

`dispatchVpad` 此前只在失败时打 warn，成功只落盘不打印——排障时无法区分
「没收到」和「收到了但静默」。现在 `vpad_init` / `vpad_release` 走 INFO
（「虚拟手柄已插上/拔下」一眼可见），按钮/轴/扳机等高频动作走 DEBUG，
避免游戏时刷屏。

### fix(client): `install-driver` 的提权包装此前**必然失败**

`Start-Process -Verb RunAs` 与 `-NoNewWindow` 是互斥参数集（PowerShell 报
`AmbiguousParameterSet`）。原代码两个都写上了，又用 `-ErrorAction SilentlyContinue`
把错误吞掉 → 管道无输出 → 落到 `exit 99` → 上层打印「UAC 被拒 / 取消 / 脚本报错」。
真相是**安装压根没执行、UAC 压根没弹**，而 `vpad_status` 之类的前置检查看起来
一切正常。

现在：去掉 `-NoNewWindow`（提权只能新开控制台），并把子进程退出码读出来，
按 98=提权被拒 / 2=安装器失败 / 3=非管理员 / 1=服务未起 分别给出原因。

### fix(client): 惰性安装路径此前**必然失败**（`\\?\` verbatim 路径）

`std::env::current_exe()` 在 Windows 上返回带 `\\?\` 前缀的 verbatim 路径，
拼出来的 `install-vigembus.ps1` 路径也带着它。而 PowerShell 的
`Join-Path $PSScriptRoot ...` 解析不了 verbatim 路径（报「参数 drive 的值为空」），
脚本在该行直接终止、退出码 1；提权子进程在另一个控制台里跑，调用方拿不到输出，
最终只表现为「install-vigembus.ps1 exited with code 1」。

三处同时修：
- rust `locate_script()` 剥掉 `\\?\`（含 `\\?\UNC\`）前缀再交给 PowerShell；
- 脚本改用字符串拼接（`"$ScriptDir\xxx.exe"`）而非 `Join-Path`——**脚本随 npm 包
  发布，这一处改完，已发布版本的惰性路径立刻可用，不必等二进制重出**；
- `locate_script()` 补 `client/scripts/`、`node_modules/nx-rt/scripts/` 候选，
  开发布局不再退化成「联网下载安装器」（国内网络下必挂）。

### fix(input-agent): `vpad_init` 一次分配两个手柄 → 系统里留幽灵设备

`try_init()` 建驱动连接时顺手建了第一个手柄，`execute(Parsed::Init)` 又建一个，
于是一次 init 占两个驱动 slot，其中一个手机端永远不会 release——进程被 kill 时
ViGEmBus 也不自动 unplug，系统里就留下 `Status=Unknown` 的幽灵手柄，Steam 枚举
时可能挑到错的那个。现在手柄一律只由 `vpad_init` 分配。

### fix(input-agent): 句柄名不复位 + 脚本留痕

- 全部句柄释放后 `next_index` 归 1，`vpad_init` 重新拿回 `pad1`（与手机端
  写死的 `_vpadHandle` 一致）
- 安装脚本把执行输出转录到 `%TEMP%\mn-rt-vigembus-install.log`：提权子进程在
  另一个控制台跑，调用方拿不到 stdout，此前失败原因彻底黑盒

### chore: 驱动安装脚本收敛为唯一源

`scripts/install-vigembus.ps1`（仓库根）是过期副本——它写死的 MSI 地址在任何
release 里都不存在（必 404），且与随包分发的 `client/scripts/` 那份已经分叉。
删除根目录副本，唯一脚本源为 `client/scripts/install-vigembus.ps1`。

### feat(client): 本地记录补 `action` 字段

`LocalStore.append` 是固定 9 字段 schema，调用方传的 `action` / `seq` 被丢弃，
`records.jsonl` 看不出是哪条 vpad 指令、也看不出 seq。schema 增加 `action`，
seq 仍不落盘（快照类记录靠 text 关联）。

## [0.7.3] — 2026-10-19

### feat(client): 新增 `install-driver` 子命令——一键装 ViGEmBus

`remotetype install-driver [--check]` 主动提供驱动安装入口，
之前只能被动等 `vpad_*` 首次触发时的 lazy 自动安装。

- `--check`（只查不装）：打印 ViGEmBus.sys 是否存在；若没装，提示
  下次跑 `npx remotetype install-driver` 或等 vpad_* 首次触发自动装。
- 默认（尝试装）：检测到驱动缺失时通过 PowerShell
  `Start-Process -Verb RunAs` 提升运行包内 scripts/install-vigembus.ps1，
  弹一次 UAC；UAC 拒/超时则脚本不会运行、也不会无限次弹。
- 完成后用 `fs.statSync` 复检 ViGEmBus.sys——这是权威判定，不依赖
  PS 子进程返回码（拒绝 UAC 时 PS 默认返回 0）。
- `--check` 是非交互的；交互只在用户主动跑不带 flag 的 `install-driver` 时发生。

无 vpad 业务不会触发任何 UAC；本命令是显式 opt-in。

## [0.7.2] — 2026-10-19

### fix(client): 捆绑引擎刷至含 vpad 通道的 CI MSVC 构建 + 打包 ViGEmBus 安装脚本

- 0.7.0 / 0.7.1 只发了 JS 层，`binaries/` 里捆绑的还是 0.6.0 的旧引擎
  （v0.6.0 触摸板版）——npx 用户的 `vpad_status` 会得到
  `unknown action`，vpad 功能完全不可用。本次把 `win32-x64` 与
  `linux-x64` 两份捆绑副本刷至 d417d74 的 CI 产物（含 vpad_* 全部
  协议 + 三轮 CI 修复）。0.6.1 曾为 linux-x64 修过同款坑（"随包
  linux-x64 二进制补到含鼠标通道的产物"），win32 这次一并补齐。
- `scripts/install-vigembus.ps1` 打进 npm 包（`client/scripts/` +
  package.json `files` 加 `scripts/`）：此前该脚本只在仓库根目录，
  npx 场景下 `locate_script()` 向上搜索找不到，自动安装链路断在
  最后一步。打包后路径为 `node_modules/nx-rt/scripts/install-vigembus.ps1`，
  恰好落在 exe 向上搜索的第 3 层，自动安装闭环。
- 新引擎冒烟：`vpad_status` → `{"ok":true,"platform":"windows",…}`；
  缺参 `vpad_button` → 清晰校验错误；`ping` → pong。
- bump 0.7.1 → 0.7.2。

## [0.7.1] — 2026-10-19

### feat(client): VPadClient SDK——Node 端 vpad_* 调用入口

- `client/lib/vpad.js` 新增 `VPadClient` 类，完成 v0.7.0 协议在客户端的
  使用面：
  - 生命周期：`init({slot, label})` / `release(handle|label)` /
    `releaseAll()` / `dispose()`；
  - 输入：`button` / `axis` / `trigger` / `dpad`（await 版）+ `*Now`
    （fire-and-forget 高频版，摇杆流推荐）；
  - 探测：`status()` / `list()`（透传 rust 原始 shape，不抛）；
  - 句柄缓存：rust 端命名（`pad1`）↔ 用户 label 双向索引；
  - autoInit：首次操作未 init 时按 `defaultSlot` 自动分配。
- `client/lib/index.js` 导出 `VPadClient`。
- `client/test/unit.js` 新增 14 条 VPadClient 单测（147 全过）。
- 导出的 `stats` 计数器：`inits/releases/buttons/axes/triggers/dpad/
  listQueries/statusQueries/failed`——业务侧便于观测。

### fix(input-agent): vpad_init 早 slot 校验 + 单次 install 风暴防御

- `vpad_init` 的 slot 范围检查从 driver connect 之后挪到参数解析前——
  与既有「参数全部先解析、后建连」惯例一致。此前 `slot:5` 会先尝试连
  驱动（驱动不在时还会先弹 install-vigembus.ps1 + UAC），最后才报错。
- `INSTALL_ATTEMPTED` 进程级标志：上游若在启动期异常循环连发
  `vpad_init`，把 UAC 弹窗次数压到最多 1 次；后续短路返明确提示
  「已尝试，请重启进程再试」。

### chore

- `client/package.json` 0.7.0 → 0.7.1。

## [0.7.0] — 2026-10-19

### feat(input-agent): Windows 虚拟 Xbox 360 手柄通道

- input-agent 新增 9 个 `vpad_*` 指令族——`vpad_init` / `vpad_release` /
  `vpad_release_all` / `vpad_button` / `vpad_axis` / `vpad_trigger` /
  `vpad_dpad` / `vpad_list` / `vpad_status`。
- 协议层承载于既有 stdin/stdout JSON 通道，**Node 端无任何改动**——后续要做
  Node 端 SDK 时只需 `import agent.js + send('vpad_button', ...)`。
- Windows 端依赖 `vigem-client 0.1.4`（CasualX 维护）通过 ViGEmBus 内核驱动
  暴露虚拟 XInput 设备，**与 enigo 鼠标通道完全独立**——延迟、开销、错误处理
  都各自隔离。
- 缺失 ViGEmBus 时首次 `vpad_init` 自动调 `scripts/install-vigembus.ps1` 触发
  UAC 安装；幂等；exit code 0/1/2/3 分级清晰。
- 非 Windows 端编译为 stub：`vpad_status` / `vpad_list` 返回平台标识，
  其他 `vpad_*` 返 `vpad requires Windows`，不破坏既有 Linux/macOS 的编译
  与测试。

### docs

- `docs/VIGEM_FINDINGS.md`：选型依据、API 摘要、坑点（admin 安装 / Drop
  不自动 unplug / TargetNotReady 重试）；与 `ENIGO_FINDINGS.md` 同调研笔记
  风格。

### chore

- `rust/input-agent/Cargo.toml` 版本 0.1.0 → 0.2.0（伴随 `input-agent` 协议表面扩展）。
- `scripts/install-vigembus.ps1` 新增脚本（幂等、admin 提升、ViGEmBus 服务管理）。

> 注：`@ondevplann/input-agent-*` 子包仍在 0.2.0（手发路径，绕 2FA 单独处理）；
> 本次仅 bump 主包 `nx-rt` 0.6.1 → 0.7.0，rust 二进制刷新随 GH Release tag 同步生效。

## [0.6.1] — 2026-10-18

- fix: 随包 linux-x64 二进制补到含鼠标通道的产物。0.6.0 的 npm 包里
  `binaries/linux-x64` 还是键盘-only 的旧引擎，而 findBinary 把随包二进制
  排在运行时下载回退之前——Linux npx 用户的触摸板会被旧引擎静默接管。

## [0.6.0] — 2026-10-18

- feat: **触摸板鼠标通道（RT1 v0.6.0 协议）三端贯通**——
  - input-agent 新增 `mouse_move` / `mouse_button` / `mouse_scroll` 三个
    action（enigo `Coordinate::Rel` 相对移动，Windows 不受系统指针加速干扰）；
  - rt-align 新增 `plain.mouse` 事件分支：seq 去重之前处理、不碰快照状态机、
    不回 ACK（高频通道），载荷白名单校验；
  - 新增 MousePump：鼠标指令绕过串行注入队列直通子进程，移动增量 8ms 合批，
    按键前先冲刷移动保住「先到位后点击」。
  - 手机端（fr）触摸板模式：单指移动/点按、长按拖拽、双指滚轮（惯性）/
    右键、三指 Alt+Tab，libinput 风格加速度曲线 + 灵敏度可调。

## [0.5.8] — 2026-10-14

- fix: `auth login --new-account`——换人登录强制认证中心重新登录，不再复用
  上一账号的会话。

## [0.5.7] — 2026-10-14

- fix: 登出不丢设备标识——同账号重登恢复原设备登记；换人登录先退出认证中心。

## [0.5.6] — 2026-10-14

- feat: 同一设备多账号——账号簿 + `auth list` / `auth switch` +
  `serve --account`，多人共用一台电脑各登各的。
- feat(server): 死设备自动驱逐（注册表长期不上线的记录定时清理）；
  `/my/devices` 只返回在线设备。

## [0.5.5] — 2026-10-12

- feat: 快捷键指令——RT1 信封新增 `hotkey` 字段，手机端可触发 PC 组合键
  （单 chord 与序列宏，手机端可编排）。
- fix: auth login Windows 不再借道 cmd——URL 里的 `&` 被当成命令分隔符，
  浏览器只收到首段。
- feat(server): 设备令牌有效期 30 天 → 365 天。

## [0.5.4] — 2026-10-11

- fix!: 内置默认服务地址换成真实部署——零参数 `auth login` 之前必然失败。

## [0.5.3] — 2026-10-11

- feat: 统一登录 CLI（`auth login` / `auth status`）——服务端按属主下发
  会话密钥，手机登录同一账号即可直连，两端不再有任何人工复制。
- fix(server): OIDC redirectUri / idpError 透传等系列修复；属主路由单测。

## [0.5.2] — 2026-10-11

- feat!: 配置目录迁移到 `~/.nx-rt`——与 npm 新包名一致（`REMOTETYPE_CACHE`
  等旧环境变量仍兼容）。

## [0.5.1] — 2026-10-11

- feat: 连接记忆——连通后自动保存 url/key/token，之后裸命令直连。
- chore!: npm 包更名 `@ondevplann/remotetype` → **`nx-rt`**。

## [0.5.0] — 2026-10-11

- feat: 手机端回车注入双模式——发送（Enter）/ 换行（Shift+Enter）随每条
  快照即时切换；发送模式提交后 mirror 归零，与手机端「发后清空」对齐，
  不再重复注入。
- ci: linux 冒烟测试补 Xvfb（hotkey / enter_mode 步骤需要 X server）。

## [0.4.0] — 2026-10-10

- feat!: 取消焦点绑定——总是跟随 PC 当前焦点注入（v0.3 的 `expect_focus`
  校验停用，字段保留兼容旧客户端报文）。

## [0.3.1] — 2026-10-10

- chore: 仓内二进制刷至 v0.3.0 release 资产。

## [0.3.0] — 2026-10-10

- feat: 焦点识别与 `expect_focus` 校验——电脑切窗口时拒绝注入并回
  `focus_drift`（Windows / Linux X11；macOS 优雅降级）。
- fix(input-agent): linux 焦点查询三连修（x11rb 0.13 的 focus 字段即裸
  u32、补 ConnectionExt trait import、Screen.root 同样是裸 u32）。

## [0.2.1] — 2026-10-10

- fix: 对齐模式保留纯空白按键计划——IME 自动插入的换行不再把整批计划挂起。

## [0.2.0] — 2026-10-10

- feat!: serve 默认对齐模式（RT1 端到端加密），明文模式降级为 `--plain`。
- ci: fuck-npm 补 id-token 权限（`--provenance` 需要）；win32 引擎二进制入库。

## [0.1.3] — 2026-10-10

- docs: README 同步 npm 发布信息，发布走 CI（fuck-npm 自动化）。

## [0.1.2] — 2026-10-10

- fix(client): RT1 对齐修复——注入失败误推进 mirror、后缀优化错位、
  二进制下载版本号拼错。

## [0.1.1] — 2026-10-08

- fix(release): 修复 GitHub Release 产物同名互相覆盖——4 平台只剩 2 个
  文件，资产统一加平台前缀。

[0.6.1]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.6.1
[0.6.0]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.6.0
[0.5.8]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.5.8
[0.5.7]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.5.7
[0.5.6]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.5.6
[0.5.5]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.5.5
[0.5.4]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.5.4
[0.5.3]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.5.3
[0.5.2]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.5.2
[0.5.1]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.5.1
[0.5.0]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.5.0
[0.4.0]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.4.0
[0.3.1]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.3.1
[0.3.0]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.3.0
[0.2.1]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.2.1
[0.2.0]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.2.0
[0.1.3]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.1.3
[0.1.2]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.1.2
[0.1.1]: https://github.com/On-DevPlan/mn-rt/releases/tag/v0.1.1
