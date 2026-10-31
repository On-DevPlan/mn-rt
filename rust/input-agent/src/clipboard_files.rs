//! set_clipboard_files 的 Windows 实现（v0.9.0+ 文件模块·上传文件）。
//!
//! Windows 剪贴板里的「文件」不是字节而是**引用**：CF_HDROP 指向磁盘上
//! 真实存在的路径（Explorer/微信/QQ 粘贴时按路径取文件）。因此文件上传
//! 的落点必然是「先落盘、再复制」——Node 侧把分片重组的字节写进接收目录，
//! 本模块只负责把绝对路径挂上剪贴板。
//!
//! DROPFILES 结构（20 字节）+ 双 NUL 结尾的 UTF-16 路径列表；fWide=TRUE
//! 表示 Unicode。与 clipboard_image.rs 共用同一套 Open/Empty/Set/Close
//! 时序（重复一次小段 unsafe，换取两个模块各自独立可读）。

use std::time::Duration;

/// 路径条数上限（多选文件一次粘贴的场景远用不到这么多）。
pub const MAX_PATHS: usize = 16;
/// 单路径字符上限（Windows MAX_PATH 扩展后仍有界；防御异常报文）。
const MAX_PATH_CHARS: usize = 1024;
/// DROPFILES 头长 + fWide 标记下的 UTF-16 编码。
const DROPFILES_SIZE: u32 = 20;

/// Win32 剪贴板格式常量（CF_HDROP = 15，稳定 ABI 值硬编码）。
const CF_HDROP: u32 = 15;

/// 把一组绝对路径写入剪贴板（CF_HDROP）。成功后内存归系统所有。
/// 写剪贴板幂等，失败可整条重试。
pub fn set_clipboard_files(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("set_clipboard_files requires at least one path".to_string());
    }
    if paths.len() > MAX_PATHS {
        return Err(format!("too many paths: {} (max {MAX_PATHS})", paths.len()));
    }
    let dib = build_hdrop(paths)?;
    write_hdrop_to_clipboard(&dib)
}

/// 路径列表 → DROPFILES + UTF-16 双 NUL 结尾字节串。
fn build_hdrop(paths: &[String]) -> Result<Vec<u8>, String> {
    let mut wide: Vec<u16> = Vec::new();
    for p in paths {
        if p.is_empty() || p.chars().count() > MAX_PATH_CHARS {
            return Err(format!("invalid path length: {} chars", p.chars().count()));
        }
        wide.extend(p.encode_utf16());
        wide.push(0); // 单条路径的 NUL 结尾
    }
    wide.push(0); // 列表的双 NUL 结尾

    let mut out = Vec::with_capacity(DROPFILES_SIZE as usize + wide.len() * 2);
    out.extend_from_slice(&DROPFILES_SIZE.to_le_bytes()); // pFiles：文件列表偏移
    out.extend_from_slice(&0i32.to_le_bytes()); // pt.x
    out.extend_from_slice(&0i32.to_le_bytes()); // pt.y
    out.extend_from_slice(&0u32.to_le_bytes()); // fNC：非客户区坐标，恒 0
    out.extend_from_slice(&1u32.to_le_bytes()); // fWide：TRUE = UTF-16
    for w in &wide {
        out.extend_from_slice(&w.to_le_bytes());
    }
    Ok(out)
}

/// 把 HDROP 字节写入系统剪贴板（时序与 clipboard_image 同款：
/// OpenClipboard 占用短重试 → Empty → SetClipboardData → Close）。
fn write_hdrop_to_clipboard(hdrop: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    const OPEN_ATTEMPTS: usize = 10;
    const OPEN_RETRY_MS: u64 = 50;

    unsafe {
        let mut opened = false;
        for attempt in 0..OPEN_ATTEMPTS {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            if attempt + 1 < OPEN_ATTEMPTS {
                std::thread::sleep(Duration::from_millis(OPEN_RETRY_MS));
            }
        }
        if !opened {
            return Err(format!(
                "OpenClipboard failed after {OPEN_ATTEMPTS} attempts: 剪贴板被其他程序占用?"
            ));
        }

        let result = (|| {
            if EmptyClipboard() == 0 {
                return Err("EmptyClipboard failed".to_string());
            }
            let handle = GlobalAlloc(GMEM_MOVEABLE, hdrop.len());
            if handle.is_null() {
                return Err("GlobalAlloc failed".to_string());
            }
            let ptr = GlobalLock(handle);
            if ptr.is_null() {
                GlobalFree(handle);
                return Err("GlobalLock failed".to_string());
            }
            std::ptr::copy_nonoverlapping(hdrop.as_ptr(), ptr as *mut u8, hdrop.len());
            GlobalUnlock(handle);
            if SetClipboardData(CF_HDROP, handle).is_null() {
                GlobalFree(handle);
                return Err("SetClipboardData(CF_HDROP) failed".to_string());
            }
            Ok(())
        })();

        CloseClipboard();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HDROP 结构：头部字段 + UTF-16 路径 + 双 NUL 结尾。
    #[test]
    fn build_hdrop_shape() {
        let bytes = build_hdrop(&["C:\\a\\b.txt".to_string()]).expect("ok");
        // 头 20 字节
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 20);
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 1); // fWide
                                                                              // 路径 UTF-16 + 两个 NUL
        let wide: Vec<u8> = "C:\\a\\b.txt"
            .encode_utf16()
            .flat_map(|w| w.to_le_bytes())
            .chain([0, 0, 0, 0]) // 单条 NUL + 列表 NUL（各 2 字节）
            .collect();
        assert_eq!(bytes.len(), 20 + wide.len());
        assert_eq!(&bytes[20..], &wide[..]);
    }

    #[test]
    fn build_hdrop_multiple_paths() {
        let bytes =
            build_hdrop(&[("C:\\1.txt").to_string(), ("D:\\2.bin").to_string()]).expect("ok");
        let tail = &bytes[20..];
        let words: Vec<u16> = tail
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        // 逐段校验：两条路径 + 分隔 NUL + 结尾双 NUL
        let s = String::from_utf16(&words).unwrap();
        assert_eq!(s, "C:\\1.txt\u{0}D:\\2.bin\u{0}\u{0}");
    }

    #[test]
    fn rejects_empty_and_oversize() {
        assert!(set_clipboard_files(&[]).is_err());
        let long = "C:\\".to_string() + &"a".repeat(MAX_PATH_CHARS + 1);
        assert!(build_hdrop(&[long]).is_err());
    }
}
