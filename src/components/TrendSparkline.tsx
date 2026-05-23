// 时间桶趋势图（嵌入 StatsPanel 顶部）+ Chrome DevTools 风格 overlay 区域选择
// 不再用 recharts Brush（下方迷你条），改为：
//   - 选区外蒙白色半透明（区分内外）
//   - 选区两侧蓝色把手（可拖动 resize）
//   - 选区内可拖动整体平移
//   - 空白区按下拖动 → 新建选区
//   - 双击 → 清除时间筛选
//   - 顶部 5 个时间 tick 提供刻度参考
// 拖动时仅更新本地 hover state；mouseup 才 patchSpec（避免拖动期间 query 风暴）

import { ResponsiveContainer, AreaChart, Area, Tooltip } from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../state/session';
import type { TimeBucket } from '../types/log';

interface ChartRow {
  bucket_start: string;
  error: number;
  warn: number;
  info: number;
  debug: number;
  trace: number;
  unknown: number;
}

function toRows(buckets: TimeBucket[]): ChartRow[] {
  return buckets.map((b) => ({
    bucket_start: b.bucket_start,
    error: b.by_level.error ?? 0,
    warn:  b.by_level.warn  ?? 0,
    info:  b.by_level.info  ?? 0,
    debug: b.by_level.debug ?? 0,
    trace: b.by_level.trace ?? 0,
    unknown: b.by_level.unknown ?? 0,
  }));
}

function fmtFull(ts: string): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch { return ts; }
}

function fmtShort(ts: string): string {
  try {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

function renderTooltip(props: TooltipContentProps<ValueType, NameType>) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as ChartRow | undefined;
  const ts = row?.bucket_start ?? '';
  return (
    <div className="bg-white border rounded p-2 text-xs shadow">
      <div className="text-slate-500 mb-1">{ts ? fmtFull(ts) : '-'}</div>
      {payload
        .filter((p) => typeof p.value === 'number' && p.value > 0)
        .map((p) => {
          const key = String(p.dataKey);
          return (
            <div key={key} style={{ color: p.color }}>
              {key.toUpperCase()}: {p.value as number}
            </div>
          );
        })}
    </div>
  );
}

type DragMode = 'create' | 'move' | 'resize-start' | 'resize-end';
interface DragState {
  mode: DragMode;
  initStart: number;
  initEnd: number;
  anchor: number;   // 鼠标按下时的位置 fraction
}

interface Selection { start: number; end: number; }

const HANDLE_HIT_PX = 10;
const TICK_COUNT = 5;
const TOP_AXIS_H = 11;        // 极紧凑：原 16
const CHART_TOP = TOP_AXIS_H + 1;
const CONTAINER_H = 50;       // 极紧凑：原 110 → 72 → 50

export function TrendSparkline() {
  const { result, patchSpec, spec } = useSession();
  const rows = useMemo(() => toRows(result?.stats.time_buckets ?? []), [result]);

  const nonZeroCount = rows.filter((r) => r.error + r.warn + r.info + r.debug + r.trace + r.unknown > 0).length;

  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [hover, setHover] = useState<Selection | null>(null);

  // 把 spec.time_range（ISO 字符串）映射回 [0,1] fraction（基于 rows 索引）
  const specSelection: Selection | null = useMemo(() => {
    if (!spec.time_range || rows.length < 2) return null;
    const [from, to] = spec.time_range;
    let startIdx = rows.findIndex((r) => r.bucket_start >= from);
    let endIdx = rows.findIndex((r) => r.bucket_start >= to);
    if (startIdx < 0) startIdx = 0;
    if (endIdx < 0) endIdx = rows.length - 1;
    const last = rows.length - 1;
    return { start: startIdx / last, end: endIdx / last };
  }, [spec.time_range, rows]);

  // 显示用：拖动中用 hover，否则用 spec 推算
  const display = hover ?? specSelection;

  // spec.time_range 外部变化（⌘K / 清除按钮）→ 清 hover
  useEffect(() => { if (!dragging) setHover(null); }, [spec.time_range, dragging]);

  const fracFromX = (clientX: number): number => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const commit = (sel: Selection | null) => {
    if (!sel || rows.length < 2) { patchSpec({ time_range: null }); return; }
    const last = rows.length - 1;
    const startIdx = Math.round(sel.start * last);
    const endIdx = Math.round(sel.end * last);
    if (startIdx >= endIdx || (startIdx === 0 && endIdx === last)) {
      patchSpec({ time_range: null });
      return;
    }
    patchSpec({ time_range: [rows[startIdx].bucket_start, rows[endIdx].bucket_start] });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (rows.length < 2) return;
    const frac = fracFromX(e.clientX);
    const el = containerRef.current!;
    const handleFrac = HANDLE_HIT_PX / el.getBoundingClientRect().width;

    if (display) {
      if (Math.abs(frac - display.start) < handleFrac) {
        setDragging({ mode: 'resize-start', initStart: display.start, initEnd: display.end, anchor: frac });
        return;
      }
      if (Math.abs(frac - display.end) < handleFrac) {
        setDragging({ mode: 'resize-end', initStart: display.start, initEnd: display.end, anchor: frac });
        return;
      }
      if (frac > display.start && frac < display.end) {
        setDragging({ mode: 'move', initStart: display.start, initEnd: display.end, anchor: frac });
        return;
      }
    }
    // 空白区 / 选区外按下 → 新建选区
    setDragging({ mode: 'create', initStart: frac, initEnd: frac, anchor: frac });
    setHover({ start: frac, end: frac });
  };

  // window 级 mousemove / mouseup：鼠标滑出容器也能继续拖
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const frac = fracFromX(e.clientX);
      const d = dragging;
      if (d.mode === 'create') {
        setHover({ start: Math.min(d.anchor, frac), end: Math.max(d.anchor, frac) });
      } else if (d.mode === 'resize-start') {
        setHover({ start: Math.min(frac, d.initEnd - 0.005), end: d.initEnd });
      } else if (d.mode === 'resize-end') {
        setHover({ start: d.initStart, end: Math.max(frac, d.initStart + 0.005) });
      } else if (d.mode === 'move') {
        const delta = frac - d.anchor;
        const width = d.initEnd - d.initStart;
        let s = d.initStart + delta;
        let en = d.initEnd + delta;
        if (s < 0) { s = 0; en = width; }
        if (en > 1) { en = 1; s = 1 - width; }
        setHover({ start: s, end: en });
      }
    };
    const onUp = () => {
      const finalSel = hover;
      setDragging(null);
      // 拖出 <1% 宽度 → 视作 click，清除选区
      if (finalSel && finalSel.end - finalSel.start < 0.01) {
        commit(null);
        setHover(null);
        return;
      }
      commit(finalSel);
      // hover 会在 useEffect[spec.time_range] 里被 clear
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, hover, rows]);

  const onDoubleClick = () => {
    if (spec.time_range) patchSpec({ time_range: null });
    setHover(null);
  };

  if (nonZeroCount < 3) return null;

  // 顶部时间 tick：5 等分
  const last = rows.length - 1;
  const ticks = Array.from({ length: TICK_COUNT }, (_, i) => {
    const idx = Math.round((i / (TICK_COUNT - 1)) * last);
    return { frac: i / (TICK_COUNT - 1), ts: rows[idx]?.bucket_start ?? '' };
  });

  // 计算左/右遮罩位置 + 把手位置（百分比字符串）
  const leftPct = display ? `${display.start * 100}%` : '0%';
  const widthPct = display ? `${(display.end - display.start) * 100}%` : '100%';

  return (
    <div
      ref={containerRef}
      className="w-full relative select-none"
      style={{ height: CONTAINER_H, cursor: dragging ? (dragging.mode === 'move' ? 'grabbing' : 'col-resize') : 'crosshair' }}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      title={display ? '拖两侧把手调整 / 拖中间平移 / 双击清除' : '拖选时间区间 · hover 查看每桶详情'}
    >
      {/* 时间 tick 轴（紧凑：9px 字号） */}
      <div className="absolute top-0 left-0 right-0 flex justify-between text-[9px] leading-none text-slate-400 px-2 pointer-events-none" style={{ height: TOP_AXIS_H, paddingTop: 1 }}>
        {ticks.map((t, i) => (
          <span key={i}>{fmtShort(t.ts)}</span>
        ))}
      </div>

      {/* AreaChart 占下半 — 保持指针事件可达，让 Tooltip 工作；mousedown 冒泡到外层处理 */}
      <div className="absolute left-0 right-0 bottom-0" style={{ top: CHART_TOP }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 2, right: 8, left: 8, bottom: 0 }}>
            <Area dataKey="error"   stackId="1" stroke="#b91c1c" fill="#fecaca" />
            <Area dataKey="warn"    stackId="1" stroke="#a16207" fill="#fde68a" />
            <Area dataKey="info"    stackId="1" stroke="#1d4ed8" fill="#bfdbfe" />
            <Area dataKey="debug"   stackId="1" stroke="#0e7490" fill="#a5f3fc" />
            <Area dataKey="trace"   stackId="1" stroke="#475569" fill="#e2e8f0" />
            <Area dataKey="unknown" stackId="1" stroke="#94a3b8" fill="#f1f5f9" />
            <Tooltip content={renderTooltip} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* 选区可视层 — 全部 pointer-events-none（避免遮挡 Tooltip）；mousedown 由外层处理 */}
      {display && (
        <div className="absolute inset-0 pointer-events-none">
          {/* 左侧 dim */}
          <div className="absolute top-0 bottom-0 left-0 bg-white/55" style={{ width: leftPct }} />
          {/* 右侧 dim */}
          <div className="absolute top-0 bottom-0 right-0 bg-white/55" style={{ width: `calc(100% - ${leftPct} - ${widthPct})` }} />
          {/* 选区描边 + 浅蓝填充 */}
          <div
            className="absolute top-0 bottom-0 border-l-2 border-r-2 border-blue-500"
            style={{ left: leftPct, width: widthPct, background: 'rgba(59,130,246,0.06)' }}
          />
        </div>
      )}
      {/* 拖动中浮提示 */}
      {dragging && hover && (
        <div className="absolute top-1 left-1/2 -translate-x-1/2 text-[11px] bg-slate-800 text-white px-2 py-0.5 rounded shadow pointer-events-none z-20">
          {fmtShort(rows[Math.round(hover.start * last)]?.bucket_start ?? '')} ~ {fmtShort(rows[Math.round(hover.end * last)]?.bucket_start ?? '')}
        </div>
      )}
      {/* 已选时清除按钮（右上）— 高 z + pointer-events 自带 */}
      {spec.time_range && !dragging && (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => patchSpec({ time_range: null })}
          className="absolute top-0 right-2 text-[10px] text-slate-500 hover:text-slate-800 bg-white/80 backdrop-blur px-1.5 rounded border border-slate-200 z-30"
          title="清除时间筛选（也可双击图表）"
          style={{ height: TOP_AXIS_H }}
        >
          清除 ✕
        </button>
      )}
    </div>
  );
}
