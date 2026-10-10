'use strict';

/**
 * 文本预处理（需求文档 4.2.2 第 3 条）。
 *
 * 规则：
 *   1. 过滤不可见控制字符（换行/Tab 视为可保留的可见分隔，其余控制字符剔除）；
 *   2. 过滤零宽字符（\u200B-\u200D、\uFEFF 等），它们会造成「看似输入了却看不见」的困惑；
 *   3. 空串（含只有空白）直接丢弃；
 *   4. 超长文本截断并告警。
 */

/** 默认最大长度（字符数）。按语音输入场景，5000 字符足够，且能规避注入卡死。 */
const DEFAULT_MAX_LENGTH = 5000;

/**
 * 判断是否为应剔除的不可见字符。
 * 注意：刻意保留 \n 和 \t —— 语音文本里它们通常是有效分隔。
 */
function isInvisible(c) {
  const code = c.codePointAt(0);
  // 零宽字符与 BOM
  if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) return true;
  // 其他 C0/C1 控制字符（保留 \n \t \r 交给上层处理）
  if (c === '\n' || c === '\t' || c === '\r') return false;
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  return false;
}

/**
 * 预处理文本。
 * @param {string} raw
 * @param {object} [opts]
 * @param {number} [opts.maxLength]
 * @param {boolean} [opts.keepWhitespace] 保留纯空白文本（对齐模式用：
 *   换行/空格是手机输入框的真实内容，整条空白不算「空文本」；
 *   返回 ok:true 且 text 可能为空串，由调用方决定是否为无操作）
 * @returns {{ok:boolean, text:string, reason?:string, truncated?:boolean, originalLength?:number}}
 */
function sanitize(raw, opts = {}) {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  const keepWhitespace = opts.keepWhitespace === true;

  if (typeof raw !== 'string') {
    return { ok: false, text: '', reason: 'not_a_string' };
  }

  const originalLength = raw.length;

  // 1) 剔除不可见字符
  let text = '';
  for (const ch of raw) {
    if (!isInvisible(ch)) text += ch;
  }

  // 2) 统一换行，避免 \r\n 造成目标程序出现多余字符
  text = text.replace(/\r\n?/g, '\n');

  // 3) 空文本丢弃（keepWhitespace 时跳过：空白是对齐语义下的有效内容）
  if (!keepWhitespace && text.trim().length === 0) {
    return { ok: false, text: '', reason: 'empty_after_clean', originalLength };
  }

  // 4) 超长截断
  let truncated = false;
  const chars = Array.from(text);
  if (chars.length > maxLength) {
    text = chars.slice(0, maxLength).join('');
    truncated = true;
  }

  return { ok: true, text, truncated, originalLength };
}

module.exports = { sanitize, isInvisible, DEFAULT_MAX_LENGTH };
