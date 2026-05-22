// 详情抽屉：右侧滑出，显示选中行的 fields + raw + 快捷筛选按钮

import { useMemo } from 'react';
import { useSession } from '../state/session';
import { useKeyboardNav } from '../hooks/useKeyboardNav';
import type { LogEntry } from '../types/log';

export function DetailDrawer() {
  const { result, selectedLineNo, setSelectedLineNo, patchSpec } = useSession();
  useKeyboardNav();

  const entry: LogEntry | undefined = useMemo(() => {
    if (selectedLineNo == null || !result) return undefined;
    return result.page_entries.find((e) => e.line_no === selectedLineNo);
  }, [selectedLineNo, result]);

  if (!entry) return null;

  const fieldEntries = Object.entries(entry.fields);
  const lineLabel = entry.line_count > 1
    ? `#${entry.line_no}–${entry.line_no + entry.line_count - 1} (${entry.line_count} 行)`
    : `#${entry.line_no}`;

  const applyScope = () => {
    if (!entry.scope) return;
    patchSpec({ scope_filter: { field_name: 'scope', pattern: entry.scope, mode: 'exact' } });
  };

  const applyTimeWindow = () => {
    if (!entry.timestamp) return;
    const t = new Date(entry.timestamp).getTime();
    const from = new Date(t - 5 * 60_000).toISOString();
    const to = new Date(t + 5 * 60_000).toISOString();
    patchSpec({ time_range: [from, to] });
  };

  const copyRaw = () => {
    navigator.clipboard.writeText(entry.raw).catch(() => {});
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-transparent z-20"
        onClick={() => setSelectedLineNo(null)}
      />
      <aside
        className="fixed top-0 right-0 h-full w-[35vw] min-w-[380px] max-w-[720px] bg-white shadow-xl border-l z-30 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-2 border-b">
          <h3 className="text-sm font-semibold">详情 {lineLabel}</h3>
          <button
            onClick={() => setSelectedLineNo(null)}
            className="text-slate-500 hover:text-slate-700"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
          <section className="grid grid-cols-2 gap-2 text-xs">
            <Field label="时间" value={entry.timestamp ?? '-'} />
            <Field label="级别" value={entry.level.toUpperCase()} />
            <Field label="Scope" value={entry.scope ?? '-'} />
            <Field label="行号" value={lineLabel} />
          </section>

          <section>
            <div className="text-xs text-slate-500 mb-1">Message</div>
            <div className="border rounded p-2 font-mono text-xs whitespace-pre-wrap break-words">
              {entry.message || '(空)'}
            </div>
          </section>

          {fieldEntries.length > 0 && (
            <section>
              <div className="text-xs text-slate-500 mb-1">Fields ({fieldEntries.length})</div>
              <div className="border rounded divide-y text-xs">
                {fieldEntries.map(([k, v]) => (
                  <div key={k} className="flex gap-2 px-2 py-1 font-mono">
                    <span className="text-slate-500 min-w-[100px]">{k}</span>
                    <span className="flex-1 break-all">{v}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-slate-500">Raw</span>
              <button onClick={copyRaw} className="text-xs text-blue-600 hover:underline">📋 复制</button>
            </div>
            <div className="border rounded p-2 font-mono text-xs whitespace-pre-wrap break-words bg-slate-50">
              {entry.raw}
            </div>
          </section>

          <section className="flex gap-2 pt-2">
            <button
              onClick={applyScope}
              disabled={!entry.scope}
              className="px-3 py-1 text-xs bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-50"
            >
              应用 scope 筛选
            </button>
            <button
              onClick={applyTimeWindow}
              disabled={!entry.timestamp}
              className="px-3 py-1 text-xs bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-50"
            >
              按时间区间 ±5 分钟
            </button>
          </section>
        </div>
      </aside>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-slate-500">{label}</div>
      <div className="font-mono break-all">{value}</div>
    </div>
  );
}
