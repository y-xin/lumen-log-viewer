// 虚拟列表：滚动到第 N 页边界时按需 fetch 下一页
// 列：行号 / 时间 / level / scope / message+fields（可拖动调整 4 个边界）

import { useCallback, useEffect, useRef, useState } from 'react';
import { FixedSizeList as List, ListChildComponentProps, ListOnScrollProps } from 'react-window';
import { getPage } from '../api/commands';
import { useSession } from '../state/session';
import type { LogEntry, LogLevel } from '../types/log';

const PAGE_SIZE = 200;
const ROW_HEIGHT = 28;
const BOTTOM_THRESHOLD = 20;
const STATUS_BAR_HEIGHT = 28;

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-700',
  warn: 'text-amber-700',
  info: 'text-blue-700',
  debug: 'text-cyan-700',
  trace: 'text-slate-500',
  unknown: 'text-slate-400',
};

// 可拖动列：默认宽度 + 最小宽度
type ColKey = 'line' | 'time' | 'level' | 'scope';
const DEFAULT_WIDTHS: Record<ColKey, number> = {
  line: 70,
  time: 180,
  level: 56,
  scope: 160,
};
const MIN_WIDTH = 32;

function formatFields(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
}

function lineLabel(e: LogEntry): string {
  return e.line_count > 1 ? `${e.line_no}-${e.line_no + e.line_count - 1}` : `${e.line_no}`;
}

export function LogList() {
  const { spec, result, selectedLineNo, setSelectedLineNo, newEntriesPending, clearNewEntriesPending } = useSession();
  const [entries, setEntries] = useState<(LogEntry | undefined)[]>([]);
  const pendingPages = useRef<Set<number>>(new Set());
  const seq = useRef(0);
  const listRef = useRef<List | null>(null);
  const atBottomRef = useRef(true);

  // ─── 容器高度 ──────────────────────────────────────────
  const [containerHeight, setContainerHeight] = useState<number>(() =>
    Math.max(0, window.innerHeight - 280)
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
    measure();
    requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    observerRef.current = ro;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  const listH = Math.max(0, containerHeight - STATUS_BAR_HEIGHT);

  // ─── 列宽（可拖动） ────────────────────────────────────
  const [widths, setWidths] = useState<Record<ColKey, number>>(DEFAULT_WIDTHS);
  const startResize = (col: ColKey, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[col];
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_WIDTH, startW + (ev.clientX - startX));
      setWidths((prev) => ({ ...prev, [col]: w }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ─── 数据加载 ──────────────────────────────────────────
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

  // ─── Row ───────────────────────────────────────────────
  const Row = ({ index, style }: ListChildComponentProps) => {
    const e = entries[index];
    if (!e) {
      const pageIdx = Math.floor(index / PAGE_SIZE);
      fetchPage(pageIdx);
      return <div style={style} className="px-2 text-slate-300 text-xs flex items-center">…</div>;
    }
    const isSelected = selectedLineNo === e.line_no;
    const fieldsTxt = formatFields(e.fields);
    const messageTxt = e.message || e.raw;
    const combined = fieldsTxt ? `${messageTxt}    ${fieldsTxt}` : messageTxt;
    return (
      <div
        style={style}
        onClick={() => setSelectedLineNo(isSelected ? null : e.line_no)}
        className={[
          'px-2 text-xs flex items-stretch gap-0 font-mono border-b border-slate-100 cursor-pointer',
          isSelected ? 'bg-blue-50' : 'hover:bg-slate-50',
        ].join(' ')}
      >
        <span style={{ width: widths.line }} className="flex items-center text-slate-400 text-right justify-end pr-2">
          {lineLabel(e)}
        </span>
        <span style={{ width: widths.time }} className="flex items-center text-slate-500 truncate px-2">
          {e.timestamp ?? '-'}
        </span>
        <span style={{ width: widths.level }} className={['flex items-center uppercase px-2', LEVEL_COLOR[e.level]].join(' ')}>
          {e.level}
        </span>
        <span style={{ width: widths.scope }} className="flex items-center text-slate-600 truncate px-2">
          {e.scope ?? '-'}
        </span>
        <span className="flex-1 flex items-center truncate px-2" title={combined}>
          {combined}
        </span>
      </div>
    );
  };

  if (!result) return null;
  const showFloating = newEntriesPending > 0 && !atBottomRef.current;

  // 表头：与 Row 列宽对齐，列之间放可拖动的 resizer
  const Header = () => (
    <div className="flex items-stretch text-xs font-medium text-slate-500 bg-slate-50 border-b border-slate-200 select-none">
      <div style={{ width: widths.line }} className="flex items-center justify-end pr-2 py-1">行号</div>
      <Resizer onMouseDown={(e) => startResize('line', e)} />
      <div style={{ width: widths.time }} className="flex items-center px-2 py-1">时间</div>
      <Resizer onMouseDown={(e) => startResize('time', e)} />
      <div style={{ width: widths.level }} className="flex items-center px-2 py-1">级别</div>
      <Resizer onMouseDown={(e) => startResize('level', e)} />
      <div style={{ width: widths.scope }} className="flex items-center px-2 py-1">Scope</div>
      <Resizer onMouseDown={(e) => startResize('scope', e)} />
      <div className="flex-1 flex items-center px-2 py-1">Message + Fields</div>
    </div>
  );

  return (
    <div ref={containerRef} className="flex-1 overflow-hidden relative flex flex-col">
      <Header />
      <div className="flex-1 overflow-hidden">
        <List
          ref={listRef}
          height={Math.max(0, listH - 28)}      // 减去表头高
          itemCount={result.total_matched}
          itemSize={ROW_HEIGHT}
          width="100%"
          onScroll={onScroll}
        >
          {Row}
        </List>
      </div>
      {showFloating && (
        <button
          onClick={jumpToBottom}
          className="absolute right-6 px-3 py-1.5 bg-blue-600 text-white text-xs rounded-full shadow-lg hover:bg-blue-700 z-10"
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

function Resizer({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 cursor-col-resize bg-transparent hover:bg-blue-400/40 active:bg-blue-500/60"
      style={{ touchAction: 'none' }}
      title="拖动调整列宽"
    />
  );
}
