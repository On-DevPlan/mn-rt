//! 焦点识别：返回当前持有键盘焦点的窗口标识。
//!
//! 用途：对齐模式下，Node 在注入指令里携带 `expect_focus`（会话绑定的目标
//! 焦点），本模块在注入前查当前焦点做比对——焦点漂移（用户点了别的窗口）
//! 时拒绝注入，避免文本打进错误的地方。
//!
//! 平台支持与降级策略：
//!   * Windows  — GetGUIThreadInfo(0).hwndFocus（前台线程的焦点子控件）
//!   * Linux    — X11 GetInputFocus（enigo 的 x11rb 后端同款连接方式）
//!   * macOS    — 暂不支持（需 Accessibility API，后续补），返回 None
//!
//! 返回 None 表示「无法识别焦点」：Node 侧视作不可校验，行为与旧版一致
//! （照常注入），即优雅降级，绝不因识别能力缺失而阻塞注入。

/// 当前焦点窗口标识，形如 `win:0x...` / `x11:0x...`；None = 平台暂不支持。
pub fn current_focus() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        windows_focus()
    }
    #[cfg(target_os = "linux")]
    {
        linux_focus()
    }
    #[cfg(target_os = "macos")]
    {
        None
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

#[cfg(target_os = "windows")]
fn windows_focus() -> Option<String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetGUIThreadInfo, GUITHREADINFO};

    unsafe {
        // 前台窗口本身先取出来：hwndFocus 为空时（少数全屏/游戏窗口）用它兜底
        let fg: HWND = GetForegroundWindow();
        if fg.is_null() {
            return None;
        }
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        // 参数 0 = 前台线程（微软文档语义），拿到该线程真实的键盘焦点控件
        if GetGUIThreadInfo(0, &mut info) == 0 {
            return None;
        }
        let target: HWND = if info.hwndFocus.is_null() { fg } else { info.hwndFocus };
        Some(format!("win:{target:p}"))
    }
}

#[cfg(target_os = "linux")]
fn linux_focus() -> Option<String> {
    use x11rb::connection::Connection;

    // 每次新建连接：语音输入是低频场景（250ms 防抖 + 快照粒度），
    // Unix socket 连接开销 ~1ms，不值得为缓存引入生命周期管理
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;
    let reply = conn.get_input_focus().ok()?.reply().ok()?;
    // 0 = X11 None（无焦点），1 = PointerRoot：都视为「焦点不可判定」
    if reply.focus <= 1 || reply.focus == root {
        return None;
    }
    Some(format!("x11:{:x}", reply.focus))
}
