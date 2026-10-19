//! 鼠标注入手动验证工具（临时测试用，不随产品分发）。
//!
//! 运行后：5 秒倒计时（留给用户切换到安全桌面）→
//!   1. 相对移动画一个正方形（验证 Coordinate::Rel 增量方向与精度）；
//!   2. 左键单击 → 300ms 后再单击（验证系统把两次 Click 归并为双击）；
//!   3. 滚轮向下 3 格 → 停顿 → 向上 3 格（验证 enigo 正数 = 向下语义）；
//!   4. 右键单击后退出。
//!
//! 注意：移动分片与延时刻意对齐触摸板链路的真实形态（~30Hz 小增量）。

use std::thread;
use std::time::Duration;

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Mouse, Settings};

const INITIAL_COUNTDOWN_S: u64 = 5;
/// 单步移动增量（像素）：与手机端 ~30Hz 合批后的典型单帧量级一致。
const STEP: i32 = 24;
/// 相邻移动之间的间隔（毫秒）：≈ 40Hz，略高于触摸板发送频率。
const STEP_DELAY_MS: u64 = 25;

fn main() {
    println!("=== 鼠标注入手动验证工具 ===");
    println!("请在 {INITIAL_COUNTDOWN_S} 秒内切到一个安全的窗口…");
    for remaining in (1..=INITIAL_COUNTDOWN_S).rev() {
        println!("  {remaining}…");
        thread::sleep(Duration::from_secs(1));
    }

    let mut enigo = Enigo::new(&Settings::default()).expect("enigo init failed");

    // 1) 正方形轨迹：右 → 下 → 左 → 上，每边 12 步
    let edges: [(i32, i32); 4] = [(STEP, 0), (0, STEP), (-STEP, 0), (0, -STEP)];
    println!("画正方形（4 边 × 12 步，步长 {STEP}px）…");
    for (side, &(dx, dy)) in edges.iter().enumerate() {
        for _ in 0..12 {
            enigo
                .move_mouse(dx, dy, Coordinate::Rel)
                .expect("move_mouse failed");
            thread::sleep(Duration::from_millis(STEP_DELAY_MS));
        }
        println!("  边 {side} 完成 ({dx},{dy})×12");
    }

    // 2) 双击（两次 Click，间隔小于系统双击时间 → 由 OS 归并）
    println!("左键两次单击（应为一次双击）…");
    enigo
        .button(Button::Left, Direction::Click)
        .expect("left click failed");
    thread::sleep(Duration::from_millis(80));
    enigo
        .button(Button::Left, Direction::Click)
        .expect("left click failed");

    // 3) 滚轮：正数 = 向下
    println!("滚轮向下 3 格 → 停 1s → 向上 3 格…");
    enigo.scroll(3, Axis::Vertical).expect("scroll down failed");
    thread::sleep(Duration::from_secs(1));
    enigo.scroll(-3, Axis::Vertical).expect("scroll up failed");

    // 4) 右键
    println!("右键单击…");
    enigo
        .button(Button::Right, Direction::Click)
        .expect("right click failed");

    println!("完成。");
}
