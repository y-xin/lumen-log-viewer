// 虚拟列表：滚动到第 N 页边界时按需 fetch 下一页
// MVP 简化：仅显示已 fetch 的条目；用 FixedSizeList 表达“占位高度 = total_matched”

import { useEffect, useRef, useState } from 'react';
import { FixedSizeList as List, ListChildComponentProps } from 'react-window';
import { getPage } from '../api/commands';
import { useSession } from '../state/session';
import type { LogEntry, LogLevel } from '../types/log';

const PAGE_SIZE = 200;
const ROW_HEIGHT = 28;

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-700',
  warn: 'text-amber-700',
  info: 'text-blue-700',
  debug: 'text-cyan-700',
  trace: 'text-slate-500',
  unknown: 'text-slate-400',
};

export function LogList() {
  const { spec, result, selectedLineNo, setSelectedLineNo } = useSession();
  // 全局条目缓冲：index → entry；空槽未加载
  const [entries, setEntries] = useState<(LogEntry | undefined)[]>([]);
  const pendingPages = useRef<Set<number>>(new Set());
  const seq = useRef(0);

  // spec 或文件变化时重置 + 注入首页
  useEffect(() => {
    seq.current++;
    pendingPages.current.clear();
    if (!result) { setEntries([]); return; }
    const arr = new Array<LogEntry | undefined>(result.total_matched);
    result.page_entries.forEach((e, i) => { arr[i] = e; });
    setEntries(arr);
  }, [result, spec]);

  const fetchPage = async (pageIdx: number) => {
    if (pendingPages.current.has(pageIdx)) return;
    pendingPages.current.add(pageIdx);
    const my = seq.current;
    try {
      const list = await getPage(spec, pageIdx, PAGE_SIZE);
      if (my !== seq.current) return;
      setEntries((prev) => {
        const next = prev.slice();
        list.forEach((e, i) => { next[pageIdx * PAGE_SIZE + i] = e; });
        return next;
      });
    } finally {
      pendingPages.current.delete(pageIdx);
    }
  };

  const Row = ({ index, style }: ListChildComponentProps) => {
    const e = entries[index];
    if (!e) {
      const pageIdx = Math.floor(index / PAGE_SIZE);
      fetchPage(pageIdx);
      return <div style={style} className="px-2 text-slate-300 text-xs flex items-center">…</div>;
    }
    const isSelected = selectedLineNo === e.line_no;
    return (
      <div
        style={style}
        onClick={() => setSelectedLineNo(isSelected ? null : e.line_no)}
        className={[
          'px-2 text-xs flex items-center gap-3 font-mono border-b border-slate-100 cursor-pointer',
          isSelected ? 'bg-blue-50' : 'hover:bg-slate-50',
        ].join(' ')}
      >
        <span className="text-slate-400 w-16 text-right">
          {e.line_count > 1 ? `#${e.line_no}-${e.line_no + e.line_count - 1}` : `#${e.line_no}`}
        </span>
        <span className="text-slate-500 w-40 truncate">{e.timestamp ?? '-'}</span>
        <span className={['w-12 uppercase', LEVEL_COLOR[e.level]].join(' ')}>{e.level}</span>
        <span className="text-slate-600 w-32 truncate">[{e.scope ?? '-'}]</span>
        <span className="flex-1 truncate">{e.message || e.raw}</span>
      </div>
    );
  };

  if (!result) return null;
  return (
    <div className="flex-1 overflow-hidden">
      <List
        height={Math.max(0, window.innerHeight - 220)}
        itemCount={result.total_matched}
        itemSize={ROW_HEIGHT}
        width="100%"
      >
        {Row}
      </List>
      <div className="px-3 py-1 text-xs text-slate-500 border-t bg-slate-50">
        匹配 {result.total_matched.toLocaleString()} 条
      </div>
    </div>
  );
}
