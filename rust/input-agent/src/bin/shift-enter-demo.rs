//! Shift+Enter 手动验证工具（临时测试用，不随产品分发）。
//!
//! 运行后：5 秒倒计时（留给用户切换焦点到目标输入框）→
//! 每隔 5 秒向当前焦点窗口注入一次 Shift+Enter，共 3 次，然后退出。
//!
//! 用途：在真实 IM / 聊天框里验证组合键链路（修饰键 Press → 主键 Click →
//! 修饰键 Release）的换行行为——「Enter=发送」的输入框应只换行不发送。
//!
//! 注意：事件间隔刻意与 main.rs 的 HOTKEY_DELAY_MS（15ms）保持一致，
//! 测的就是生产时序。本文件未提交入库，测试完可直接删除。

use std::thread;
use std::time::Duration;

use enigo::{Direction, Enigo, Key, Keyboard, Settings};

/// 启动前留给用户切换焦点的倒计时（秒）。
const INITIAL_COUNTDOWN_S: u64 = 5;
/// 相邻两次 Shift+Enter 的间隔（秒）。
const INTERVAL_S: u64 = 5;
/// 总共注入次数。
const TOTAL: usize = 3;
/// 与 main.rs 的 HOTKEY_DELAY_MS 一致：组合键相邻事件间的延时。
const HOTKEY_DELAY_MS: u64 = 15;

fn main() {
    println!("=== Shift+Enter 手动验证工具 ===");
    println!("请在 {INITIAL_COUNTDOWN_S} 秒内把焦点切到目标输入框…");
    for remaining in (1..=INITIAL_COUNTDOWN_S).rev() {
        println!("  {remaining}…");
        thread::sleep(Duration::from_secs(1));
    }

    let mut enigo = Enigo::new(&Settings::default()).expect("enigo init failed");

    for i in 1..=TOTAL {
        enigo.key(Key::Shift, Direction::Press).expect("press shift failed");
        thread::sleep(Duration::from_millis(HOTKEY_DELAY_MS));
        enigo.key(Key::Return, Direction::Click).expect("click return failed");
        thread::sleep(Duration::from_millis(HOTKEY_DELAY_MS));
        enigo.key(Key::Shift, Direction::Release).expect("release shift failed");
        println!("[{i}/{TOTAL}] Shift+Enter 已发送");

        if i < TOTAL {
            thread::sleep(Duration::from_secs(INTERVAL_S));
        }
    }
    println!("完成。");
}
