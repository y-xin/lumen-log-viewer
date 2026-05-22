// 关键词高亮辅助：把 text 按 needle（大小写不敏感）切成 hit / 非 hit 段
// needle 空 → 单元素 [{hit:false, text}]，由调用方决定是否包 <mark>

export interface Span { hit: boolean; text: string; }

export function highlightSpans(text: string, needle: string): Span[] {
  if (!needle) return [{ hit: false, text }];
  const lcText = text.toLowerCase();
  const lcNeedle = needle.toLowerCase();
  const out: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lcText.indexOf(lcNeedle, i);
    if (idx < 0) {
      out.push({ hit: false, text: text.slice(i) });
      break;
    }
    if (idx > i) out.push({ hit: false, text: text.slice(i, idx) });
    out.push({ hit: true, text: text.slice(idx, idx + needle.length) });
    i = idx + needle.length;
  }
  return out;
}
