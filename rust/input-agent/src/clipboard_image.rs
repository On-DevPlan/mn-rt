//! set_clipboard_image 的 Windows 实现（v0.7.0+）。
//!
//! 手机拍照经 relay 送达后，Node 侧已把完整 JPEG 字节（base64）放进指令；
//! 本模块只做三件事：
//!   1. base64 解码（带大小上限防御）；
//!   2. JPEG → BGRA 像素（zune-jpeg，纯 Rust，体积可控）→ 手工拼 CF_DIB
//!      （BITMAPINFOHEADER 40 字节 + 自底向上 32bpp 像素行，与 Ditto 的主
//!      粘贴路径同款——全 Windows 消费方都认 CF_DIB）；
//!   3. OpenClipboard → EmptyClipboard → SetClipboardData(CF_DIB) →
//!      CloseClipboard。OpenClipboard 在被其他程序占用时短重试
//!      （写剪贴板是幂等动作，重试无副作用，不存在「宁少勿多」问题）。
//!
//! 体积敏感：整条路径只有 base64 + zune-jpeg 两个纯 Rust 新依赖，
//! 均不引运行时；非 Windows 平台不编译本模块（Linux/macOS 未实现）。

use std::time::Duration;

/// 解码后的 JPEG 字节上限（10MB 图片需求 + 余量）。
pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;
/// base64 输入字符串长度上限（解码前防御，4/3 膨胀 + 余量）。
const MAX_BASE64_LEN: usize = 18 * 1024 * 1024;
/// 像素总量上限（60MP，约 240MB BGRA——桌面机可承受的一次性峰值）。
const MAX_PIXELS: usize = 60_000_000;
/// OpenClipboard 被占用时的重试：10 次 × 50ms。
const CLIPBOARD_OPEN_ATTEMPTS: usize = 10;
const CLIPBOARD_OPEN_RETRY_MS: u64 = 50;

/// Win32 剪贴板格式常量。CF_* 是稳定的 ABI 值，硬编码避免多拉一个
/// windows-sys feature（CF_DIB = 8）。
const CF_DIB: u32 = 8;

/// BITMAPINFOHEADER 头部长度（BITMAPCOREHEADER 之外的现代格式都是 40）。
const BITMAPINFOHEADER_SIZE: u32 = 40;

/// 处理一条 set_clipboard_image：base64 JPEG → CF_DIB 写入剪贴板。
/// 返回写入的像素字节数（BGRA 总量），供上层日志。
pub fn set_image_jpeg(base64_data: &str) -> Result<usize, String> {
    let jpeg = decode_base64(base64_data)?;
    let (width, height, bgra) = decode_jpeg_to_bgra(&jpeg)?;
    let dib = pixels_to_dib(width, height, &bgra);
    write_dib_to_clipboard(&dib)?;
    Ok(bgra.len())
}

fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    if data.len() > MAX_BASE64_LEN {
        return Err(format!(
            "image payload too large: {} bytes (max {MAX_BASE64_LEN})",
            data.len()
        ));
    }
    // Node 侧 Buffer.toString('base64') 输出标准字母表，可能带 padding。
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "image too large: {} bytes (max {MAX_IMAGE_BYTES})",
            bytes.len()
        ));
    }
    Ok(bytes)
}

fn decode_jpeg_to_bgra(jpeg: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;
    use zune_jpeg::JpegDecoder;

    // zune-jpeg 0.4 的 API：色彩空间经 DecoderOptions 传入，解码后 info() 取尺寸。
    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::BGRA);
    let mut decoder = JpegDecoder::new_with_options(jpeg, options);
    let pixels = decoder
        .decode()
        .map_err(|e| format!("jpeg decode failed: {e:?}"))?;
    let info = decoder
        .info()
        .ok_or_else(|| "jpeg decode returned no image info".to_string())?;
    let (width, height) = (info.width as usize, info.height as usize);
    if width == 0 || height == 0 {
        return Err(format!("jpeg has empty dimensions: {width}x{height}"));
    }
    if width.checked_mul(height).map_or(true, |n| n > MAX_PIXELS) {
        return Err(format!(
            "jpeg too large: {width}x{height} (max {MAX_PIXELS} pixels)"
        ));
    }
    // BGRA 输出必为 4 字节/像素；解码器违约宁可报错也不越界写剪贴板。
    let expected = width * height * 4;
    if pixels.len() != expected {
        return Err(format!(
            "jpeg decode size mismatch: got {} bytes, expected {expected}",
            pixels.len()
        ));
    }
    Ok((width, height, pixels))
}

/// BGRA 像素 → CF_DIB（BITMAPINFOHEADER + 自底向上 32bpp 行）。
///
/// 32bpp 选择：天然 4 字节对齐（无需逐行补齐 stride）、无调色板、
/// alpha 字节对照片恒为 255（JPEG 无透明），绝大多数消费方按不透明处理。
/// biHeight 取正 = 自底向上（BMP/DIB 的传统行序）。
fn pixels_to_dib(width: usize, height: usize, bgra: &[u8]) -> Vec<u8> {
    let stride = width * 4;
    let image_size = stride * height;
    let mut out = Vec::with_capacity(BITMAPINFOHEADER_SIZE as usize + image_size);
    out.extend_from_slice(&BITMAPINFOHEADER_SIZE.to_le_bytes()); // biSize
    out.extend_from_slice(&(width as u32).to_le_bytes()); // biWidth
    out.extend_from_slice(&(height as u32).to_le_bytes()); // biHeight（正 = bottom-up）
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    out.extend_from_slice(&(image_size as u32).to_le_bytes()); // biSizeImage
    out.extend_from_slice(&0u32.to_le_bytes()); // biXPelsPerMeter
    out.extend_from_slice(&0u32.to_le_bytes()); // biYPelsPerMeter
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant
    for row in (0..height).rev() {
        out.extend_from_slice(&bgra[row * stride..(row + 1) * stride]);
    }
    out
}

/// 把 DIB 写入系统剪贴板（CF_DIB）。成功后内存归系统所有。
///
/// OpenClipboard 失败（其他程序占着剪贴板）时短重试；一旦打开成功，
/// 后续失败直接上报——EmptyClipboard/SetClipboardData 不存在被占用问题。
fn write_dib_to_clipboard(dib: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    unsafe {
        let mut opened = false;
        for attempt in 0..CLIPBOARD_OPEN_ATTEMPTS {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            // 最后一次失败不再等待
            if attempt + 1 < CLIPBOARD_OPEN_ATTEMPTS {
                std::thread::sleep(Duration::from_millis(CLIPBOARD_OPEN_RETRY_MS));
            }
        }
        if !opened {
            return Err(format!(
                "OpenClipboard failed after {CLIPBOARD_OPEN_ATTEMPTS} attempts: 剪贴板被其他程序占用?"
            ));
        }

        let result = (|| {
            if EmptyClipboard() == 0 {
                return Err("EmptyClipboard failed".to_string());
            }
            let handle = GlobalAlloc(GMEM_MOVEABLE, dib.len());
            if handle.is_null() {
                return Err("GlobalAlloc failed".to_string());
            }
            let ptr = GlobalLock(handle);
            if ptr.is_null() {
                GlobalFree(handle);
                return Err("GlobalLock failed".to_string());
            }
            std::ptr::copy_nonoverlapping(dib.as_ptr(), ptr as *mut u8, dib.len());
            GlobalUnlock(handle);
            // 成功后所有权移交系统，绝不能再 GlobalFree；失败则自己兜底回收。
            if SetClipboardData(CF_DIB, handle).is_null() {
                GlobalFree(handle);
                return Err("SetClipboardData(CF_DIB) failed".to_string());
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

    /// 像素 → DIB 的结构正确性：头部字段 + 自底向上行序。
    #[test]
    fn pixels_to_dib_shape_and_row_order() {
        // 2x2 BGRA：上排 (0,0,0,255) 纯蓝 / (1,1,1,255) 纯灰，下排 (9,9,9,255) / (5,5,5,255)
        let bgra: Vec<u8> = vec![
            0, 0, 0, 255, 1, 1, 1, 255, // 上排
            9, 9, 9, 255, 5, 5, 5, 255, // 下排
        ];
        let dib = pixels_to_dib(2, 2, &bgra);
        assert_eq!(dib.len(), 40 + 16);

        assert_eq!(u32::from_le_bytes(dib[0..4].try_into().unwrap()), 40);
        assert_eq!(u32::from_le_bytes(dib[4..8].try_into().unwrap()), 2); // width
        assert_eq!(u32::from_le_bytes(dib[8..12].try_into().unwrap()), 2); // height
        assert_eq!(u16::from_le_bytes(dib[12..14].try_into().unwrap()), 1); // planes
        assert_eq!(u16::from_le_bytes(dib[14..16].try_into().unwrap()), 32); // bpp
        assert_eq!(u32::from_le_bytes(dib[16..20].try_into().unwrap()), 0); // BI_RGB
        assert_eq!(u32::from_le_bytes(dib[20..24].try_into().unwrap()), 16); // sizeImage

        // bottom-up：第一像素行是「下排」，第二像素行才是「上排」
        assert_eq!(&dib[40..48], &[9, 9, 9, 255, 5, 5, 5, 255]);
        assert_eq!(&dib[48..56], &[0, 0, 0, 255, 1, 1, 1, 255]);
    }

    /// JPEG 解码 + 端到端尺寸：用测试夹具（64x48 纯色 JPEG）验整条解码路径。
    #[test]
    fn decodes_fixture_jpeg_to_bgra() {
        let jpeg = std::fs::read("tests/fixtures/photo_64x48.jpg")
            .expect("fixture missing——run scripts/gen-test-jpeg.ps1");
        let (w, h, bgra) = decode_jpeg_to_bgra(&jpeg).expect("decode ok");
        assert_eq!((w, h), (64, 48));
        assert_eq!(bgra.len(), 64 * 48 * 4);
        // 纯色图的 BGRA 各通道应高度一致（B≈G≈R，A=255）
        assert_eq!(bgra[3], 255);
    }

    #[test]
    fn decode_base64_rejects_oversize() {
        let big = "A".repeat(MAX_BASE64_LEN + 1);
        assert!(decode_base64(&big).is_err());
        // 语法错误也要报错
        assert!(decode_base64("!!!!").is_err());
    }
}
