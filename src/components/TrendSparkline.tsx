// 时间桶趋势图（嵌入 StatsPanel 顶部，约 76px 高，按 level 堆叠）

import { ResponsiveContainer, AreaChart, Area, Tooltip, Brush } from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import { useEffect, useMemo, useRef } from 'react';
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

function fmtBucket(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch { return ts; }
}

function renderTooltip(props: TooltipContentProps<ValueType, NameType>) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  // 直接从 payload[0].payload 取原始 bucket_start，不依赖 recharts label
  // （没有 <XAxis dataKey="bucket_start" /> 时 label 是数组 index，new Date(0) → 1970）
  const row = payload[0]?.payload as ChartRow | undefined;
  const ts = row?.bucket_start ?? '';
  return (
    <div className="bg-white border rounded p-2 text-xs shadow">
      <div className="text-slate-500 mb-1">{ts ? fmtBucket(ts) : '-'}</div>
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

// brush 内时间戳显示 HH:mm（横向占位小，避免拥挤）
function fmtBrushTick(ts: string): string {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

export function TrendSparkline() {
  const { result, patchSpec, spec } = useSession();
  const rows = useMemo(() => toRows(result?.stats.time_buckets ?? []), [result]);

  // 数据少于 3 个非零桶时隐藏
  const nonZeroCount = rows.filter((r) => r.error + r.warn + r.info + r.debug + r.trace + r.unknown > 0).length;

  // brush 拖动 debounce：避免每次 onChange 都 patchSpec → useAutoQuery 风暴
  // 累计最新 range 在 ref，250ms 后才提交（拖动停止后才触发查询）
  const pendingRange = useRef<{ from: string; to: string } | null>(null);
  const commitTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (commitTimer.current != null) window.clearTimeout(commitTimer.current);
  }, []);

  if (nonZeroCount < 3) return null;

  const onBrushChange = (range: { startIndex?: number; endIndex?: number } | null) => {
    if (!range || range.startIndex == null || range.endIndex == null) return;
    // 全选范围（首尾）→ 视作 "取消时间筛选"
    if (range.startIndex === 0 && range.endIndex === rows.length - 1) {
      pendingRange.current = null;
      if (commitTimer.current != null) window.clearTimeout(commitTimer.current);
      commitTimer.current = window.setTimeout(() => {
        if (spec.time_range) patchSpec({ time_range: null });
      }, 250);
      return;
    }
    const from = rows[range.startIndex]?.bucket_start;
    const to = rows[range.endIndex]?.bucket_start;
    if (!from || !to) return;
    pendingRange.current = { from, to };
    if (commitTimer.current != null) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      if (pendingRange.current) {
        patchSpec({ time_range: [pendingRange.current.from, pendingRange.current.to] });
      }
    }, 250);
  };

  return (
    <div className="w-full relative" style={{ height: 92 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 2, right: 8, left: 8, bottom: 0 }}>
          <Area dataKey="error"   stackId="1" stroke="#b91c1c" fill="#fecaca" />
          <Area dataKey="warn"    stackId="1" stroke="#a16207" fill="#fde68a" />
          <Area dataKey="info"    stackId="1" stroke="#1d4ed8" fill="#bfdbfe" />
          <Area dataKey="debug"   stackId="1" stroke="#0e7490" fill="#a5f3fc" />
          <Area dataKey="trace"   stackId="1" stroke="#475569" fill="#e2e8f0" />
          <Area dataKey="unknown" stackId="1" stroke="#94a3b8" fill="#f1f5f9" />
          <Tooltip content={renderTooltip} />
          {/* 把手放高：height 28 + travellerWidth 14；fill 加深选区让边界可见 */}
          <Brush
            dataKey="bucket_start"
            height={28}
            stroke="#64748b"
            travellerWidth={14}
            fill="#eff6ff"
            tickFormatter={fmtBrushTick}
            onChange={onBrushChange}
          />
        </AreaChart>
      </ResponsiveContainer>
      {spec.time_range && (
        <button
          onClick={() => patchSpec({ time_range: null })}
          className="absolute top-1 right-1 text-xs text-slate-500 hover:text-slate-800 bg-white/70 backdrop-blur px-2 py-0.5 rounded border border-slate-200"
          title="清除图表时间筛选（也可双击 brush 把手回到首尾）"
        >
          清除时间区间 ✕
        </button>
      )}
    </div>
  );
}
