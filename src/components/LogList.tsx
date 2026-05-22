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

// footer level 计数：顺序固定 error → unknown，颜色与 StatsPanel 旧值一致
const FOOTER_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace', 'unknown'];
const FOOTER_LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-700',
  warn: 'text-amber-700',
  info: 'text-blue-700',
  debug: 'text-cyan-700',
  trace: 'text-slate-700',
  unknown: 'text-slate-500',
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

// 用 spec 的 JSON 字符串作为"会话指纹" — 文件变 / spec 变 → 指纹变 → 重置 entries。
// 单纯 follow append 时（result 引用换了但 spec 没变 + total_matched 增大）→ 保留已加载的 entries 防止闪烁。
function specKey(s: unknown): string {
  try { return JSON.stringify(s); } catch { return ''; }
}

export function LogList() {
  const { spec, result, selectedEntry, setSelectedEntry, newEntriesPending, clearNewEntriesPending } = useSession();
  const [entries, setEntries] = useState<(LogEntry | undefined)[]>([]);
  const pendingPages = useRef<Set<number>>(new Set());
  const seq = useRef(0);
  const listRef = useRef<List | null>(null);
  // 跟踪是否在底部；state 而非 ref，让"跳到底部"按钮能根据它显隐
  const [atBottom, setAtBottom] = useState(true);
  const lastSpecKey = useRef<string>('');

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
  // spec 变化 → 重置（清空再注入首页）；spec 没变 + result 引用变 → smart merge：
  //   - 扩展 entries 长度到 total_matched
  //   - 把 result.page_entries（其中含追加的新条目）覆盖到对应位置
  //   - 不动其他位置（保留 fetchPage 拿到的页）
  // 这是修频闪关键：避免每次 follow 推入新条目都重建整个数组。
  const curKey = specKey(spec);
  useEffect(() => {
    pendingPages.current.clear();
    if (!result) {
      seq.current++;
      lastSpecKey.current = curKey;
      setEntries([]);
      return;
    }
    const specChanged = lastSpecKey.current !== curKey;
    lastSpecKey.current = curKey;
    setEntries((prev) => {
      const tot = result.total_matched;
      let arr: (LogEntry | undefined)[];
      if (specChanged || prev.length === 0) {
        seq.current++;
        arr = new Array<LogEntry | undefined>(tot);
      } else {
        arr = prev.slice();
        if (arr.length !== tot) arr.length = tot;
      }
      result.page_entries.forEach((e, i) => { arr[i] = e; });
      return arr;
    });
    if (atBottom && listRef.current && result.total_matched > 0) {
      listRef.current.scrollToItem(result.total_matched - 1, 'end');
      clearNewEntriesPending();
    }
  }, [result, curKey, atBottom, clearNewEntriesPending]);

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
    const maxScroll = result.total_matched * ROW_HEIGHT - (listH - 28);
    const isAtBottom = (maxScroll - scrollOffset) < BOTTOM_THRESHOLD;
    setAtBottom(isAtBottom);
    if (isAtBottom && newEntriesPending > 0) {
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
    const isSelected = selectedEntry?.line_no === e.line_no;
    const fieldsTxt = formatFields(e.fields);
    const messageTxt = e.message || e.raw;
    const combined = fieldsTxt ? `${messageTxt}    ${fieldsTxt}` : messageTxt;
    return (
      <div
        style={style}
        onClick={() => setSelectedEntry(isSelected ? null : e)}
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
  // 显示跳到底部按钮：不在底部时一直显示；如果还有未读新条目数显示数字
  const showJumpToBottom = !atBottom && result.total_matched > 0;

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
      {showJumpToBottom && (
        <button
          onClick={jumpToBottom}
          className={[
            'absolute right-6 px-3 py-1.5 text-xs rounded-full shadow-lg z-10 transition-colors',
            newEntriesPending > 0
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50',
          ].join(' ')}
          style={{ bottom: STATUS_BAR_HEIGHT + 16 }}
          title="跳到底部"
        >
          {newEntriesPending > 0
            ? `↓ ${newEntriesPending.toLocaleString()} 条新日志`
            : '↓ 跳到底部'}
        </button>
      )}
      <div className="flex items-center gap-3 px-3 py-1 text-xs border-t bg-slate-50 flex-wrap">
        <span className="font-semibold text-slate-700">
          匹配 {result.total_matched.toLocaleString()} 条
        </span>
        {FOOTER_LEVELS.map((lv) => {
          const n = result.stats.level_counts[lv] ?? 0;
          if (n === 0) return null;
          return (
            <span key={lv} className="flex items-center gap-2">
              <span className="text-slate-300">·</span>
              <span className={FOOTER_LEVEL_COLOR[lv]}>
                {lv.toUpperCase()} {n.toLocaleString()}
              </span>
            </span>
          );
        })}
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
