// 嗅探质量提示条：当 metadata.sniff_kind 为 Suggested / NoMatch 时显示。
// 用户切了模板（reparse 后 sniff_kind = undefined）则隐藏。

import { useSession } from '../state/session';

export function SniffQualityBanner() {
  const { metadata } = useSession();
  if (!metadata?.sniff_kind || metadata.sniff_kind === 'AutoMatch') return null;

  const isNoMatch = metadata.sniff_kind === 'NoMatch';
  return (
    <div
      className={[
        'px-4 py-1.5 text-xs border-b flex items-center gap-2',
        isNoMatch
          ? 'bg-red-50 border-red-200 text-red-700'
          : 'bg-amber-50 border-amber-200 text-amber-800',
      ].join(' ')}
      title="可在顶部的 模板 ▾ 下拉里换一个解析器"
    >
      <span>{isNoMatch ? '⚠️' : '💡'}</span>
      <span className="flex-1">
        {isNoMatch
          ? '没有合身的解析模板，已用 fallback 显示原始行。'
          : '当前模板匹配度不高，可能解析不准。'}
        <span className="ml-1 text-slate-500">建议从顶部 模板 ▾ 切换其他模板试试。</span>
      </span>
    </div>
  );
}
