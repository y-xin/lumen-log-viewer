import { useSession } from '../state/session';
import type { LogLevel } from '../types/log';
import { TrendSparkline } from './TrendSparkline';

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace', 'unknown'];
const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-700',
  warn: 'text-amber-700',
  info: 'text-blue-700',
  debug: 'text-cyan-700',
  trace: 'text-slate-700',
  unknown: 'text-slate-500',
};

export function StatsPanel() {
  const { result, patchSpec } = useSession();
  if (!result) return null;
  const { total, level_counts, top_scopes } = result.stats;

  return (
    <div className="border-b bg-slate-50 px-3 py-2 text-xs">
      <TrendSparkline />
      <div className="flex items-center gap-4 flex-wrap mt-1">
        <span className="font-medium text-slate-700">总数 {total.toLocaleString()}</span>
        {LEVELS.map((lv) => {
          const n = level_counts[lv] ?? 0;
          if (n === 0) return null;
          return (
            <span key={lv} className={LEVEL_COLOR[lv]}>
              {lv.toUpperCase()} {n.toLocaleString()}
            </span>
          );
        })}
      </div>
      {top_scopes.length > 0 && (
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className="text-slate-500">Top scope：</span>
          {top_scopes.map(([name, count]) => (
            <button
              key={name}
              onClick={() => patchSpec({
                scope_filter: { field_name: 'scope', pattern: name, mode: 'exact' },
              })}
              className="px-2 py-0.5 rounded bg-white border hover:bg-slate-100"
              title="点击应用为 scope 筛选"
            >
              {name} <span className="text-slate-400">{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
