'use strict';

/**
 * RT1 输入对齐的 diff 原语：旧全文 → 新全文 的按键变换计划。
 *
 * 参考实现：FlowType windows/flowtype-core/src/diff.rs（grapheme common-prefix）。
 * 这里在共同前缀之外再加共同后缀优化：手机端改中间一个字时，
 * 回删与重打都只落在中段，而不是退化为"回删整个尾巴"。
 *
 * 所有计算按 Unicode grapheme cluster 进行（Intl.Segmenter），
 * emoji ZWJ 序列（👨‍👩‍👧‍👦）、组合字符（e + U+0301）都作为单整体，
 * 避免 AirWord 那种 UTF-16 长度差分把代理对劈成两半的错位。
 */

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** 拆 grapheme：返回数组（每个元素是一个用户感知字符）。 */
function graphemes(text) {
  const out = [];
  for (const seg of segmenter.segment(String(text ?? ''))) {
    out.push(seg.segment);
  }
  return out;
}

/**
 * 计算从 previous 变换到 current 需要的按键序列。
 *
 * 前提：注入光标位于 previous 文本末尾（PC 端 mirror 语义，见 relay-client.js）。
 *
 * @param {string} previous mirror 中记录的已注入全文
 * @param {string} current  手机端同步来的新全文
 * @returns {{backspaces: number, insert: string}}
 */
function planTransition(previous, current) {
  const a = graphemes(previous);
  const b = graphemes(current);

  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) prefix += 1;

  // 共同后缀：不能越过前缀（否则 prefix/suffix 重叠会多删）
  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1;

  return {
    backspaces: a.length - prefix - suffix,
    insert: b.slice(prefix, b.length - suffix).join(''),
  };
}

module.exports = { graphemes, planTransition };
