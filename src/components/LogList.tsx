// 虚拟列表：滚动到第 N 页边界时按需 fetch 下一页
// MVP 简化：仅显示已 fetch 的条目；用 FixedSizeList 表达"占位高度 = total_matched"
// 增强：跟踪滚动位置；新条目到达时若在底部则自动滚动，否则显示"↓N 条新日志"悬浮按钮
// 高度：用 ResizeObserver 测量容器实际大小（避免硬编码 innerHeight - 280 在 sparkline
//       折叠 / 窗口缩放 / 不同 header 高度下算错而切掉底部行）

import { useCallback, useEffect, useRef, useState } from 'react';
import { FixedSizeList as List, ListChildComponentProps, ListOnScrollProps } from 'react-window';
import { getPage } from '../api/commands';
import { useSession } from '../state/session';
import type { LogEntry, LogLevel } from '../types/log';

const PAGE_SIZE = 200;
const ROW_HEIGHT = 28;
const BOTTOM_THRESHOLD = 20;
const STATUS_BAR_HEIGHT = 28; // 底部"匹配 N 条"行

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-700',
  warn: 'text-amber-700',
  info: 'text-blue-700',
  debug: 'text-cyan-700',
  trace: 'text-slate-500',
  unknown: 'text-slate-400',
};

export function LogList() {
  const { spec, result, selectedLineNo, setSelectedLineNo, newEntriesPending, clearNewEntriesPending } = useSession();
  // 全局条目缓冲：index → entry；空槽未加载
  const [entries, setEntries] = useState<(LogEntry | undefined)[]>([]);
  const pendingPages = useRef<Set<number>>(new Set());
  const seq = useRef(0);
  const listRef = useRef<List | null>(null);
  const atBottomRef = useRef(true);

  // 实际可用高度：用 callback ref + ResizeObserver。
  // callback ref 比 useRef+useLayoutEffect 更可靠 —— mount/unmount 时同步触发，
  // 解决"组件 conditional 渲染 + useLayoutEffect 只跑一次"的初始高度为 0 的问题。
  const [containerHeight, setContainerHeight] = useState<number>(() =>
    Math.max(0, window.innerHeight - 280) // fallback 初值，避免首帧 0
  );
  const observerRef = useRef<ResizeObserver | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node) return;
    const measure = () => {
      const h = node.clientHeight;
      if (h > 0) setContainerHeight(h);
    };
    // 立即测一次；再用 RAF 等浏览器完成布局后再测一次（覆盖 flex 撑开延迟到下一帧的情况）
    measure();
    requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    observerRef.current = ro;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const listH = Math.max(0, containerHeight - STATUS_BAR_HEIGHT);

  // spec 或文件变化时重置 + 注入首页；若用户处于底部，新结果到达后自动滚到末尾
  useEffect(() => {
    seq.current++;
    pendingPages.current.clear();
    if (!result) { setEntries([]); return; }
    const arr = new Array<LogEntry | undefined>(result.total_matched);
    result.page_entries.forEach((e, i) => { arr[i] = e; });
    setEntries(arr);
    if (atBottomRef.current && listRef.current && result.total_matched > 0) {
      listRef.current.scrollToItem(result.total_matched - 1, 'end');
      clearNewEntriesPending();
    }
  }, [result, spec, clearNewEntriesPending]);

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

  const onScroll = ({ scrollOffset }: ListOnScrollProps) => {
    if (!result) return;
    const maxScroll = result.total_matched * ROW_HEIGHT - listH;
    atBottomRef.current = (maxScroll - scrollOffset) < BOTTOM_THRESHOLD;
    if (atBottomRef.current && newEntriesPending > 0) {
      clearNewEntriesPending();
    }
  };

  const jumpToBottom = () => {
    if (!result || !listRef.current) return;
    listRef.current.scrollToItem(result.total_matched - 1, 'end');
    clearNewEntriesPending();
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
  const showFloating = newEntriesPending > 0 && !atBottomRef.current;

  return (
    <div ref={containerRef} className="flex-1 overflow-hidden relative">
      <List
        ref={listRef}
        height={listH}
        itemCount={result.total_matched}
        itemSize={ROW_HEIGHT}
        width="100%"
        onScroll={onScroll}
      >
        {Row}
      </List>
      {showFloating && (
        <button
          onClick={jumpToBottom}
          className="absolute right-6 px-3 py-1.5 bg-blue-600 text-white text-xs rounded-full shadow-lg hover:bg-blue-700"
          style={{ bottom: STATUS_BAR_HEIGHT + 16 }}
        >
          ↓ {newEntriesPending.toLocaleString()} 条新日志
        </button>
      )}
      <div className="px-3 py-1 text-xs text-slate-500 border-t bg-slate-50">
        匹配 {result.total_matched.toLocaleString()} 条
      </div>
    </div>
  );
}
