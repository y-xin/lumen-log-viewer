// 时间桶趋势图（嵌入 StatsPanel 顶部，约 76px 高，按 level 堆叠）

import { ResponsiveContainer, AreaChart, Area, Tooltip, Brush } from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import { useMemo } from 'react';
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
  const { active, payload, label } = props;
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-white border rounded p-2 text-xs shadow">
      <div className="text-slate-500 mb-1">{fmtBucket(label as string)}</div>
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

export function TrendSparkline() {
  const { result, patchSpec } = useSession();
  const rows = useMemo(() => toRows(result?.stats.time_buckets ?? []), [result]);

  // 数据少于 3 个非零桶时隐藏
  const nonZeroCount = rows.filter((r) => r.error + r.warn + r.info + r.debug + r.trace + r.unknown > 0).length;
  if (nonZeroCount < 3) return null;

  const onBrushChange = (range: { startIndex?: number; endIndex?: number } | null) => {
    if (!range || range.startIndex == null || range.endIndex == null) return;
    if (range.startIndex === 0 && range.endIndex === rows.length - 1) return;
    const from = rows[range.startIndex]?.bucket_start;
    const to = rows[range.endIndex]?.bucket_start;
    if (from && to) patchSpec({ time_range: [from, to] });
  };

  return (
    <div className="w-full" style={{ height: 76 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 2, right: 8, left: 8, bottom: 0 }}>
          <Area dataKey="error"   stackId="1" stroke="#b91c1c" fill="#fecaca" />
          <Area dataKey="warn"    stackId="1" stroke="#a16207" fill="#fde68a" />
          <Area dataKey="info"    stackId="1" stroke="#1d4ed8" fill="#bfdbfe" />
          <Area dataKey="debug"   stackId="1" stroke="#0e7490" fill="#a5f3fc" />
          <Area dataKey="trace"   stackId="1" stroke="#475569" fill="#e2e8f0" />
          <Area dataKey="unknown" stackId="1" stroke="#94a3b8" fill="#f1f5f9" />
          <Tooltip content={renderTooltip} />
          <Brush dataKey="bucket_start" height={12} stroke="#94a3b8" travellerWidth={6} onChange={onBrushChange} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
