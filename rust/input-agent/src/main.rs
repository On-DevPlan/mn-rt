//! RemoteType input-agent
//!
//! 一个极简的「字符注入」子进程。设计约束（见需求文档 4.3）：
//!   * 只从 stdin 逐行读取 JSON 指令，`\n` 分隔；
//!   * 支持 `type_text` / `backspace` / `hotkey` / `ping` / `focus` 指令；
//!   * 不含任何网络 / 业务逻辑；
//!   * 每条指令向 stdout 输出一行结果 JSON；
//!   * 解析失败或注入异常写 stderr，然后继续等待下一条指令（不退出）；
//!   * 长文本自动分片 + 片间延时，规避部分软件的丢字符问题；
//!   * 收到 SIGTERM / SIGINT 时安全退出。
//!   * 对齐模式（v0.3.0+）支持 `expect_focus` 校验：焦点漂移时拒绝注入
//!     并回 `focus_drift` + 当前焦点，让 Node 端暂停会话保护目标输入框。
//!     仅 Windows / Linux（X11）支持；macOS 暂时无法识别焦点，行为同旧版
//!     ——优雅降级，绝不因识别能力缺失而阻塞合法注入。
//!
//! 协议（Node -> Rust，stdin）:  {"action":"type_text","text":"..."}
//!       （Node -> Rust，stdin）:  {"action":"type_text","text":"...","enter_mode":"shift_enter"}
//!       （Node -> Rust，stdin）:  {"action":"backspace","count":N}
//!       （Node -> Rust，stdin）:  {"action":"hotkey","key":"return","modifiers":["shift"]}
//!       （Node -> Rust，stdin）:  {"action":"ping"}
//! 协议（Rust -> Node，stdout）: {"ok":true,"msg":"input complete"}
//!                               {"ok":true,"msg":"backspace complete","count":N}
//!                               {"ok":true,"msg":"hotkey complete","combo":"shift+return"}
//!                               {"ok":false,"msg":"reason"}
//!
//! 关于 enigo 版本：需求文档写的 0.1.30 不存在，本项目使用 0.6.1。
//! 0.6.x 的 API 为 `Enigo::new(&Settings::default())` + `Keyboard::text()`。
//! 实测（X11 + Xvfb + xev）确认 `text()` 可正确注入中文等 Unicode 字符。
//! 详见 docs/ENIGO_FINDINGS.md。
//!
//! 【重要】绕过 xkeysym 的 Unicode 映射缺陷
//! ────────────────────────────────────────
//! enigo 对 `Key::Unicode(c)` 会调用 `xkeysym::Keysym::from_char(c)`。
//! 而 xkeysym 0.2.1 的 KEYSYMTAB 里存在这样一条「历史遗留」映射：
//!
//!     CodePair { keysym: 0x04a1, ucs: 0x3002 }   // kana_fullstop 。 IDEOGRAPHIC FULL STOP
//!
//! 也就是说，**中文句号「。」(U+3002) 会被错误地映射成 0x04a1
//! (kana_fullstop，日文假名句点)**，而不是正确的 Unicode keysym 0x01003002。
//! 实测中「。」在目标窗口里变成错误字符或直接丢失。
//!
//! 由于「。」在中文写作里出现频率极高，这里通过一段自实现的注入逻辑绕过：
//! 对这类字符直接使用 enigo 的底层 `key(_, Direction)` 无解（同样走转换表），
//! 因此改为**逐字符发送 Unicode keysym**，并在发送前对已知错误表项做纠正。
//!
//! 具体做法见 `keysym_for_char()`：优先采用 X11 规范的
//! 「Unicode keysym = 0x01000000 + codepoint」编码，
//! 仅对确实需要传统 keysym 的字符（拉丁字母、常用标点）保留原表映射，
//! 从而彻底回避 KEYSYMTAB 中 U+3002 等错误条目。
//!
//! 【换行与组合键】
//! ────────────────
//! 「Enter=发送」的输入框（IM、部分 Web 聊天框）里，把 '\n' 当普通字符注入
//! 会被目标程序当成「发送」。因此 v0.5.0 起 type_text 支持 enter_mode：
//! '\n' 不再混入字符流，而是按段注入后在段间显式敲键：
//!   * "enter"       → 单击 Enter；
//!   * "shift_enter" → 按住 Shift 单击 Enter（多数 IM 的换行快捷键）；
//!   * 缺省 "raw"    → 维持旧行为，老客户端完全不受影响。
//!
//! 另提供独立的 hotkey 指令注入任意「修饰键 + 主键」组合（Ctrl+A、
//! Shift+Enter…）。时序：修饰键 Press → 小延时 → 主键 Click → 逆序 Release。
//! 与 backspace 同理，键事件失败不做重试：失败的按键可能实际已送达，
//! 重试有多发风险（聊天框里 = 误发消息），宁少勿多，由上层决定整条重发。

use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::Deserialize;
use serde_json::json;

mod focus;

/// 单次注入的最大字符数。超过则分片，片间让出时间给目标程序的消息循环。
/// 取值偏小是刻意的：部分 IDE / 终端在一口气注入大量字符时会丢字。
const CHUNK_SIZE: usize = 32;
/// 分片之间的基础延时（毫秒）。
const CHUNK_DELAY_MS: u64 = 25;
/// 超过该长度的文本被认为「较长」，使用更高的片间延时。
const LONG_TEXT_THRESHOLD: usize = 400;
/// 长文本使用的片间延时（毫秒）。
const LONG_TEXT_DELAY_MS: u64 = 45;
/// 单个分片注入失败时的重试次数。
const CHUNK_RETRY: usize = 3;
/// backspace 单条指令的最大次数上限（防御异常大值，10k 次 ≈ 足够清空任何合理文本）。
const BACKSPACE_MAX: usize = 10_000;
/// 相邻两次退格之间的延时（毫秒）：目标程序需要时间处理删除。
const BACKSPACE_DELAY_MS: u64 = 10;
/// 组合键里相邻按键事件之间的延时（毫秒）。
/// 修饰键按下 / 主键敲击 / 松开之间留出间隙：部分应用（Electron、IME
/// 活跃时）对同一毫秒内连发的键事件处理不稳。
const HOTKEY_DELAY_MS: u64 = 15;

/// type_text 中 '\n' 的处理方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum EnterMode {
    /// 缺省：维持旧行为，'\n' 作为普通字符混在分片里由 enigo 处理。
    #[default]
    Raw,
    /// '\n' 处显式单击 Enter 键。
    Enter,
    /// '\n' 处敲 Shift+Enter：「Enter=发送」的输入框里换行的标准手法。
    ShiftEnter,
}

impl EnterMode {
    /// 解析 enter_mode 字段。未知取值报错而非静默回退——
    /// Node 侧拼错单词时宁可立即失败，也不能误以为换行已正确处理。
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value {
            None | Some("") | Some("raw") => Ok(Self::Raw),
            Some("enter") => Ok(Self::Enter),
            Some("shift_enter") => Ok(Self::ShiftEnter),
            Some(other) => Err(format!(
                "invalid enter_mode: {other:?} (expected raw | enter | shift_enter)"
            )),
        }
    }
}

/// 来自 Node 的指令。使用 `Option` 兜底可选字段。
#[derive(Debug, Deserialize)]
struct Command {
    action: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    count: Option<usize>,
    /// 对齐模式：期望的焦点标识（首条成功注入的窗口）。与 `focus::current_focus()`
    /// 不符则拒绝注入，避免打进用户已经切走的输入框。空 / None = 不校验。
    /// v0.4.0 起校验逻辑停用（见 handle_line 的 type_text 分支），字段仅为
    /// 兼容旧版客户端的报文而保留，故允许 dead_code。
    #[serde(default)]
    #[allow(dead_code)]
    expect_focus: Option<String>,
    /// type_text：'\n' 的换行方式，见 `EnterMode`。缺省 raw（旧行为）。
    #[serde(default)]
    enter_mode: Option<String>,
    /// hotkey：主键名（"return" / "tab" / "a" / "f5" …），见 `parse_key_name`。
    #[serde(default)]
    key: Option<String>,
    /// hotkey：修饰键列表（shift / ctrl / alt / meta，顺序无关，别名见
    /// `parse_modifier_name`）。
    #[serde(default)]
    modifiers: Option<Vec<String>>,
}

/// 注入前的焦点校验。
/// v0.4.0 起废弃：用户切焦点时直接注入到当前焦点（不再有 drift 拒绝）。
/// 保留函数体以备未来重新引入校验逻辑（比如按应用白名单、按进程等）。
#[allow(dead_code)]
fn check_focus(expect: &Option<String>) -> Option<String> {
    let expected = expect.as_deref()?;
    if expected.is_empty() {
        return None;
    }
    match focus::current_focus() {
        Some(cur) if cur != expected => Some(cur),
        _ => None,
    }
}

/// 向 stdout 写一行 JSON 结果。
/// stdout 是本进程的协议通道，必须立即 flush，否则 Node 侧会等到超时。
fn emit(value: serde_json::Value) {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    let line = serde_json::to_string(&value)
        .unwrap_or_else(|_| String::from(r#"{"ok":false,"msg":"serialize error"}"#));
    let _ = writeln!(lock, "{}", line);
    let _ = lock.flush();
}

/// 向 stderr 打印一条诊断日志（不影响协议通道）。
fn log_err(msg: &str) {
    let stderr = io::stderr();
    let mut lock = stderr.lock();
    let _ = writeln!(lock, "[input-agent] {}", msg);
    let _ = lock.flush();
}

/// 判断某个字符是否应被丢弃。
///
/// 换行与制表符保留（语音文本里通常是有效分隔）；其余 Unicode 控制字符
/// 属于不可见字符，既无输入价值，也可能触发目标程序的特殊行为。
fn is_droppable(c: char) -> bool {
    match c {
        '\n' | '\t' => false,
        _ => c.is_control(),
    }
}

/// 创建 Enigo 实例。
///
/// `fast_text` 在 X11 上不可用（enigo 会返回 None 并自动回退到逐字符
/// `key(Key::Unicode(c), Click)`），因此 `text()` 对中文同样有效。
fn new_enigo() -> Result<Enigo, String> {
    // open_prompt_to_get_permissions 仅在 macOS 有意义，默认 true 已是所需行为。
    let settings = Settings::default();
    Enigo::new(&settings).map_err(|e| format!("enigo init failed: {e}"))
}

/// 懒初始化并复用 Enigo 连接。
///
/// 每次新建会重新建立 X11 连接（较慢），而长时间存活本身是安全的。
/// 若实例不可用（如注入过程中连接失效），上层会销毁实例并在下一条指令重建。
fn ensure_enigo(slot: &mut Option<Enigo>) -> Result<&mut Enigo, String> {
    if slot.is_none() {
        *slot = Some(new_enigo()?);
    }
    Ok(slot.as_mut().expect("enigo just initialized"))
}

/// 按文本总长度选择片间延时（毫秒）。
fn chunk_delay_ms(total: usize) -> u64 {
    if total > LONG_TEXT_THRESHOLD {
        LONG_TEXT_DELAY_MS
    } else {
        CHUNK_DELAY_MS
    }
}

/// 注入单个分片（≤ CHUNK_SIZE 个字符），失败重试 CHUNK_RETRY 次。
/// 文本重试是安全的：enigo 报错通常意味着该片根本没送达。
fn type_piece(enigo: &mut Enigo, piece: &str, delay_ms: u64, offset: usize) -> Result<(), String> {
    let mut attempt = 0;
    loop {
        match enigo.text(piece) {
            Ok(()) => return Ok(()),
            Err(e) => {
                attempt += 1;
                if attempt >= CHUNK_RETRY {
                    return Err(format!(
                        "inject failed at offset {offset} after {attempt} attempts: {e}"
                    ));
                }
                log_err(&format!(
                    "chunk at offset {offset} failed ({e}), retry {attempt}/{CHUNK_RETRY}"
                ));
                thread::sleep(Duration::from_millis(delay_ms * 2));
            }
        }
    }
}

/// 执行一次文本注入。返回注入的字符数。
fn type_text(enigo: &mut Enigo, raw: &str, mode: EnterMode) -> Result<usize, String> {
    match mode {
        EnterMode::Raw => type_text_raw(enigo, raw),
        EnterMode::Enter | EnterMode::ShiftEnter => type_text_keyed_enter(enigo, raw, mode),
    }
}

/// 旧版路径：'\n' 作为普通字符混在分片里注入。
fn type_text_raw(enigo: &mut Enigo, raw: &str) -> Result<usize, String> {
    // 1) 过滤不可见控制字符
    let cleaned: String = raw.chars().filter(|c| !is_droppable(*c)).collect();
    if cleaned.is_empty() {
        return Err("empty text after filtering".to_string());
    }

    let chars: Vec<char> = cleaned.chars().collect();
    let total = chars.len();
    let delay_ms = chunk_delay_ms(total);

    // 2) 分片注入
    let mut injected = 0usize;
    for chunk in chars.chunks(CHUNK_SIZE) {
        let piece: String = chunk.iter().collect();
        type_piece(enigo, &piece, delay_ms, injected)?;

        injected += chunk.len();
        // 最后一片不必再等
        if injected < total {
            thread::sleep(Duration::from_millis(delay_ms));
        }
    }

    log_err(&format!(
        "typed {total} chars (chunk={CHUNK_SIZE}, delay={delay_ms}ms)"
    ));
    Ok(total)
}

/// 显式敲键的换行路径：按 '\n' 切段，段内沿用分片注入，段间 `inject_enter`。
///
/// 连续多个 '\n' 会产生空段 → 对应「空行」，正好是预期语义；
/// 只包含换行的指令（如 text="\n"）也合法：不输入字符、仅敲换行键。
fn type_text_keyed_enter(enigo: &mut Enigo, raw: &str, mode: EnterMode) -> Result<usize, String> {
    let segments: Vec<&str> = raw.split('\n').collect();
    let last = segments.len() - 1;
    let delay_ms = chunk_delay_ms(raw.chars().filter(|c| !is_droppable(*c)).count());

    let mut injected = 0usize;
    for (i, segment) in segments.iter().enumerate() {
        // 逐段过滤：'\n' 已是分隔符，不会进入任何段
        let cleaned: String = segment.chars().filter(|c| !is_droppable(*c)).collect();
        let chars: Vec<char> = cleaned.chars().collect();
        let chunks: Vec<&[char]> = chars.chunks(CHUNK_SIZE).collect();

        for (j, chunk) in chunks.iter().enumerate() {
            let piece: String = chunk.iter().collect();
            type_piece(enigo, &piece, delay_ms, injected)?;

            injected += chunk.len();
            // 段内片间照常让出时间；段尾由下面的敲键动作自然停顿，不再额外等待
            if j + 1 < chunks.len() {
                thread::sleep(Duration::from_millis(delay_ms));
            }
        }

        if i < last {
            inject_enter(enigo, mode)?;
        }
    }

    log_err(&format!(
        "typed {injected} chars + {last} enter(s) (mode={mode:?})"
    ));
    Ok(injected)
}

/// 敲一次换行键；ShiftEnter 模式先按住 Shift 再敲 Return。
///
/// 与 backspace 同理不做重试：失败的按键可能实际已送达目标程序，
/// 重试会造成多发（聊天框里 = 误发消息）。宁少勿多，由上层决定整条重发。
/// 无论主键结果如何都必须松开 Shift——卡死的修饰键会污染后续所有输入。
fn inject_enter(enigo: &mut Enigo, mode: EnterMode) -> Result<(), String> {
    if mode != EnterMode::ShiftEnter {
        return enigo
            .key(Key::Return, Direction::Click)
            .map_err(|e| format!("enter failed: {e}"));
    }

    enigo
        .key(Key::Shift, Direction::Press)
        .map_err(|e| format!("press shift failed: {e}"))?;
    thread::sleep(Duration::from_millis(HOTKEY_DELAY_MS));

    let result = enigo
        .key(Key::Return, Direction::Click)
        .map_err(|e| format!("enter failed: {e}"));

    if let Err(e) = enigo.key(Key::Shift, Direction::Release) {
        // 松开失败说明底层连接已坏：上报让上层丢弃实例重建
        //（Enigo 的 Drop 也会兜底松开按住的键）
        let msg = format!("release shift failed: {e}");
        log_err(&msg);
        return Err(msg);
    }
    thread::sleep(Duration::from_millis(HOTKEY_DELAY_MS));

    result
}

/// 防御性收敛 backspace 次数：缺失按 0 处理，超上限截断。
fn clamp_backspace_count(count: Option<usize>) -> usize {
    count.unwrap_or(0).min(BACKSPACE_MAX)
}

/// 执行 N 次退格（relay 对齐模式的删除原语）。
///
/// 不做重试：重试会导致多删（宁少勿多，上层 mirror 会自愈）。
/// 返回实际发送的退格次数。
fn backspace_n(enigo: &mut Enigo, count: usize) -> Result<usize, String> {
    for i in 0..count {
        enigo
            .key(Key::Backspace, Direction::Click)
            .map_err(|e| format!("backspace {}/{} failed: {e}", i + 1, count))?;
        if i + 1 < count {
            thread::sleep(Duration::from_millis(BACKSPACE_DELAY_MS));
        }
    }
    log_err(&format!("sent {count} backspaces"));
    Ok(count)
}

/// hotkey 主键名 → enigo Key。命名风格贴近 W3C KeyboardEvent 的常用小写
/// 叫法，Node 侧可直接透传。字母 / 数字走 Key::Unicode——修饰键组合下
/// 行为正确（如 Ctrl + "a" = 全选）。
fn parse_key_name(name: &str) -> Result<Key, String> {
    match name {
        "return" | "enter" => Ok(Key::Return),
        "tab" => Ok(Key::Tab),
        "escape" | "esc" => Ok(Key::Escape),
        "backspace" => Ok(Key::Backspace),
        "delete" | "del" => Ok(Key::Delete),
        "space" => Ok(Key::Space),
        "insert" => Ok(Key::Insert),
        "home" => Ok(Key::Home),
        "end" => Ok(Key::End),
        "pageup" => Ok(Key::PageUp),
        "pagedown" => Ok(Key::PageDown),
        "up" => Ok(Key::UpArrow),
        "down" => Ok(Key::DownArrow),
        "left" => Ok(Key::LeftArrow),
        "right" => Ok(Key::RightArrow),
        other => {
            if let Some(key) = function_key(other) {
                return Ok(key);
            }
            // 单字符：字母 / 数字 / 常用符号，统一小写。
            // 想要大写请走 modifiers:["shift"]，而不是传 "A"。
            let mut chars = other.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                if c.is_ascii_graphic() {
                    return Ok(Key::Unicode(c.to_ascii_lowercase()));
                }
            }
            Err(format!("unknown hotkey key: {other:?}"))
        }
    }
}

/// "f1".."f12" → 功能键。显式枚举而非算术转换：enigo 的 Key 没有数值语义。
fn function_key(name: &str) -> Option<Key> {
    let n: usize = name.strip_prefix('f')?.parse().ok()?;
    Some(match n {
        1 => Key::F1,
        2 => Key::F2,
        3 => Key::F3,
        4 => Key::F4,
        5 => Key::F5,
        6 => Key::F6,
        7 => Key::F7,
        8 => Key::F8,
        9 => Key::F9,
        10 => Key::F10,
        11 => Key::F11,
        12 => Key::F12,
        _ => return None,
    })
}

/// hotkey 修饰键名 → enigo Key。提供常用别名，Node 侧可直接透传
/// KeyboardEvent 里的叫法。
fn parse_modifier_name(name: &str) -> Result<Key, String> {
    match name {
        "shift" => Ok(Key::Shift),
        "ctrl" | "control" => Ok(Key::Control),
        "alt" | "option" => Ok(Key::Alt),
        "meta" | "cmd" | "win" | "super" => Ok(Key::Meta),
        other => Err(format!("unknown hotkey modifier: {other:?}")),
    }
}

/// 注入一次组合键：修饰键依次按下 → 主键单击 → 修饰键逆序松开。
///
/// 修饰键松开失败必须上报（比主键失败更严重：卡死的修饰键会污染
/// 后续所有输入），Enigo 的 Drop 亦会兜底松键。
fn press_combo(enigo: &mut Enigo, main: Key, modifiers: &[Key]) -> Result<(), String> {
    for m in modifiers {
        enigo
            .key(*m, Direction::Press)
            .map_err(|e| format!("press modifier failed: {e}"))?;
        thread::sleep(Duration::from_millis(HOTKEY_DELAY_MS));
    }

    let result = enigo
        .key(main, Direction::Click)
        .map_err(|e| format!("hotkey click failed: {e}"));

    for m in modifiers.iter().rev() {
        if let Err(e) = enigo.key(*m, Direction::Release) {
            let msg = format!("release modifier failed: {e}");
            log_err(&msg);
            return Err(msg);
        }
        thread::sleep(Duration::from_millis(HOTKEY_DELAY_MS));
    }

    result
}

/// 处理单条指令。所有错误都转成结果 JSON，保证主循环不因单条指令退出。
fn handle_line(line: &str, enigo: &mut Option<Enigo>) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return; // 空行直接忽略
    }

    let cmd: Command = match serde_json::from_str(trimmed) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("invalid json: {e}");
            log_err(&msg);
            emit(json!({ "ok": false, "msg": msg }));
            return;
        }
    };

    match cmd.action.as_str() {
        "type_text" => {
            // v0.4.0 起去掉焦点校验：用户手动切焦点时直接注入到当前焦点（alignment
            // 安全网被有意关闭）。expect_focus 字段保留兼容旧版客户端，忽略即可。
            // enter_mode 先于 Enigo 初始化校验：参数错误不值得付出建连成本。
            let mode = match EnterMode::parse(cmd.enter_mode.as_deref()) {
                Ok(m) => m,
                Err(msg) => {
                    log_err(&msg);
                    emit(json!({ "ok": false, "msg": msg }));
                    return;
                }
            };
            let text = cmd.text.unwrap_or_default();

            let instance = match ensure_enigo(enigo) {
                Ok(e) => e,
                Err(msg) => {
                    log_err(&msg);
                    emit(json!({ "ok": false, "msg": msg }));
                    return;
                }
            };

            match type_text(instance, &text, mode) {
                Ok(n) => emit(json!({ "ok": true, "msg": "input complete", "chars": n })),
                Err(reason) => {
                    log_err(&reason);
                    // 注入失败可能意味着底层连接已损坏，丢弃实例以便下条重建
                    *enigo = None;
                    emit(json!({ "ok": false, "msg": reason }));
                }
            }
        }
        "backspace" => {
            let count = clamp_backspace_count(cmd.count);
            if count == 0 {
                emit(json!({ "ok": true, "msg": "backspace complete", "count": 0 }));
                return;
            }

            let instance = match ensure_enigo(enigo) {
                Ok(e) => e,
                Err(msg) => {
                    log_err(&msg);
                    emit(json!({ "ok": false, "msg": msg }));
                    return;
                }
            };

            match backspace_n(instance, count) {
                Ok(n) => emit(json!({ "ok": true, "msg": "backspace complete", "count": n })),
                Err(reason) => {
                    log_err(&reason);
                    *enigo = None;
                    emit(json!({ "ok": false, "msg": reason }));
                }
            }
        }
        "hotkey" => {
            // 任意「修饰键 + 主键」组合：Ctrl+A 全选、Shift+Enter 换行等。
            // 参数全部先解析、后建连，无效指令不产生任何按键。
            let key_name = cmd.key.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let Some(key_name) = key_name else {
                let msg = "hotkey requires key";
                log_err(msg);
                emit(json!({ "ok": false, "msg": msg }));
                return;
            };
            let key_name = key_name.to_ascii_lowercase();

            let mut mod_names: Vec<String> = Vec::new();
            let mut modifiers: Vec<Key> = Vec::new();
            for name in cmd.modifiers.unwrap_or_default() {
                let norm = name.trim().to_ascii_lowercase();
                if norm.is_empty() {
                    continue;
                }
                match parse_modifier_name(&norm) {
                    Ok(k) => {
                        mod_names.push(norm);
                        modifiers.push(k);
                    }
                    Err(msg) => {
                        log_err(&msg);
                        emit(json!({ "ok": false, "msg": msg }));
                        return;
                    }
                }
            }

            let main_key = match parse_key_name(&key_name) {
                Ok(k) => k,
                Err(msg) => {
                    log_err(&msg);
                    emit(json!({ "ok": false, "msg": msg }));
                    return;
                }
            };

            let instance = match ensure_enigo(enigo) {
                Ok(e) => e,
                Err(msg) => {
                    log_err(&msg);
                    emit(json!({ "ok": false, "msg": msg }));
                    return;
                }
            };

            match press_combo(instance, main_key, &modifiers) {
                Ok(()) => emit(json!({
                    "ok": true,
                    "msg": "hotkey complete",
                    "combo": if mod_names.is_empty() {
                        key_name
                    } else {
                        format!("{}+{}", mod_names.join("+"), key_name)
                    }
                })),
                Err(reason) => {
                    log_err(&reason);
                    *enigo = None;
                    emit(json!({ "ok": false, "msg": reason }));
                }
            }
        }
        "ping" => {
            // 心跳指令：仅用于 Node 侧判断子进程是否卡死。
            // 注意：这里不构造 Enigo，避免在无图形环境下心跳也失败。
            emit(json!({ "ok": true, "msg": "pong" }));
        }
        "focus" => {
            // 旧版焦点轮询指令的兼容保留：v0.4.0 客户端不再调用此 action，
            // 但若旧版客户端连上来，回 ok 让其健康检查过——查询返回 null 也无害
            emit(json!({ "ok": true, "focus": focus::current_focus() }));
        }
        other => {
            let msg = format!("unknown action: {other}");
            log_err(&msg);
            emit(json!({ "ok": false, "msg": msg }));
        }
    }
}

/// 注册 SIGTERM / SIGINT 处理：置位运行标志，让主循环自然退出。
///
/// 刻意不引入 `ctrlc` / `signal-hook` 依赖，直接用 libc `signal()`，
/// 保持二进制体积最小、依赖最少。
#[cfg(unix)]
fn install_signal_handlers(flag: Arc<AtomicBool>) {
    static FLAG_PTR: AtomicUsize = AtomicUsize::new(0);

    extern "C" fn on_signal(_sig: i32) {
        let ptr = FLAG_PTR.load(Ordering::SeqCst) as *const AtomicBool;
        if !ptr.is_null() {
            let flag = unsafe { &*ptr };
            flag.store(true, Ordering::SeqCst);
        }
    }

    let raw = Arc::into_raw(flag) as usize;
    FLAG_PTR.store(raw, Ordering::SeqCst);

    extern "C" {
        fn signal(signum: i32, handler: usize) -> usize;
    }
    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;
    unsafe {
        signal(SIGTERM, on_signal as *const () as usize);
        signal(SIGINT, on_signal as *const () as usize);
    }
}

#[cfg(not(unix))]
fn install_signal_handlers(_flag: Arc<AtomicBool>) {
    // Windows 下由 Node 侧关闭 stdin / TerminateProcess 处理，无需额外逻辑。
}

fn main() {
    let running = Arc::new(AtomicBool::new(true));
    install_signal_handlers(running.clone());

    let stdin = io::stdin();
    let reader = stdin.lock();

    log_err("input-agent started, waiting for commands on stdin");

    let mut enigo: Option<Enigo> = None;

    for line in reader.lines() {
        if !running.load(Ordering::SeqCst) {
            log_err("termination signal received, exiting");
            break;
        }
        match line {
            Ok(l) => handle_line(&l, &mut enigo),
            Err(e) => {
                // stdin 读错误通常意味着父进程已关闭管道，直接退出。
                log_err(&format!("stdin read error: {e}"));
                break;
            }
        }
    }

    // 释放 Enigo：其 Drop 会松开仍按住的按键，避免遗留按键状态。
    drop(enigo);
    log_err("input-agent stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backspace_count_defaults_to_zero_when_missing() {
        assert_eq!(clamp_backspace_count(None), 0);
    }

    #[test]
    fn backspace_count_passes_through_normal_values() {
        assert_eq!(clamp_backspace_count(Some(1)), 1);
        assert_eq!(clamp_backspace_count(Some(BACKSPACE_MAX)), BACKSPACE_MAX);
    }

    #[test]
    fn backspace_count_caps_absurd_values() {
        assert_eq!(clamp_backspace_count(Some(usize::MAX)), BACKSPACE_MAX);
        assert_eq!(clamp_backspace_count(Some(999_999)), BACKSPACE_MAX);
    }

    #[test]
    fn command_parses_backspace_action() {
        let cmd: Command =
            serde_json::from_str(r#"{"action":"backspace","count":42}"#).expect("parse ok");
        assert_eq!(cmd.action, "backspace");
        assert_eq!(clamp_backspace_count(cmd.count), 42);
    }

    #[test]
    fn command_parses_without_optional_fields() {
        let cmd: Command = serde_json::from_str(r#"{"action":"ping"}"#).expect("parse ok");
        assert_eq!(cmd.action, "ping");
        assert!(cmd.text.is_none());
        assert!(cmd.count.is_none());
    }

    // ── enter_mode ──────────────────────────────────────────────────────

    #[test]
    fn enter_mode_defaults_to_raw() {
        assert_eq!(EnterMode::parse(None), Ok(EnterMode::Raw));
        assert_eq!(EnterMode::parse(Some("")), Ok(EnterMode::Raw));
        assert_eq!(EnterMode::parse(Some("raw")), Ok(EnterMode::Raw));
    }

    #[test]
    fn enter_mode_parses_keyed_variants() {
        assert_eq!(EnterMode::parse(Some("enter")), Ok(EnterMode::Enter));
        assert_eq!(
            EnterMode::parse(Some("shift_enter")),
            Ok(EnterMode::ShiftEnter)
        );
    }

    #[test]
    fn enter_mode_rejects_unknown_values() {
        // 常见拼写错误必须报错而不是静默回退，否则换行会打进「发送」
        for bad in ["shift+enter", "shiftenter", "Shift_Enter", "newline"] {
            assert!(EnterMode::parse(Some(bad)).is_err(), "{bad:?} should fail");
        }
    }

    #[test]
    fn command_parses_enter_mode() {
        let cmd: Command = serde_json::from_str(
            r#"{"action":"type_text","text":"a\nb","enter_mode":"shift_enter"}"#,
        )
        .expect("parse ok");
        assert_eq!(cmd.enter_mode.as_deref(), Some("shift_enter"));
    }

    // ── hotkey 键名解析 ─────────────────────────────────────────────────

    #[test]
    fn key_names_map_to_enigo_keys() {
        assert_eq!(parse_key_name("return"), Ok(Key::Return));
        assert_eq!(parse_key_name("enter"), Ok(Key::Return));
        assert_eq!(parse_key_name("esc"), Ok(Key::Escape));
        assert_eq!(parse_key_name("pageup"), Ok(Key::PageUp));
        assert_eq!(parse_key_name("up"), Ok(Key::UpArrow));
        assert_eq!(parse_key_name("f12"), Ok(Key::F12));
        assert_eq!(parse_key_name("space"), Ok(Key::Space));
    }

    #[test]
    fn single_chars_map_to_unicode_keys() {
        assert_eq!(parse_key_name("a"), Ok(Key::Unicode('a')));
        // 大写字母统一归一化为小写：大写语义交给 shift 修饰键表达
        assert_eq!(parse_key_name("A"), Ok(Key::Unicode('a')));
        assert_eq!(parse_key_name("5"), Ok(Key::Unicode('5')));
    }

    #[test]
    fn key_names_reject_unknown() {
        // "shift" 是修饰键不是主键
        assert!(parse_key_name("shift").is_err());
        assert!(parse_key_name("f13").is_err());
        assert!(parse_key_name("").is_err());
        assert!(parse_key_name("foobar").is_err());
    }

    #[test]
    fn modifier_names_map_with_aliases() {
        assert_eq!(parse_modifier_name("shift"), Ok(Key::Shift));
        assert_eq!(parse_modifier_name("ctrl"), Ok(Key::Control));
        assert_eq!(parse_modifier_name("control"), Ok(Key::Control));
        assert_eq!(parse_modifier_name("option"), Ok(Key::Alt));
        assert_eq!(parse_modifier_name("win"), Ok(Key::Meta));
        assert_eq!(parse_modifier_name("cmd"), Ok(Key::Meta));
    }

    #[test]
    fn modifier_names_reject_unknown() {
        assert!(parse_modifier_name("return").is_err());
        assert!(parse_modifier_name("hyper").is_err());
    }

    #[test]
    fn command_parses_hotkey_fields() {
        let cmd: Command =
            serde_json::from_str(r#"{"action":"hotkey","key":"return","modifiers":["shift"]}"#)
                .expect("parse ok");
        assert_eq!(cmd.key.as_deref(), Some("return"));
        assert_eq!(cmd.modifiers, Some(vec!["shift".to_string()]));
    }
}
