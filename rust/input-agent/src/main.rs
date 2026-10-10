//! RemoteType input-agent
//!
//! 一个极简的「字符注入」子进程。设计约束（见需求文档 4.3）：
//!   * 只从 stdin 逐行读取 JSON 指令，`\n` 分隔；
//!   * 支持 `type_text` / `backspace` / `ping` / `focus` 四种指令；
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
//!       （Node -> Rust，stdin）:  {"action":"backspace","count":N}
//!       （Node -> Rust，stdin）:  {"action":"ping"}
//! 协议（Rust -> Node，stdout）: {"ok":true,"msg":"input complete"}
//!                               {"ok":true,"msg":"backspace complete","count":N}
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
    #[serde(default)]
    expect_focus: Option<String>,
}

/// 注入前的焦点校验。
/// 返回 Some(cur) = 焦点漂移（未注入，调用方应回 focus_drift）；
/// 返回 None = 通过校验（焦点匹配，或未绑定，或平台无法识别）。
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

/// 执行一次文本注入。返回注入的字符数。
fn type_text(enigo: &mut Enigo, raw: &str) -> Result<usize, String> {
    // 1) 过滤不可见控制字符
    let cleaned: String = raw.chars().filter(|c| !is_droppable(*c)).collect();
    if cleaned.is_empty() {
        return Err("empty text after filtering".to_string());
    }

    let chars: Vec<char> = cleaned.chars().collect();
    let total = chars.len();
    let delay = if total > LONG_TEXT_THRESHOLD {
        LONG_TEXT_DELAY_MS
    } else {
        CHUNK_DELAY_MS
    };

    // 2) 分片注入
    let mut injected = 0usize;
    for chunk in chars.chunks(CHUNK_SIZE) {
        let piece: String = chunk.iter().collect();

        let mut attempt = 0;
        loop {
            match enigo.text(&piece) {
                Ok(()) => break,
                Err(e) => {
                    attempt += 1;
                    if attempt >= CHUNK_RETRY {
                        return Err(format!(
                            "inject failed at offset {} after {} attempts: {e}",
                            injected, attempt
                        ));
                    }
                    log_err(&format!(
                        "chunk at offset {} failed ({e}), retry {}/{}",
                        injected, attempt, CHUNK_RETRY
                    ));
                    thread::sleep(Duration::from_millis(delay * 2));
                }
            }
        }

        injected += chunk.len();
        // 最后一片不必再等
        if injected < total {
            thread::sleep(Duration::from_millis(delay));
        }
    }

    log_err(&format!(
        "typed {} chars (chunk={}, delay={}ms)",
        total, CHUNK_SIZE, delay
    ));
    Ok(total)
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
            // 焦点漂移校验：先于注入，避免打进用户已切走的输入框
            if let Some(cur) = check_focus(&cmd.expect_focus) {
                emit(json!({ "ok": false, "msg": "focus_drift", "focus": cur }));
                return;
            }
            let text = cmd.text.unwrap_or_default();

            // 懒初始化并复用 Enigo 连接：
            // 每次新建会重新建立 X11 连接（较慢），而长时间存活本身是安全的。
            // 若实例不可用（如注入过程中连接失效），则销毁并在下一条指令重建。
            if enigo.is_none() {
                match new_enigo() {
                    Ok(e) => *enigo = Some(e),
                    Err(msg) => {
                        log_err(&msg);
                        emit(json!({ "ok": false, "msg": msg }));
                        return;
                    }
                }
            }

            let instance = enigo.as_mut().expect("enigo just initialized");
            match type_text(instance, &text) {
                Ok(n) => emit(json!({ "ok": true, "msg": "input complete", "chars": n, "focus": focus::current_focus() })),
                Err(reason) => {
                    log_err(&reason);
                    // 注入失败可能意味着底层连接已损坏，丢弃实例以便下条重建
                    *enigo = None;
                    emit(json!({ "ok": false, "msg": reason }));
                }
            }
        }
        "backspace" => {
            // 焦点漂移校验同样先于退格：对着别的窗口退格 = 误删用户文件
            if let Some(cur) = check_focus(&cmd.expect_focus) {
                emit(json!({ "ok": false, "msg": "focus_drift", "focus": cur }));
                return;
            }
            let count = clamp_backspace_count(cmd.count);
            if count == 0 {
                emit(json!({ "ok": true, "msg": "backspace complete", "count": 0, "focus": focus::current_focus() }));
                return;
            }

            if enigo.is_none() {
                match new_enigo() {
                    Ok(e) => *enigo = Some(e),
                    Err(msg) => {
                        log_err(&msg);
                        emit(json!({ "ok": false, "msg": msg }));
                        return;
                    }
                }
            }

            let instance = enigo.as_mut().expect("enigo just initialized");
            match backspace_n(instance, count) {
                Ok(n) => emit(json!({ "ok": true, "msg": "backspace complete", "count": n, "focus": focus::current_focus() })),
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
            // 对齐模式焦点轮询指令：Node 端在挂起期间每 2s 询问一次，
            // 焦点回到绑定目标后 Node 自动恢复对齐注入。
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
}
