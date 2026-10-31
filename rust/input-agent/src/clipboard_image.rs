//! set_clipboard_image 的 Windows 实现（v0.8.0+，v0.9.2 起支持 PNG）。
//!
//! 手机拍照/图库图片经 relay 送达后，Node 侧已把完整图片字节（base64）放进
//! 指令；本模块只做四件事：
//!   1. base64 解码（带大小上限防御）；
//!   2. 按字节魔数嗅探真实格式——声明不可信：手机端图库截图是 PNG 却按
//!      image/jpeg 声明发来（拍摄才是 JPEG），曾导致
//!      「jpeg decode failed: Illegal start bytes:8950」。JPEG（FF D8）走
//!      zune-jpeg，PNG（89 50 4E 47）走 png crate；
//!   3. 解码 → BGRA 像素 → 手工拼 CF_DIB（BITMAPINFOHEADER 40 字节 +
//!      自底向上 32bpp 像素行，与 Ditto 的主粘贴路径同款——全 Windows
//!      消费方都认 CF_DIB）；
//!   4. OpenClipboard → EmptyClipboard → SetClipboardData(CF_DIB) →
//!      CloseClipboard。OpenClipboard 在被其他程序占用时短重试
//!      （写剪贴板是幂等动作，重试无副作用，不存在「宁少勿多」问题）。
//!
//! 体积敏感：整条路径只有 base64 + zune-jpeg + png 三个纯 Rust 新依赖，
//! 均不引运行时；非 Windows 平台不编译本模块（Linux/macOS 未实现）。

use std::time::Duration;

/// 解码后的图片字节上限（10MB 图片需求 + 余量）。
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

/// JPEG SOI（Start of Image）标记。
const JPEG_MAGIC: [u8; 2] = [0xFF, 0xD8];
/// PNG 签名前 4 字节（完整签名 8 字节，嗅探取前 4 足够区分常见格式）。
const PNG_MAGIC: [u8; 4] = [0x89, 0x50, 0x4E, 0x47];

/// 处理一条 set_clipboard_image：base64 图片（JPEG/PNG）→ CF_DIB 写入剪贴板。
/// 返回写入的像素字节数（BGRA 总量），供上层日志。
pub fn set_image(base64_data: &str) -> Result<usize, String> {
    let bytes = decode_base64(base64_data)?;
    let (width, height, bgra) = decode_image_to_bgra(&bytes)?;
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

/// 尺寸防御：空尺寸与超像素上限都在分配输出缓冲前拦下。
fn check_dimensions(width: usize, height: usize) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err(format!("image has empty dimensions: {width}x{height}"));
    }
    if width.checked_mul(height).map_or(true, |n| n > MAX_PIXELS) {
        return Err(format!(
            "image too large: {width}x{height} (max {MAX_PIXELS} pixels)"
        ));
    }
    Ok(())
}

/// 按字节魔数嗅探真实格式并解码成 BGRA。
///
/// 协议里的 format/mime 只是声明，手机端发过「PNG 字节 + image/jpeg 声明」
/// 的载荷（图库截图是 PNG，拍摄才是 JPEG），解码器选择必须以魔数为准。
fn decode_image_to_bgra(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    if bytes.starts_with(&PNG_MAGIC) {
        decode_png_to_bgra(bytes)
    } else if bytes.starts_with(&JPEG_MAGIC) {
        decode_jpeg_to_bgra(bytes)
    } else {
        let m = |i: usize| bytes.get(i).copied().unwrap_or(0);
        Err(format!(
            "unsupported image format: magic {:02x} {:02x} {:02x} {:02x} (supported: JPEG, PNG)",
            m(0),
            m(1),
            m(2),
            m(3),
        ))
    }
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
    check_dimensions(width, height)?;
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

/// PNG → BGRA。png crate 纯 Rust（与 zune-jpeg 同为体积可控选型）。
///
/// normalize_to_color8 = EXPAND（调色板/低位深展开、tRNS 转 alpha）+ STRIP_16
/// （16bit 截断为 8bit），把输出归一到 8bit 的 Rgb/Rgba/Grayscale/GrayscaleAlpha
/// 四种，转换逻辑收敛到四个分支。alpha 保留（透明截图粘贴到支持的消费方
/// 仍透明）；灰度路径 alpha 补 255。
fn decode_png_to_bgra(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("png decode failed: {e:?}"))?;
    let info = reader.info();
    let (width, height) = (info.width as usize, info.height as usize);
    // 先拦尺寸再分配输出缓冲：60MP 上限的 PNG 不能在这里吃 240MB。
    check_dimensions(width, height)?;

    let mut buf = vec![0u8; reader.output_buffer_size()];
    let frame = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("png decode failed: {e:?}"))?;
    let src = &buf[..frame.buffer_size()];

    let pixels = width * height;
    let mut out = Vec::with_capacity(pixels * 4);
    match frame.color_type {
        png::ColorType::Rgba => {
            for px in src.chunks_exact(4) {
                out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
            }
        }
        png::ColorType::Rgb => {
            for px in src.chunks_exact(3) {
                out.extend_from_slice(&[px[2], px[1], px[0], 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for px in src.chunks_exact(2) {
                out.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
        }
        png::ColorType::Grayscale => {
            for &g in src {
                out.extend_from_slice(&[g, g, g, 255]);
            }
        }
        other => {
            return Err(format!(
                "png decode: unexpected color type {other:?} after normalization"
            ));
        }
    }
    if out.len() != pixels * 4 {
        return Err(format!(
            "png decode size mismatch: got {} bytes, expected {}",
            out.len(),
            pixels * 4
        ));
    }
    Ok((width, height, out))
}

/// BGRA 像素 → CF_DIB（BITMAPINFOHEADER + 自底向上 32bpp 行）。
///
/// 32bpp 选择：天然 4 字节对齐（无需逐行补齐 stride）、无调色板。
/// alpha 来自解码结果：JPEG 恒为 255（zune-jpeg 的 BGRA 输出），
/// PNG 保留原值（透明截图仍透明）；GDI 系消费方忽略 alpha 字节，
/// 32bpp BI_RGB 的第 4 字节对它们只是 padding，无副作用。
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

    /// 用 png::Encoder 合成一张 PNG（仅测试用；运行链路只有解码）。
    fn encode_png(
        width: u32,
        height: u32,
        color: png::ColorType,
        depth: png::BitDepth,
        raw: &[u8],
        palette: Option<&[u8]>,
    ) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut enc = png::Encoder::new(&mut out, width, height);
            enc.set_color(color);
            enc.set_depth(depth);
            if let Some(p) = palette {
                enc.set_palette(p);
            }
            let mut w = enc.write_header().expect("png header");
            w.write_image_data(raw).expect("png data");
        }
        out.into_inner()
    }

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
        let (w, h, bgra) = decode_image_to_bgra(&jpeg).expect("decode ok");
        assert_eq!((w, h), (64, 48));
        assert_eq!(bgra.len(), 64 * 48 * 4);
        // 纯色图的 BGRA 各通道应高度一致（B≈G≈R，A=255）
        assert_eq!(bgra[3], 255);
    }

    /// 手机端真实事故形态：PNG 字节 + image/jpeg 声明。魔数嗅探必须赢。
    #[test]
    fn sniffs_png_even_when_declared_jpeg() {
        let png = encode_png(
            2,
            1,
            png::ColorType::Rgba,
            png::BitDepth::Eight,
            &[10, 20, 30, 40, 50, 60, 70, 80],
            None,
        );
        let (w, h, bgra) = decode_image_to_bgra(&png).expect("decode ok");
        assert_eq!((w, h), (2, 1));
        assert_eq!(bgra, vec![30, 20, 10, 40, 70, 60, 50, 80]);
    }

    /// Rgb8 → BGR + alpha 255（R/B 交换，A 补满）。
    #[test]
    fn decodes_png_rgb8() {
        let png = encode_png(
            2,
            1,
            png::ColorType::Rgb,
            png::BitDepth::Eight,
            &[200, 150, 100, 0, 255, 128],
            None,
        );
        let (_, _, bgra) = decode_image_to_bgra(&png).expect("decode ok");
        assert_eq!(bgra, vec![100, 150, 200, 255, 128, 255, 0, 255]);
    }

    /// 调色板 PNG（图库优化图常见）经 EXPAND 展开 → Rgb。
    #[test]
    fn decodes_png_palette() {
        let png = encode_png(
            2,
            1,
            png::ColorType::Indexed,
            png::BitDepth::Eight,
            &[0, 1],
            Some(&[255, 0, 0, 0, 255, 0]),
        );
        let (_, _, bgra) = decode_image_to_bgra(&png).expect("decode ok");
        assert_eq!(bgra, vec![0, 0, 255, 255, 0, 255, 0, 255]);
    }

    /// 灰度（8/16bit、带/不带 alpha）各归一路径。
    #[test]
    fn decodes_png_grayscale_variants() {
        let gray = encode_png(
            3,
            1,
            png::ColorType::Grayscale,
            png::BitDepth::Eight,
            &[0x00, 0x80, 0xFF],
            None,
        );
        let (_, _, bgra) = decode_image_to_bgra(&gray).expect("decode ok");
        assert_eq!(
            bgra,
            vec![0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]
        );

        let gray_a = encode_png(
            2,
            1,
            png::ColorType::GrayscaleAlpha,
            png::BitDepth::Eight,
            &[0x40, 0xAA, 0xFF, 0x10],
            None,
        );
        let (_, _, bgra) = decode_image_to_bgra(&gray_a).expect("decode ok");
        assert_eq!(bgra, vec![0x40, 0x40, 0x40, 0xAA, 0xFF, 0xFF, 0xFF, 0x10]);
    }

    /// 16bit 深度（STRIP_16 截高位字节）→ Rgba8。
    #[test]
    fn decodes_png_rgba16_stripped() {
        // 2x1 RGBA16：像素 (0x1122,0x3344,0x5566,0x7788) / (0x99AA,0xBBCC,0xDDEE,0xFF00)
        let raw: Vec<u8> = [
            0x1122u16, 0x3344, 0x5566, 0x7788, 0x99AA, 0xBBCC, 0xDDEE, 0xFF00,
        ]
        .iter()
        .flat_map(|v| v.to_be_bytes())
        .collect();
        let png = encode_png(2, 1, png::ColorType::Rgba, png::BitDepth::Sixteen, &raw, None);
        let (_, _, bgra) = decode_image_to_bgra(&png).expect("decode ok");
        // STRIP_16 保留高字节：R 0x11 G 0x33 B 0x55 A 0x77 → BGRA
        assert_eq!(bgra, vec![0x55, 0x33, 0x11, 0x77, 0xDD, 0xBB, 0x99, 0xFF]);
    }

    /// 既非 JPEG 也非 PNG 的字节流 → 明确报错并带上魔数，方便定位来源。
    #[test]
    fn rejects_unknown_magic() {
        let err = decode_image_to_bgra(b"GIF89a....").unwrap_err();
        assert!(err.contains("unsupported image format"), "{err}");
        assert!(err.contains("47 49 46 38"), "{err}");
    }

    /// 空尺寸 / 超像素上限在分配前拦截（走 check_dimensions）。
    #[test]
    fn dimension_guard_rejects_huge() {
        let err = check_dimensions(0, 10).unwrap_err();
        assert!(err.contains("empty dimensions"), "{err}");
        let err = check_dimensions(8000, 8000).unwrap_err();
        assert!(err.contains("image too large"), "{err}");
        assert!(check_dimensions(6000, 6000).is_ok(), "60MP 边界内放行");
    }

    #[test]
    fn decode_base64_rejects_oversize() {
        let big = "A".repeat(MAX_BASE64_LEN + 1);
        assert!(decode_base64(&big).is_err());
        // 语法错误也要报错
        assert!(decode_base64("!!!!").is_err());
    }
}
