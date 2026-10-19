# ViGEmBus & vigem-client 调研笔记

> v0.7.0+ Windows 虚拟手柄通道的研究决策记录。模仿 `ENIGO_FINDINGS.md` 风格。

## 目标

让 `input-agent` 通过进程内 IPC（stdin/stdout JSON）暴露 `vpad_*` 指令族，
让 Node 端能创建并驱动一个**虚拟 Xbox 360 手柄**——Windows 游戏看到的是
「真的插了一只手柄」。

不读物理手柄（gilrs 等不在 scope）。X360 only（DS4 / 振动 / 触摸板留给后续）。

## 选型

| 选项 | 评 |
|---|---|
| ViGEmBus + `vigem-client` (Crates.io) | ✅ 选中。开箱即用，异步 / IOCTL 内部处理，状态保活全自动 |
| ViGEmBus + 直调 Win32 DeviceIoControl | ❌ C 头文件 + ioctl 拼装 + P/Invoke 重复 4–5k 行；信号处理自己写 |
| HID raw + sign a custom driver | ❌ 跨 64-bit 内核签名 + WHQL 不在业余项目负担得起 |
| XInput emulation (user-space `xinput1_3.dll` 注入) | ❌ 仅欺骗 XInput API 调用方，不欺骗内核 HID 枚举；游戏走 HID 类驱动 |

`vigem-client` 由 CasualX 维护（crates.io id：`vigem-client`）。
最新稳定版：**0.1.4**（无 `1.x / 2.x`——我最初假设错了，已在实现期
修正 Cargo.toml 版本约束）。

API 摘要：

```rust
let client = Client::connect()?;                  // Err BusNotFound if 驱动未装
let mut target = Xbox360Wired::new(client, TargetId::XBOX360_WIRED);
target.plugin()?;                                // Err NoFreeSlot if 4 个全占
let _ = target.wait_ready();                      // 阻断几十 ms；可空跑
target.update(&XGamepad {
    buttons: XButtons { raw: 0x1000 },            // bit field, A=0x1000 ...
    left_trigger: 0, right_trigger: 255,
    thumb_lx: 32767, thumb_ly: -32768,
    thumb_rx: 0, thumb_ry: 0,
})?;
```

- **多设备**：`Xbox360Wired<T>` 的 `T: Borrow<Client>` 支持 `Client` / `Rc<Client>` / `Arc<Client>`。
  input-agent 单线程，所以统一用 `Rc<Client>`——多目标共享一个 Client 连接，省内核句柄和驱动 slot（驱动最多 4 个 X360）。
- **生命周期**：`Xbox360Wired::Drop` 自动 `unplug()`，所以丢 PadEntry 就拔手柄——`main.rs` 的 `drop(vpad)` 即可在进程退出时清理，不留 zombie。
- **D-Pad 仍是普通 bit**：UP=0x0001 / DOWN=0x0002 / LEFT=0x0004 / RIGHT=0x0008，
  与 A/B/X/Y 共用 `buttons_raw: u16`。处理 `vpad_dpad` 时 mask 出这 4 bit 单独写。

## 已知坑

### 1. `Driver.sys` 是内核态，必须有 admin 安装

ViGEmBus 是 kernel-mode driver，单凭 npm 包**无法**无感安装；必须有一次 admin
授权（UAC）。`scripts/install-vigembus.ps1` 是这条路的封装。

约束：
- msiexec 静默装：`/qn` + `MSIFASTINSTALL=1` + `REBOOT=R`。
- 装完要 `Set-Service ViGEmBus -StartupType Automatic` + `Start-Service ViGEmBus`。
- 装失败的回退：手动到 <https://github.com/ViGEm/ViGEmBus/releases> 下 MSI 自装。

### 2. input-agent 自动调脚本的入口

用户机器常见情况：装了 Node 客户端发 `vpad_init` 时驱动不在。

```text
{"action":"vpad_init"}
↓
vigem-client: Client::connect() returns Error::BusNotFound
↓
vpad::install_vigembus::request_install() 跑 powershell.exe Start-Process -Verb RunAs
↓
脚本以管理员身份自启；UAC 弹一次，用户点 Yes（或拒）
↓
幂等返回：已装 exit 0 / 装好 exit 0 / 拒 exit 2
↓
Client::connect() 重试
```

**注意**：input-agent 自己不会弹 UAC——它开子进程（PowerShell），
子进程自己用 `Start-Process -Verb RunAs` 弹。规避了「一个非交互进程如何
触发 UAC」的经典难题。

### 3. ViGEmBus 1.21+ 才支持安静的「等待 ready」

老版本驱动 plugin 后立刻 update 可能拿到 `TargetNotReady`。
v0.7.0 在 `allocate()` 里调 `wait_ready()`（一次几百 ms），代价可接受。
后续第一次 update 仍可能 `TargetNotReady`——`submit()` 把它视为「下次 update 自然好」。

### 4. 进程 killed 不自动 unplug

vigem-client 文档原话："If a target is dropped without running its destructor
(eg. process is killed) then the virtual controller will remain stuck."

我看了 `Drop for Xbox360Wired` 实际是 `unplug()` 后置——`Drop` 正常走的前提
是进程能**优雅退出**。Spawned 后用 `WM_CLOSE` / 关 stdin / SIGTERM 让主循环
自然退，才能 unplug。

Node 侧 `agent.js:368` 的 `child.stdin.end()` 已经实现了优雅 shutdown。
本补丁在 `main.rs` 末尾加 `drop(vpad);` 强化——确保主循环 break 之后手柄
一定 unplug。

### 5. non-Windows stub 的协议形状

`vpad_status` / `vpad_list` 在非 Windows 上不报错，返：

```json
{"ok":true,"platform":"linux-x11","driver":"unsupported","bus":"unavailable","slots_used":0}
{"ok":true,"handles":[],"count":0,"platform":"linux-x11"}
```

让 Node 端能「无论哪种平台 vpad_status 都能拿到一个 ok:true 的 response」，
方便上层做能力探测。其他 vpad_* action 返 `vpad requires Windows` 错误。

## 实测环境

| 平台 | rust target | 状态 |
|---|---|---|
| Windows 11 26H2 | `stable-x86_64-pc-windows-gnu` + LLVM-mingw | cargo build 通过；binary 启动 ping OK；vpad_status 正常返；vpad_init 触发脚本找不到路径的清晰错误 |
| 当前机器 | 未装 ViGEmBus | vpad_init 按设计报「请装驱动」类消息（实测） |

## 引用

- ViGEm 项目首页：<https://vigem.org/>
- ViGEmBus driver 仓库：<https://github.com/ViGEm/ViGEmBus>
- vigem-client 0.1.4 docs：<https://docs.rs/vigem-client/0.1.4>
- XInput 协议按键常量：见 `src/vpad.rs::VPadButton::bit` 注释
- 相关 PR/Issues：项目本身无

## 后续 v0.8.x 候选

- DualShock 4：开 `vigem-client/unstable_ds4` feature + 加 `vpad_profile: "ds4"` 字段
- 力反馈 (rumble)：开 `unstable_xtarget_notification` feature
- 多槽优雅 fallback：超 4 个 pad 时返 `vpad_init: max 4 handles` 但不是 hard error
- 驱动热插拔自愈：检测 `update()` 返 `BusAccessFailed` 时重建 Client

## 调研笔记：替代 Rust binding（2026-10 调研，未采纳）

| Crate | crates.io | 说明 |
|---|---|---|
| `vigem-client` (CasualX) | 0.1.4（已用） | 当前绑定。C 头绑定的纯 Rust 重实现，0.1.x 已 6 年未更新。维护薄弱但 API 简洁够用。 |
| [`vigem-rust`](https://github.com/arounre/vigem-rust) | 0.2.0 | arounre 个人维护的现代重写：type-state 防误用（`Pending` → `Ready`）、通知通道（rumble/LED）、PnP serial discovery、DS4 + touchpad + motion 完整。**仍需 ViGEmBus**——未改变驱动依赖，仅在 Rust 端代码质量上一档。 |
| [`XOutputPlus`](https://www.xinput.org) 等 DLL 注入方案 | — | 不需驱动但只欺骗 XInput API 调用方，HID 路径完全失效、抗病毒告警、游戏覆盖差。|

**最终决策**：v0.7.0 保持 `vigem-client 0.1.4` 不动，文档仅记录。后续 v0.8.x 需要加 DS4 / 震动 / 多 pad 协调时，再迁到 `vigem-rust`。

## 改动记录（v0.7.0）

- `rust/input-agent/Cargo.toml`: `[target.'cfg(target_os = "windows")'.dependencies]` 加
  `vigem-client = { version = "0.1", default-features = false }`；包版本 0.1.0 → 0.2.0
- `rust/input-agent/src/vpad.rs`: 新增模块，全功能 Windows 实现 + non-Windows stub
- `rust/input-agent/src/main.rs`: `mod vpad;` + `Command` 字段 `pub(crate)` + 9 个新字段 +
  handle_line 多参数 + dispatch arm + main() state
- `scripts/install-vigembus.ps1`: 新增脚本
- `docs/VIGEM_FINDINGS.md`: 本文档
- `CHANGELOG.md`: v0.7.0 条目
- `.github/workflows/build-input-agent.yml`: Windows 端 stdin smoke test
