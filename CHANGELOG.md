# Changelog

所有对外发布的版本变更记录。版本号即 npm 包 `nx-rt` 的版本，与 git tag
（`v<版本>`）和 GitHub Release 三者同步（发版流程见 README「发布」一节）。

本文件自 v0.6.1 起维护；此前版本由 git tag / commit 历史回溯补录。

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
