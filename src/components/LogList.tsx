// 虚拟列表：滚动到第 N 页边界时按需 fetch 下一页
// 列：行号 / 时间 / level / scope / message+fields（可拖动调整 4 个边界）

import { useCallback, useEffect, useRef, useState } from 'react';
import { VariableSizeList as List, ListChildComponentProps, ListOnItemsRenderedProps } from 'react-window';
import { getPage, getColumnWidths, saveColumnWidths, getColumnVisibility, saveColumnVisibility } from '../api/commands';
import { useSession } from '../state/session';
import type { LogEntry, LogLevel } from '../types/log';
import { HighlightedText } from './HighlightedText';

const PAGE_SIZE = 200;
const ROW_HEIGHT = 28;
const EXPANDED_LINE_HEIGHT = 16;          // 展开块每额外一行的高度
const EXPANDED_MAX_EXTRA_LINES = 10;       // 单个 entry 展开最多额外显示 10 行（防止占满视口）
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
const COL_LABELS: Record<ColKey, string> = {
  line: '行号', time: '时间', level: '级别', scope: 'Scope',
};
const DEFAULT_WIDTHS: Record<ColKey, number> = {
  line: 70,
  time: 180,
  level: 56,
  scope: 160,
};
const DEFAULT_VISIBILITY: Record<ColKey, boolean> = {
  line: true, time: true, level: true, scope: true,
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

// 返回 raw 去掉首行后的剩余部分（已 trim 行末换行残留）
function restOfRaw(raw: string): string {
  const i = raw.indexOf('\n');
  if (i < 0) return '';
  return raw.slice(i + 1);
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
  // 多行 entry 展开状态：line_no → 是否展开
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
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

  // ─── 列宽（可拖动 + 持久化到 prefs.json） ────────────────────────────────────
  const [widths, setWidths] = useState<Record<ColKey, number>>(DEFAULT_WIDTHS);

  // 启动时拉一次列宽偏好
  useEffect(() => {
    let cancelled = false;
    getColumnWidths()
      .then((saved) => {
        if (cancelled || !saved) return;
        // 只覆盖识别的 key，未知 key 丢弃
        const next: Record<ColKey, number> = { ...DEFAULT_WIDTHS };
        (Object.keys(DEFAULT_WIDTHS) as ColKey[]).forEach((k) => {
          const v = saved[k];
          if (typeof v === 'number' && v >= MIN_WIDTH) next[k] = v;
        });
        setWidths(next);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 列宽变化后 debounced 持久化（防拖动期间疯狂 IO）
  const persistTimer = useRef<number | null>(null);
  useEffect(() => {
    if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      saveColumnWidths(widths).catch(() => {});
    }, 400);
    return () => {
      if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    };
  }, [widths]);

  // 列显隐 + 持久化（即时写，频率低无需 debounce）
  const [visibility, setVisibility] = useState<Record<ColKey, boolean>>(DEFAULT_VISIBILITY);
  useEffect(() => {
    let cancelled = false;
    getColumnVisibility()
      .then((saved) => {
        if (cancelled || !saved) return;
        const next: Record<ColKey, boolean> = { ...DEFAULT_VISIBILITY };
        (Object.keys(DEFAULT_VISIBILITY) as ColKey[]).forEach((k) => {
          if (typeof saved[k] === 'boolean') next[k] = saved[k];
        });
        setVisibility(next);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const toggleColumn = (col: ColKey) => {
    setVisibility((prev) => {
      const next = { ...prev, [col]: !prev[col] };
      saveColumnVisibility(next).catch(() => {});
      return next;
    });
  };
  const [colMenuOpen, setColMenuOpen] = useState(false);

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

  // 文件切换 / spec 变化 → 清空展开状态 + 刷 VariableSizeList 尺寸缓存
  useEffect(() => {
    setExpanded(new Set());
    listRef.current?.resetAfterIndex(0);
  }, [curKey]);

  // 行高动态计算：折叠 28px / 展开 28 + (line_count-1) * 16，但单 entry 上限 11 行
  const getItemSize = useCallback((index: number) => {
    const e = entries[index];
    if (!e || e.line_count <= 1) return ROW_HEIGHT;
    if (!expanded.has(e.line_no)) return ROW_HEIGHT;
    const extra = Math.min(e.line_count - 1, EXPANDED_MAX_EXTRA_LINES);
    return ROW_HEIGHT + extra * EXPANDED_LINE_HEIGHT;
  }, [entries, expanded]);

  const toggleExpand = useCallback((lineNo: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(lineNo)) next.delete(lineNo); else next.add(lineNo);
      return next;
    });
    // 立即清除尺寸缓存，下次 render 用新高度
    listRef.current?.resetAfterIndex(0);
  }, []);

  // selectedEntry 变化时也清缓存（防 row content 变化导致高度过期 — 实际无 height 变化，但保险）
  // 这里不做，避免不必要 reset。展开 toggle 和 spec 变化已经覆盖。

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

  // VariableSizeList 下行高不固定 → 用 onItemsRendered 的 visibleStopIndex 判断 atBottom
  const onItemsRendered = ({ visibleStopIndex }: ListOnItemsRenderedProps) => {
    if (!result || result.total_matched === 0) return;
    const isAtBottom = visibleStopIndex >= result.total_matched - 1;
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
    const isMultiline = e.line_count > 1;
    const isExpanded = isMultiline && expanded.has(e.line_no);
    const fieldsTxt = formatFields(e.fields);
    const messageTxt = e.message || e.raw;
    const combined = fieldsTxt ? `${messageTxt}    ${fieldsTxt}` : messageTxt;
    // 展开块左侧缩进对齐到 message 列起点（仅累加可见列宽）
    const expandedIndent =
      (visibility.line ? widths.line : 0) +
      (visibility.time ? widths.time : 0) +
      (visibility.level ? widths.level : 0) +
      (visibility.scope ? widths.scope : 0) + 8;
    // 展开块裁掉 raw 首行 + 可能截断到上限
    let restRaw = restOfRaw(e.raw);
    const restLines = restRaw ? restRaw.split('\n') : [];
    let truncatedNote: string | null = null;
    if (restLines.length > EXPANDED_MAX_EXTRA_LINES) {
      restRaw = restLines.slice(0, EXPANDED_MAX_EXTRA_LINES).join('\n');
      truncatedNote = `… 余 ${restLines.length - EXPANDED_MAX_EXTRA_LINES} 行未显示（查看详情抽屉 Raw 区）`;
    }

    return (
      <div
        style={style}
        // 用 mousedown 而不是 click：tail-follow 模式下列表持续 scrollToItem，
        // mousedown→mouseup 之间 DOM 已滚动，click 事件不会触发；改用 mousedown 在按下瞬间锁定选择。
        onMouseDown={() => setSelectedEntry(isSelected ? null : e)}
        className={[
          'text-xs flex flex-col font-mono border-b border-slate-100 cursor-pointer',
          isSelected ? 'bg-blue-50' : 'hover:bg-slate-50',
        ].join(' ')}
      >
        <div className="px-2 flex items-stretch gap-0" style={{ height: ROW_HEIGHT }}>
          {visibility.line && (
            <span style={{ width: widths.line }} className="flex items-center text-slate-400 text-right justify-end pr-2">
              {lineLabel(e)}
            </span>
          )}
          {visibility.time && (
            <span style={{ width: widths.time }} className="flex items-center text-slate-500 truncate px-2">
              {e.timestamp ?? '-'}
            </span>
          )}
          {visibility.level && (
            <span style={{ width: widths.level }} className={['flex items-center uppercase px-2', LEVEL_COLOR[e.level]].join(' ')}>
              {e.level}
            </span>
          )}
          {visibility.scope && (
            <span style={{ width: widths.scope }} className="flex items-center text-slate-600 truncate px-2">
              {e.scope ?? '-'}
            </span>
          )}
          <span className="flex-1 flex items-center truncate px-2" title={combined}>
            <HighlightedText text={combined} needle={spec.text_search ?? ''} />
          </span>
          {isMultiline && (
            <button
              onMouseDown={(ev) => { ev.stopPropagation(); }}
              onClick={(ev) => { ev.stopPropagation(); toggleExpand(e.line_no); }}
              className="text-slate-400 hover:text-slate-700 px-2 self-stretch flex items-center"
              title={isExpanded ? `折叠（${e.line_count} 行）` : `展开（${e.line_count} 行）`}
            >
              {isExpanded ? '▾' : '▸'} {e.line_count}
            </button>
          )}
        </div>
        {isExpanded && restRaw && (
          <div
            className="font-mono text-xs whitespace-pre text-slate-600 bg-slate-50/60 border-t border-slate-100 overflow-hidden"
            style={{ paddingLeft: expandedIndent, paddingRight: 8, paddingTop: 2, paddingBottom: 2, lineHeight: `${EXPANDED_LINE_HEIGHT}px` }}
          >
            <HighlightedText text={restRaw} needle={spec.text_search ?? ''} />
            {truncatedNote && <div className="text-slate-400 italic mt-1">{truncatedNote}</div>}
          </div>
        )}
      </div>
    );
  };

  if (!result) return null;
  // 显示跳到底部按钮：不在底部时一直显示；如果还有未读新条目数显示数字
  const showJumpToBottom = !atBottom && result.total_matched > 0;

  // 表头：与 Row 列宽对齐，列之间放可拖动的 resizer；最右侧 ⚙ 控制列显隐
  const Header = () => (
    <div className="flex items-stretch text-xs font-medium text-slate-500 bg-slate-50 border-b border-slate-200 select-none relative">
      {visibility.line && (
        <>
          <div style={{ width: widths.line }} className="flex items-center justify-end pr-2 py-1">行号</div>
          <Resizer onMouseDown={(e) => startResize('line', e)} />
        </>
      )}
      {visibility.time && (
        <>
          <div style={{ width: widths.time }} className="flex items-center px-2 py-1">时间</div>
          <Resizer onMouseDown={(e) => startResize('time', e)} />
        </>
      )}
      {visibility.level && (
        <>
          <div style={{ width: widths.level }} className="flex items-center px-2 py-1">级别</div>
          <Resizer onMouseDown={(e) => startResize('level', e)} />
        </>
      )}
      {visibility.scope && (
        <>
          <div style={{ width: widths.scope }} className="flex items-center px-2 py-1">Scope</div>
          <Resizer onMouseDown={(e) => startResize('scope', e)} />
        </>
      )}
      <div className="flex-1 flex items-center px-2 py-1">Message + Fields</div>
      <button
        onClick={() => setColMenuOpen((v) => !v)}
        className="px-2 text-slate-400 hover:text-slate-700"
        title="显示/隐藏列"
      >⚙</button>
      {colMenuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setColMenuOpen(false)} />
          <div className="absolute top-full right-0 mt-1 w-44 bg-white border rounded shadow-lg z-20 text-xs">
            <div className="px-3 py-1.5 text-slate-500 border-b">显示列</div>
            {(Object.keys(DEFAULT_VISIBILITY) as ColKey[]).map((k) => (
              <label
                key={k}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-100 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={visibility[k]}
                  onChange={() => toggleColumn(k)}
                />
                <span>{COL_LABELS[k]}</span>
              </label>
            ))}
            <div className="px-3 py-1 text-slate-400 italic border-t">Message 列固定显示</div>
          </div>
        </>
      )}
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
          itemSize={getItemSize}
          estimatedItemSize={ROW_HEIGHT}
          width="100%"
          onItemsRendered={onItemsRendered}
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
