//! 虚拟 Xbox 360 手柄通道（`vpad_*` 指令族）。
//!
//! 仅 Windows：依赖 ViGEmBus 内核驱动 + `vigem-client 0.1.x`。
//! 非 Windows 编译为 stub：`vpad_status` / `vpad_list` 返回平台标识；
//! 其他 `vpad_*` 返 `vpad requires Windows`。
//!
//! 设计要点：
//!   * 单连接（`vigem_client::Client`，由 `Rc` 持有）+ 多 handle（每个 handle
//!     一份 `Xbox360Wired<Rc<Client>>`），共享同一 Client 以节约驱动 slot
//!     （驱动最多允许 4 个手柄）。
//!   * 状态懒初始化：首次 `vpad_*` 触发时连驱动并创建首个手柄（默认 slot=1）。
//!     后续 `vpad_init(slot=N)` 可追加更多手柄。
//!   * 持久化状态：每个 handle 维护一份「上一次」的完整按钮 + 轴 + 扳机值，
//!     每次 `vpad_button` / `vpad_axis` 都基于上一次的全局状态更新——避免
//!     「按下 A」后「释放 A」需要重发其他轴状态的烦恼。
//!   * 驱动缺失（`Error::BusNotFound`）→ 自动调 `scripts/install-vigembus.ps1`
//!     触发 UAC 安装；安装成功则重连，否则返清晰错误。
//!
//! main.rs 的协议入口：`pub fn dispatch(&mut Option<VPadState>, &Command) -> Result<Value, String>`。

// 这三个 import 只被 Windows-gated 代码用：
//   HashMap / Rc → VPadStateInner / PadEntry（vpad_init 握手 + 多 handle 表）
//   Ordering     → INSTALL_ATTEMPTED 的原子读改写
// 非 Windows 编译路径（non_win_dispatch）只需要 serde_json，故整体 gate
// 掉，否则 clippy -D warnings 会因 unused_imports 失败。
#[cfg(target_os = "windows")]
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::rc::Rc;
#[cfg(target_os = "windows")]
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

#[cfg(target_os = "windows")]
use vigem_client::{Client, TargetId, XGamepad, Xbox360Wired};

use crate::Command;

// ====================================================================
// 公共类型
// ====================================================================

/// 虚拟手柄状态：所有 vpad_* 共享。
///
/// Windows 实际持有 `Rc<Client>` + handle→target 映射；
/// 非 Windows 是 unit 类型（仅占位用）。
pub struct VPadState {
    #[cfg(target_os = "windows")]
    inner: VPadStateInner,
}

#[cfg(target_os = "windows")]
struct VPadStateInner {
    client: Rc<Client>,
    handles: HashMap<String, PadEntry>,
    /// 单调自增，用来生成不会撞名的 handle（`pad1`, `pad2`, …）。
    next_index: u32,
}

#[cfg(target_os = "windows")]
struct PadEntry {
    target: Xbox360Wired<Rc<Client>>,
    /// 累积状态：每次 update 都基于上一次，节省协议字节也避免「丢其他轴」。
    state: PadSnapshot,
}

#[cfg(target_os = "windows")]
#[derive(Copy, Clone, Default)]
struct PadSnapshot {
    /// XButtons 位字段，bit 含义见 `XButtons`（A/B/X/Y + D-Pad + Start/Back/L3/R3/LB/RB/Guide）。
    buttons_raw: u16,
    lt: u8,
    rt: u8,
    lx: i16,
    ly: i16,
    rx: i16,
    ry: i16,
}

// ====================================================================
// 公共入口：解析一条指令并执行。
// ====================================================================

/// 解析并执行一条 vpad_* 指令。
///
/// `state` 通常是 main.rs 里 `Option<VPadState>` 的 mutable 引用，第一次调用
/// 时本函数会自动 lazy-init（用 slot 默认 1 或 payload 里的 `vpad_slot`）。
pub fn dispatch(state: &mut Option<VPadState>, cmd: &Command) -> Result<Value, String> {
    #[cfg(target_os = "windows")]
    {
        win_dispatch(state, cmd)
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 非 Windows 无驱动状态可管理：显式丢弃避免 unused variable 警告
        let _ = state;
        non_win_dispatch(cmd)
    }
}

// ── 非 Windows stub ─────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
fn non_win_dispatch(cmd: &Command) -> Result<Value, String> {
    let platform = std::env::consts::OS;
    match cmd.action.as_str() {
        "vpad_status" => Ok(json!({
            "ok": true,
            "platform": platform,
            "driver": "unsupported",
            "bus": "unavailable",
            "slots_used": 0,
        })),
        "vpad_list" => Ok(json!({
            "ok": true,
            "handles": Vec::<String>::new(),
            "count": 0,
            "platform": platform,
        })),
        other => Err(format!(
            "vpad requires Windows; current platform: {platform}; \
             (got action {other:?}); see docs/VIGEM_FINDINGS.md"
        )),
    }
}

// ====================================================================
// Windows 实现
// ====================================================================

#[cfg(target_os = "windows")]
fn win_dispatch(state: &mut Option<VPadState>, cmd: &Command) -> Result<Value, String> {
    let action = cmd.action.as_str();
    match action {
        "vpad_status" => Ok(build_status(state)),
        "vpad_list" => Ok(build_list(state)),
        "vpad_release_all" => {
            let mut count = 0;
            if let Some(s) = state.as_mut() {
                count = s.inner.handles.len();
                s.inner.release_all();
            }
            Ok(json!({
                "ok": true,
                "msg": "all vpads released",
                "count": count,
            }))
        }
        // 需要 vpad state 的动作：**先校验参数、后再懒初始化**——与既有
        // `mouse_button` arm 的「参数全部先解析、后建连」一致。无效指令
        // 不产生任何驱动连接副作用。
        "vpad_init" | "vpad_release" | "vpad_button" | "vpad_axis" | "vpad_trigger"
        | "vpad_dpad" => {
            let parsed = parse_cmd(cmd)?;
            let init_slot = match parsed {
                Parsed::Init { slot } => slot,
                _ => 1,
            };
            ensure_state(state, init_slot)?;
            let s = state.as_mut().expect("vpad state just initialized");
            execute(s, parsed)
        }
        _ => unreachable!("dispatch only called for vpad_* actions"),
    }
}

/// 已经通过格式校验的 vpad 指令。所有字符串→枚举、数值范围检查都发生在
/// `parse_cmd`，这样调用方能在触碰驱动之前就拒绝无效报文。
#[cfg(target_os = "windows")]
enum Parsed {
    Init {
        slot: u8,
    },
    Release {
        handle: String,
    },
    Button {
        handle: String,
        button: VPadButton,
        value: bool,
    },
    Axis {
        handle: String,
        axis: VPadAxis,
        value: f32,
    },
    Trigger {
        handle: String,
        trigger: VPadTrigger,
        value: f32,
    },
    Dpad {
        handle: String,
        dir: VPadDpad,
    },
}

#[cfg(target_os = "windows")]
fn parse_cmd(cmd: &Command) -> Result<Parsed, String> {
    Ok(match cmd.action.as_str() {
        "vpad_init" => {
            // slot 范围必须在建连前先校验——否则会先跳到 driver-connect
            // （甚至先触发 install-vigembus.ps1）然后才在 allocate() 里报
            // 错，浪费一次 syscalls 副作用。跨「参数全部先解析、后建连」
            // 既有惯例一致。
            let slot = cmd.vpad_slot.unwrap_or(1);
            if !(1..=4).contains(&slot) {
                return Err(format!("vpad_init: slot must be 1..=4, got {slot}"));
            }
            Parsed::Init { slot }
        }
        "vpad_release" => Parsed::Release {
            handle: require_handle(cmd)?,
        },
        "vpad_button" => {
            let handle = require_handle(cmd)?;
            let button = parse_button(
                cmd.vpad_button
                    .as_deref()
                    .ok_or_else(|| "vpad_button requires button".to_string())?,
            )?;
            let value = cmd
                .vpad_value_bool
                .ok_or_else(|| "vpad_button requires value (bool)".to_string())?;
            Parsed::Button {
                handle,
                button,
                value,
            }
        }
        "vpad_axis" => {
            let handle = require_handle(cmd)?;
            let axis = parse_axis(
                cmd.vpad_axis
                    .as_deref()
                    .ok_or_else(|| "vpad_axis requires axis".to_string())?,
            )?;
            let value = clamp_value(cmd.vpad_value, "axis", -1.0, 1.0)?;
            Parsed::Axis {
                handle,
                axis,
                value,
            }
        }
        "vpad_trigger" => {
            let handle = require_handle(cmd)?;
            let trigger = parse_trigger(
                cmd.vpad_trigger
                    .as_deref()
                    .ok_or_else(|| "vpad_trigger requires trigger".to_string())?,
            )?;
            let value = clamp_value(cmd.vpad_value, "trigger", 0.0, 1.0)?;
            Parsed::Trigger {
                handle,
                trigger,
                value,
            }
        }
        "vpad_dpad" => {
            let handle = require_handle(cmd)?;
            let dir = parse_dpad(
                cmd.vpad_dir
                    .as_deref()
                    .ok_or_else(|| "vpad_dpad requires dir".to_string())?,
            )?;
            Parsed::Dpad { handle, dir }
        }
        other => unreachable!("parse_cmd called with non-vpad action: {other}"),
    })
}

/// 执行已校验的指令。此处只会真的碰驱动（被 `ensure_state` 建好的 state）。
#[cfg(target_os = "windows")]
fn execute(s: &mut VPadState, parsed: Parsed) -> Result<Value, String> {
    match parsed {
        Parsed::Init { slot } => {
            let handle = s.inner.allocate(slot)?;
            Ok(json!({
                "ok": true,
                "msg": "vpad ready",
                "handle": handle,
                "slot": slot,
            }))
        }
        Parsed::Release { handle } => {
            s.inner.release(&handle)?;
            Ok(json!({
                "ok": true,
                "msg": "vpad released",
                "handle": handle,
            }))
        }
        Parsed::Button {
            handle,
            button,
            value,
        } => {
            s.inner.apply_button(&handle, button, value)?;
            Ok(json!({
                "ok": true,
                "msg": "vpad button complete",
                "handle": handle,
                "button": button.name(),
                "value": value,
            }))
        }
        Parsed::Axis {
            handle,
            axis,
            value,
        } => {
            s.inner.apply_axis(&handle, axis, value)?;
            Ok(json!({
                "ok": true,
                "msg": "vpad axis complete",
                "handle": handle,
                "axis": axis.name(),
                "value": value,
            }))
        }
        Parsed::Trigger {
            handle,
            trigger,
            value,
        } => {
            s.inner.apply_trigger(&handle, trigger, value)?;
            Ok(json!({
                "ok": true,
                "msg": "vpad trigger complete",
                "handle": handle,
                "trigger": trigger.name(),
                "value": value,
            }))
        }
        Parsed::Dpad { handle, dir } => {
            s.inner.apply_dpad(&handle, dir)?;
            Ok(json!({
                "ok": true,
                "msg": "vpad dpad complete",
                "handle": handle,
                "dir": dir.name(),
            }))
        }
    }
}

#[cfg(target_os = "windows")]
fn ensure_state(state: &mut Option<VPadState>, init_slot: u8) -> Result<(), String> {
    if state.is_none() {
        let inner = VPadStateInner::try_init(init_slot)?;
        *state = Some(VPadState { inner });
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn require_handle(cmd: &Command) -> Result<String, String> {
    cmd.vpad_handle
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{} requires handle (e.g. pad1)", cmd.action))
}

#[cfg(target_os = "windows")]
fn build_status(state: &Option<VPadState>) -> Value {
    let (driver, bus, slots_used) = match state.as_ref() {
        None => ("unknown", "not_connected", 0),
        Some(s) => ("installed", "connected", s.inner.handles.len()),
    };
    json!({
        "ok": true,
        "driver": driver,
        "bus": bus,
        "slots_used": slots_used,
        "platform": "windows",
    })
}

#[cfg(target_os = "windows")]
fn build_list(state: &Option<VPadState>) -> Value {
    let (handles, count) = match state.as_ref() {
        None => (Vec::<String>::new(), 0),
        Some(s) => {
            let mut v: Vec<String> = s.inner.handles.keys().cloned().collect();
            v.sort();
            let c = v.len();
            (v, c)
        }
    };
    json!({
        "ok": true,
        "handles": handles,
        "count": count,
    })
}

#[cfg(target_os = "windows")]
fn clamp_value(v: Option<f64>, label: &str, lo: f64, hi: f64) -> Result<f32, String> {
    let v = v.ok_or_else(|| format!("{label}: missing value"))?;
    if v.is_nan() {
        return Err(format!("{label}: value is NaN"));
    }
    if v < lo || v > hi {
        return Err(format!("{label}: value out of range [{lo},{hi}]: got {v}"));
    }
    Ok(v as f32)
}

// ====================================================================
// Windows: VPadStateInner 实现
// ====================================================================

#[cfg(target_os = "windows")]
impl VPadStateInner {
    fn try_init(slot: u8) -> Result<Self, String> {
        let client = match Client::connect() {
            Ok(c) => c,
            Err(vigem_client::Error::BusNotFound) => {
                // 驱动未装：自动跑安装脚本（弹 UAC）并重试。
                // INSTALL_ATTEMPTED 是进程级门：上游若在启动期异常
                // 风暴式连发 vpad_init，把 UAC 次数也压到最多 1 次。
                // 若用户拒绝了 UAC、想再试一次，重启 input-agent 即可。
                if !install_vigembus::INSTALL_ATTEMPTED.swap(true, Ordering::SeqCst) {
                    install_vigembus::request_install()?;
                } else {
                    return Err(
                        "vigembus not installed; install already attempted this session \
                         (rejected UAC or call failed). see docs/VIGEM_FINDINGS.md"
                            .to_string(),
                    );
                }
                Client::connect().map_err(|e| {
                    format!("vigembus install claimed success but connect still fails: {e}")
                })?
            }
            Err(other) => return Err(format!("vpad_init connect failed: {other}")),
        };

        let client = Rc::new(client);
        let mut me = Self {
            client,
            handles: HashMap::new(),
            next_index: 1,
        };
        // 一次启动就建好第一个手柄（默认 slot=1）。
        me.allocate(slot)?;
        Ok(me)
    }

    fn allocate(&mut self, slot: u8) -> Result<String, String> {
        if !(1..=4).contains(&slot) {
            return Err(format!("vpad_init: slot must be 1..=4, got {slot}"));
        }
        if self.handles.len() >= 4 {
            return Err(format!(
                "vpad_init: max 4 handles, got {}",
                self.handles.len()
            ));
        }

        let handle = loop {
            let candidate = format!("pad{}", self.next_index);
            self.next_index = self.next_index.checked_add(1).expect("next_index overflow");
            if !self.handles.contains_key(&candidate) {
                break candidate;
            }
        };

        let mut target = Xbox360Wired::new(self.client.clone(), TargetId::XBOX360_WIRED);
        if let Err(e) = target.plugin() {
            return Err(format!("plugin slot {slot} failed: {e}"));
        }
        // 等驱动接管并能接 report；如果失败不致命（首次 update 仍可能收到
        // TargetNotReady），但日志上更明显。
        let _ = target.wait_ready();

        self.handles.insert(
            handle.clone(),
            PadEntry {
                target,
                state: PadSnapshot::default(),
            },
        );
        Ok(handle)
    }

    fn release(&mut self, handle: &str) -> Result<(), String> {
        if self.handles.remove(handle).is_none() {
            return Err(format!("unknown handle: {handle}"));
        }
        // drop(PadEntry) → drop(Xbox360Wired) → unplug
        Ok(())
    }

    fn release_all(&mut self) {
        self.handles.clear();
    }

    fn apply_button(
        &mut self,
        handle: &str,
        button: VPadButton,
        value: bool,
    ) -> Result<(), String> {
        let entry = self
            .handles
            .get_mut(handle)
            .ok_or_else(|| format!("unknown handle: {handle}"))?;
        let mask = button.bit();
        if value {
            entry.state.buttons_raw |= mask;
        } else {
            entry.state.buttons_raw &= !mask;
        }
        Self::submit(&mut entry.target, &entry.state)
    }

    fn apply_axis(&mut self, handle: &str, axis: VPadAxis, value: f32) -> Result<(), String> {
        // 已在 dispatch 里 clamp 过；这里再以防万一。
        let v = value.clamp(-1.0, 1.0);
        let i = (v * 32767.0).round() as i32;
        let i = i.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        let entry = self
            .handles
            .get_mut(handle)
            .ok_or_else(|| format!("unknown handle: {handle}"))?;
        match axis {
            VPadAxis::Lx => entry.state.lx = i,
            VPadAxis::Ly => entry.state.ly = i,
            VPadAxis::Rx => entry.state.rx = i,
            VPadAxis::Ry => entry.state.ry = i,
        }
        Self::submit(&mut entry.target, &entry.state)
    }

    fn apply_trigger(
        &mut self,
        handle: &str,
        trigger: VPadTrigger,
        value: f32,
    ) -> Result<(), String> {
        let v = value.clamp(0.0, 1.0);
        let u = (v * 255.0).round().clamp(0.0, 255.0) as u8;
        let entry = self
            .handles
            .get_mut(handle)
            .ok_or_else(|| format!("unknown handle: {handle}"))?;
        match trigger {
            VPadTrigger::Lt => entry.state.lt = u,
            VPadTrigger::Rt => entry.state.rt = u,
        }
        Self::submit(&mut entry.target, &entry.state)
    }

    fn apply_dpad(&mut self, handle: &str, dir: VPadDpad) -> Result<(), String> {
        // D-Pad 是 4 个独立 bit (UP=0x0001 DOWN=0x0002 LEFT=0x0004 RIGHT=0x0008)
        // 与其他按钮在同一 buttons_raw 字段；只覆盖这 4 个 bit，其他按钮保留。
        const DPAD_MASK: u16 = 0x000F;
        let entry = self
            .handles
            .get_mut(handle)
            .ok_or_else(|| format!("unknown handle: {handle}"))?;
        entry.state.buttons_raw = (entry.state.buttons_raw & !DPAD_MASK) | dir.bits();
        Self::submit(&mut entry.target, &entry.state)
    }

    fn submit(target: &mut Xbox360Wired<Rc<Client>>, st: &PadSnapshot) -> Result<(), String> {
        let gamepad = XGamepad {
            buttons: vigem_client::XButtons {
                raw: st.buttons_raw,
            },
            left_trigger: st.lt,
            right_trigger: st.rt,
            thumb_lx: st.lx,
            thumb_ly: st.ly,
            thumb_rx: st.rx,
            thumb_ry: st.ry,
        };
        target.update(&gamepad).map_err(|e| {
            // TargetNotReady 是「驱动还没准备好接 report」——等下次 update
            // 即可，不算致命。其他错误归类为硬错误。
            match e {
                vigem_client::Error::TargetNotReady => {
                    "update: target not ready yet (will retry on next call)".to_string()
                }
                other => format!("update failed: {other}"),
            }
        })
    }
}

// ====================================================================
// 按钮 / 轴 / 扳机 / 方向：协议字符串 ↔ 内部枚举
// ====================================================================

#[cfg(target_os = "windows")]
#[derive(Copy, Clone, Debug)]
enum VPadButton {
    A,
    B,
    X,
    Y,
    Lb,
    Rb,
    Back,
    Start,
    L3,
    R3,
    Guide,
}

#[cfg(target_os = "windows")]
impl VPadButton {
    fn bit(self) -> u16 {
        match self {
            Self::A => 0x1000,
            Self::B => 0x2000,
            Self::X => 0x4000,
            Self::Y => 0x8000,
            Self::Lb => 0x0100,
            Self::Rb => 0x0200,
            Self::Back => 0x0020,
            Self::Start => 0x0010,
            Self::L3 => 0x0040,
            Self::R3 => 0x0080,
            Self::Guide => 0x0400,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::A => "a",
            Self::B => "b",
            Self::X => "x",
            Self::Y => "y",
            Self::Lb => "lb",
            Self::Rb => "rb",
            Self::Back => "back",
            Self::Start => "start",
            Self::L3 => "l3",
            Self::R3 => "r3",
            Self::Guide => "guide",
        }
    }
}

#[cfg(target_os = "windows")]
fn parse_button(s: &str) -> Result<VPadButton, String> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
        "a" => VPadButton::A,
        "b" => VPadButton::B,
        "x" => VPadButton::X,
        "y" => VPadButton::Y,
        "lb" => VPadButton::Lb,
        "rb" => VPadButton::Rb,
        "back" => VPadButton::Back,
        "start" => VPadButton::Start,
        "l3" => VPadButton::L3,
        "r3" => VPadButton::R3,
        "guide" => VPadButton::Guide,
        other => {
            return Err(format!(
                "unknown button: {other:?} (valid: a,b,x,y,lb,rb,back,start,l3,r3,guide)"
            ))
        }
    })
}

#[cfg(target_os = "windows")]
#[derive(Copy, Clone, Debug)]
enum VPadAxis {
    Lx,
    Ly,
    Rx,
    Ry,
}

#[cfg(target_os = "windows")]
impl VPadAxis {
    fn name(self) -> &'static str {
        match self {
            Self::Lx => "lx",
            Self::Ly => "ly",
            Self::Rx => "rx",
            Self::Ry => "ry",
        }
    }
}

#[cfg(target_os = "windows")]
fn parse_axis(s: &str) -> Result<VPadAxis, String> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
        "lx" => VPadAxis::Lx,
        "ly" => VPadAxis::Ly,
        "rx" => VPadAxis::Rx,
        "ry" => VPadAxis::Ry,
        other => return Err(format!("unknown axis: {other:?} (valid: lx,ly,rx,ry)")),
    })
}

#[cfg(target_os = "windows")]
#[derive(Copy, Clone, Debug)]
enum VPadTrigger {
    Lt,
    Rt,
}

#[cfg(target_os = "windows")]
impl VPadTrigger {
    fn name(self) -> &'static str {
        match self {
            Self::Lt => "lt",
            Self::Rt => "rt",
        }
    }
}

#[cfg(target_os = "windows")]
fn parse_trigger(s: &str) -> Result<VPadTrigger, String> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
        "lt" => VPadTrigger::Lt,
        "rt" => VPadTrigger::Rt,
        other => return Err(format!("unknown trigger: {other:?} (valid: lt,rt)")),
    })
}

#[cfg(target_os = "windows")]
#[derive(Copy, Clone, Debug)]
enum VPadDpad {
    Up,
    Down,
    Left,
    Right,
    None,
}

#[cfg(target_os = "windows")]
impl VPadDpad {
    fn bits(self) -> u16 {
        match self {
            Self::Up => 0x0001,
            Self::Down => 0x0002,
            Self::Left => 0x0004,
            Self::Right => 0x0008,
            Self::None => 0x0000,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Left => "left",
            Self::Right => "right",
            Self::None => "none",
        }
    }
}

#[cfg(target_os = "windows")]
fn parse_dpad(s: &str) -> Result<VPadDpad, String> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
        "up" => VPadDpad::Up,
        "down" => VPadDpad::Down,
        "left" => VPadDpad::Left,
        "right" => VPadDpad::Right,
        "none" => VPadDpad::None,
        other => {
            return Err(format!(
                "unknown dpad dir: {other:?} (valid: up,down,left,right,none)"
            ))
        }
    })
}

// ====================================================================
// 安装助手（仅 Windows；非 Windows 没有这一步）
// ====================================================================

#[cfg(target_os = "windows")]
mod install_vigembus {
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::AtomicBool;

    /// 进程级单次 install 标志。vpad_init 上游风暴调用时把 UAC 弹窗
    /// 压到最多 1 次；要再次尝试需重启 input-agent 进程。
    pub(super) static INSTALL_ATTEMPTED: AtomicBool = AtomicBool::new(false);

    /// 触发 UAC 安装 ViGEmBus（幂等；已装则脚本内自行快速返回 0）。
    pub(super) fn request_install() -> Result<(), String> {
        let script = locate_script()?;
        // 选 pwsh.exe (PowerShell Core) 或 Windows PowerShell 5.1——前者是
        // 用户主动装的；找不到则回落到 powershell.exe（Windows 自带）。
        let ps_host = if Command::new("pwsh.exe")
            .arg("-NoProfile")
            .arg("-Version")
            .output()
            .is_ok()
        {
            "pwsh.exe"
        } else {
            "powershell.exe"
        };
        // 用 Start-Process -Verb RunAs 让脚本以管理员身份跑。
        // 这里不判断父进程是否已经管理员——已经管理员时 -Verb RunAs 仍是 no-op
        // 升级（直接同意则立即返回）。
        let escaped = script.to_string_lossy().replace('\'', "''");
        let ps_cmd = format!(
            "$ErrorActionPreference='Stop'; \
             $p = Start-Process -FilePath '{ps_host}' \
                    -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{escaped}') \
                    -Verb RunAs -PassThru -Wait; \
             exit $p.ExitCode"
        );
        let out = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &ps_cmd])
            .output()
            .map_err(|e| format!("spawn powershell.exe: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "install-vigembus.ps1 exited with code {:?}\nstderr: {}\n\
                 see docs/VIGEM_FINDINGS.md",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }

    fn locate_script() -> Result<PathBuf, String> {
        // 多策略寻找：dev（cargo build，<exe>/target/release/...）和生产
        // （scripts/ 与 input-agent.exe 平级）都能找到。
        // 1) exe 同级 scripts/
        // 2) exe 父目录下 scripts/（dev 布局：target/release/..）
        // 3) 向上最多 5 层的 scripts/（cargo run 等更深的路径）
        // 4) CWD 下的 scripts/
        let candidates: Vec<PathBuf> = {
            let mut v = Vec::new();
            if let Ok(exe) = std::env::current_exe() {
                let mut dir = exe.parent().map(|p| p.to_path_buf());
                for _ in 0..6 {
                    if let Some(d) = dir.as_ref() {
                        v.push(d.join("scripts/install-vigembus.ps1"));
                        dir = d.parent().map(|p| p.to_path_buf());
                    } else {
                        break;
                    }
                }
            }
            if let Ok(cwd) = std::env::current_dir() {
                v.push(cwd.join("scripts/install-vigembus.ps1"));
            }
            v
        };
        for c in candidates {
            if c.is_file() {
                return Ok(c.canonicalize().unwrap_or(c));
            }
        }
        Err(
            "install-vigembus.ps1 not found (searched near input-agent.exe and CWD); \
             manual fix: see docs/VIGEM_FINDINGS.md"
                .to_string(),
        )
    }
}

// ====================================================================
// 单测（按钮 / 轴 / 方向 字符串解析；与平台无关）
// ====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "windows"))]
    fn cmd_vpad(action: &str) -> Command {
        // 非 Windows 上 vpad_* 字段不存在（Windows-only cfg），只喂 action。
        serde_json::from_str(&format!(r#"{{"action":"{action}"}}"#)).expect("parse test command")
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn button_parses_canonical() {
        for (s, expected_name) in [
            ("a", "a"),
            ("B", "b"),
            ("x", "x"),
            ("Y", "y"),
            ("lb", "lb"),
            ("rb", "rb"),
            ("back", "back"),
            ("start", "start"),
            ("l3", "l3"),
            ("r3", "r3"),
            ("guide", "guide"),
        ] {
            let b = parse_button(s).expect(s);
            assert_eq!(b.name(), expected_name);
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn button_rejects_unknown() {
        for bad in ["foo", "", "  ", "A_button"] {
            assert!(parse_button(bad).is_err(), "{bad:?} should fail");
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn axis_parses_and_rejects() {
        for s in ["lx", "LY", "rx", "Ry"] {
            parse_axis(s).expect(s);
        }
        for bad in ["x", "lt", ""] {
            assert!(parse_axis(bad).is_err(), "{bad:?} should fail");
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn trigger_parses_and_rejects() {
        for s in ["lt", "RT"] {
            parse_trigger(s).expect(s);
        }
        for bad in ["l", "r2", ""] {
            assert!(parse_trigger(bad).is_err(), "{bad:?} should fail");
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn dpad_parses_and_rejects() {
        for s in ["up", "DOWN", "left", "right", "none"] {
            parse_dpad(s).expect(s);
        }
        for bad in ["center", "", "u"] {
            assert!(parse_dpad(bad).is_err(), "{bad:?} should fail");
        }
    }

    // vpad_* 字段是 Windows-only 协议表面（见 main.rs Command 的 cfg 注释），
    // 故这组单测同样只在 Windows 编译。
    #[test]
    #[cfg(target_os = "windows")]
    fn command_parses_vpad_payload_fields() {
        let c: Command = serde_json::from_str(
            r#"{"action":"vpad_button","vpad_handle":"pad1","vpad_button":"a","vpad_value_bool":true}"#,
        )
        .expect("parse ok");
        assert_eq!(c.action, "vpad_button");
        assert_eq!(c.vpad_handle.as_deref(), Some("pad1"));
        assert_eq!(c.vpad_button.as_deref(), Some("a"));
        assert_eq!(c.vpad_value_bool, Some(true));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn command_parses_vpad_axis_payload() {
        let c: Command = serde_json::from_str(
            r#"{"action":"vpad_axis","vpad_handle":"pad1","vpad_axis":"lx","vpad_value":0.5}"#,
        )
        .expect("parse ok");
        assert_eq!(c.action, "vpad_axis");
        assert_eq!(c.vpad_axis.as_deref(), Some("lx"));
        assert_eq!(c.vpad_value, Some(0.5));
    }

    // non-Windows stub 返回「不支持」字样
    #[test]
    #[cfg(not(target_os = "windows"))]
    fn non_win_status_includes_platform() {
        let c = cmd_vpad("vpad_status");
        let v = dispatch(&mut None, &c).expect("status ok");
        assert_eq!(v["ok"], serde_json::Value::Bool(true));
        assert_eq!(v["driver"], "unsupported");
        assert!(v["platform"].as_str().is_some());
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn non_win_button_fails() {
        let c = cmd_vpad("vpad_button");
        let err = dispatch(&mut None, &c).unwrap_err();
        assert!(err.contains("vpad requires Windows"));
    }
}
