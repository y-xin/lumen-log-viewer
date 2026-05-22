// 筛选栏：level toggle + scope（字段+模式+模式选择） + 关键词 + 时间区间
// 输入有 150ms debounce，对外通过 useSession 的 patchSpec 暴露

import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../state/session';
import type { LogLevel, MatchMode } from '../types/log';
import { ExportMenu } from './ExportMenu';

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'unknown'];
const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: 'bg-slate-200 text-slate-700',
  debug: 'bg-cyan-200 text-cyan-800',
  info: 'bg-blue-200 text-blue-800',
  warn: 'bg-amber-200 text-amber-800',
  error: 'bg-red-200 text-red-800',
  unknown: 'bg-slate-100 text-slate-500',
};

// datetime-local 控件要求 'YYYY-MM-DDTHH:mm' 本地时区格式，但 spec.time_range 存 ISO（UTC）。
// 这两个 helper 只在 UI 边界做格式转换，state/spec 仍统一 ISO。
function isoToLocalInput(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

export function FilterBar() {
  const { spec, patchSpec, metadata } = useSession();

  // 本地输入态（debounce 后再写 store）
  const [keyword, setKeyword] = useState(spec.text_search ?? '');
  const [scopeField, setScopeField] = useState(spec.scope_filter?.field_name ?? 'scope');
  const [scopePattern, setScopePattern] = useState(spec.scope_filter?.pattern ?? '');
  const [scopeMode, setScopeMode] = useState<MatchMode>(spec.scope_filter?.mode ?? 'glob');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // debounce 关键词
  useEffect(() => {
    const t = setTimeout(() => patchSpec({ text_search: keyword || null }), 150);
    return () => clearTimeout(t);
  }, [keyword, patchSpec]);

  // debounce scope 三联：local 输入 → 写入 store
  useEffect(() => {
    const t = setTimeout(() => {
      patchSpec({
        scope_filter: scopePattern
          ? { field_name: scopeField, pattern: scopePattern, mode: scopeMode }
          : null,
      });
    }, 150);
    return () => clearTimeout(t);
  }, [scopeField, scopePattern, scopeMode, patchSpec]);

  // 反向同步：spec.scope_filter 外部变化（如 StatsPanel/DetailDrawer 点击）→ 回填 local
  // 用 JSON 比对当前 local 衍生值与 spec 是否一致，避免无限循环
  useEffect(() => {
    const localDerived = scopePattern
      ? { field_name: scopeField, pattern: scopePattern, mode: scopeMode }
      : null;
    if (JSON.stringify(localDerived) === JSON.stringify(spec.scope_filter)) return;
    setScopeField(spec.scope_filter?.field_name ?? 'scope');
    setScopePattern(spec.scope_filter?.pattern ?? '');
    setScopeMode(spec.scope_filter?.mode ?? 'glob');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.scope_filter]);

  // debounce 时间
  useEffect(() => {
    const t = setTimeout(() => {
      const tr: [string, string] | null = from && to ? [from, to] : null;
      patchSpec({ time_range: tr });
    }, 150);
    return () => clearTimeout(t);
  }, [from, to, patchSpec]);

  const fieldOptions = useMemo(() => {
    // "scope" + 当前文件出现过的 fields 名（MVP 简化：只列 "scope"）
    return ['scope'];
  }, [metadata]);

  const toggleLevel = (lv: LogLevel) => {
    const current = new Set(spec.levels ?? LEVELS);
    if (current.has(lv)) current.delete(lv); else current.add(lv);
    patchSpec({ levels: Array.from(current) });
  };

  const activeLevels = new Set(spec.levels ?? LEVELS);

  return (
    <div className="p-2 border-b bg-white space-y-1">
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-slate-500">级别：</span>
        {LEVELS.map((lv) => (
          <button
            key={lv}
            onClick={() => toggleLevel(lv)}
            className={[
              'px-2 py-0.5 rounded text-xs uppercase tracking-wide',
              activeLevels.has(lv) ? LEVEL_COLOR[lv] : 'bg-slate-50 text-slate-400 line-through',
            ].join(' ')}
          >
            {lv}
          </button>
        ))}
        <div className="ml-auto"><ExportMenu /></div>
      </div>

      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-slate-500">Scope：</span>
        <select
          value={scopeField}
          onChange={(e) => setScopeField(e.target.value)}
          className="select-ctl"
        >
          {fieldOptions.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <div className="relative flex-1 max-w-xs">
          <input
            value={scopePattern}
            onChange={(e) => setScopePattern(e.target.value)}
            placeholder="模式（如 auth.* 或 user-service）"
            className="input-ctl w-full pr-6"
          />
          {scopePattern && (
            <button
              onClick={() => setScopePattern('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 text-xs leading-none px-1"
              title="清除 scope 筛选"
            >
              ✕
            </button>
          )}
        </div>
        <div className="ctl-segment">
          {(['exact', 'glob', 'regex'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setScopeMode(m)}
              className={scopeMode === m ? 'active' : ''}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-slate-500">关键词：</span>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="在 message / 原始行中搜索"
          className="input-ctl flex-1 max-w-md"
        />
        <span className="text-slate-500 ml-2">时间：</span>
        <input
          type="datetime-local"
          value={isoToLocalInput(from)}
          onChange={(e) => setFrom(localInputToIso(e.target.value))}
          className="input-ctl text-[11px]"
          style={{ width: 180 }}
        />
        <span className="text-slate-400">~</span>
        <input
          type="datetime-local"
          value={isoToLocalInput(to)}
          onChange={(e) => setTo(localInputToIso(e.target.value))}
          className="input-ctl text-[11px]"
          style={{ width: 180 }}
        />
      </div>
    </div>
  );
}
