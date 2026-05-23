// 关键词高亮渲染：把命中段包 <mark>。
// needle 为空 → 直接渲染 text（不创建 mark 节点）

import { highlightSpans } from '../lib/highlight';

interface Props {
  text: string;
  needle: string;
  className?: string;
}

export function HighlightedText({ text, needle, className }: Props) {
  if (!needle) return <span className={className}>{text}</span>;
  const spans = highlightSpans(text, needle);
  return (
    <span className={className}>
      {spans.map((s, i) =>
        s.hit
          ? <mark
              key={i}
              className="px-0.5 rounded-sm"
              style={{ backgroundColor: 'var(--hl-bg)', color: 'var(--hl-text)' }}
            >{s.text}</mark>
          : <span key={i}>{s.text}</span>
      )}
    </span>
  );
}
