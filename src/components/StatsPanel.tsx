// 统计面板：sparkline + 总数 + level 计数 + scope 多选 tags
//
// Scope tag 行为类似 level toggle：
// - 来源：metadata.scope_counts（全文件统计，不随筛选变化）
// - 高亮：在 spec.scope_in 集合内 = 已选；不在 = 未选
// - 点击：toggle 该 scope 在 scope_in 里的成员身份
// - 全部未选时 scope_in 设为 null（= 不限）

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
  const { result, metadata, spec, patchSpec } = useSession();
  if (!result || !metadata) return null;
  const { total, level_counts } = result.stats;

  // 按 count 降序排所有 scope（不限制 Top N — main.log 通常只有十几个）
  const allScopes: [string, number][] = Object.entries(metadata.scope_counts ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const selectedScopes = new Set(spec.scope_in ?? []);
  const hasSelection = selectedScopes.size > 0;

  const toggleScope = (name: string) => {
    const next = new Set(selectedScopes);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    patchSpec({ scope_in: next.size > 0 ? Array.from(next) : null });
  };

  const clearScopes = () => patchSpec({ scope_in: null });

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
      {allScopes.length > 0 && (
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className="text-slate-500">Scope：</span>
          {allScopes.map(([name, count]) => {
            const active = selectedScopes.has(name);
            return (
              <button
                key={name}
                onClick={() => toggleScope(name)}
                className={[
                  'px-2 py-0.5 rounded border transition-colors',
                  active
                    ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100',
                ].join(' ')}
                title={active ? '点击取消' : '点击选中'}
              >
                {name} <span className={active ? 'text-blue-100' : 'text-slate-400'}>{count}</span>
              </button>
            );
          })}
          {hasSelection && (
            <button
              onClick={clearScopes}
              className="px-2 py-0.5 text-slate-500 hover:text-slate-800 underline"
              title="清除所有 scope 选择"
            >
              清除（{selectedScopes.size}）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
