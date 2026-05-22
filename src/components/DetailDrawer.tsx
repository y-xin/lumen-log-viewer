// 详情抽屉：右侧滑出，显示选中行的 fields + raw + 快捷筛选按钮
// 关键：直接读 selectedEntry（store 里整个对象），而不是 line_no 反向查 page_entries —
//      避免几万行后的行因不在首页就找不到。

import { useEffect, useState } from 'react';
import { useSession } from '../state/session';
import { getNeighbor, getPosition } from '../api/commands';
import { HighlightedText } from './HighlightedText';

export function DetailDrawer() {
  const { selectedEntry, setSelectedEntry, patchSpec, spec } = useSession();

  const [position, setPosition] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  // drawer 首次打开 / selectedEntry 切换 / spec 变化 → 重新算 position
  useEffect(() => {
    if (!selectedEntry) { setPosition(null); setTotal(null); return; }
    getPosition(spec, selectedEntry.line_no).then((p) => {
      if (p) { setPosition(p.position); setTotal(p.total); }
      else { setPosition(null); setTotal(null); }
    }).catch(() => { setPosition(null); setTotal(null); });
  }, [selectedEntry?.line_no, spec]);

  const onPrev = async () => {
    if (!selectedEntry) return;
    const n = await getNeighbor(spec, selectedEntry.line_no, 'prev');
    if (n) { setSelectedEntry(n.entry); setPosition(n.position); setTotal(n.total); }
  };
  const onNext = async () => {
    if (!selectedEntry) return;
    const n = await getNeighbor(spec, selectedEntry.line_no, 'next');
    if (n) { setSelectedEntry(n.entry); setPosition(n.position); setTotal(n.total); }
  };

  const canPrev = position != null && position > 1;
  const canNext = position != null && total != null && position < total;

  if (!selectedEntry) return null;
  const entry = selectedEntry;

  const fieldEntries = Object.entries(entry.fields);
  const lineLabel = entry.line_count > 1
    ? `${entry.line_no}–${entry.line_no + entry.line_count - 1} (${entry.line_count} 行)`
    : `${entry.line_no}`;

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

  // 不用 overlay：列表区保持可交互，点别的行可以直接切换详情。
  // 关闭路径：右上 ✕、Esc（useKeyboardNav）、再点一次同一行（LogList 行 toggle）。
  return (
    <aside className="fixed top-0 right-0 h-full w-[35vw] min-w-[380px] max-w-[720px] bg-white shadow-xl border-l z-30 flex flex-col">
      <header className="flex items-center gap-2 px-4 py-2 border-b">
        <button
          onClick={onPrev}
          disabled={!canPrev}
          className="ctl disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ minWidth: 32, justifyContent: 'center' }}
          title="上一条 matched"
        >↑</button>
        <button
          onClick={onNext}
          disabled={!canNext}
          className="ctl disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ minWidth: 32, justifyContent: 'center' }}
          title="下一条 matched"
        >↓</button>
        <span className="text-xs text-slate-500 min-w-[140px]">
          {position != null && total != null
            ? `第 ${position} / 共 ${total} 条匹配`
            : selectedEntry
              ? '已不在筛选结果中'
              : '—'}
        </span>
        <h3 className="text-sm font-semibold ml-2">详情 #{lineLabel}</h3>
        <button
          onClick={() => setSelectedEntry(null)}
          className="ml-auto text-slate-500 hover:text-slate-700"
          title="关闭 (Esc)"
        >
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm selectable">
        <section className="grid grid-cols-2 gap-2 text-xs">
          <Field label="时间" value={entry.timestamp ?? '-'} />
          <Field label="级别" value={entry.level.toUpperCase()} />
          <Field label="Scope" value={entry.scope ?? '-'} />
          <Field label="行号" value={lineLabel} />
        </section>

        <section>
          <div className="text-xs text-slate-500 mb-1">Message</div>
          <div className="border rounded p-2 font-mono text-xs whitespace-pre-wrap break-words">
            {entry.message
              ? <HighlightedText text={entry.message} needle={spec.text_search ?? ''} />
              : '(空)'}
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
              <HighlightedText text={entry.raw} needle={spec.text_search ?? ''} />
            </div>
        </section>

        <section className="flex gap-2 pt-2">
          <button onClick={applyScope} disabled={!entry.scope} className="ctl">
            应用 scope 筛选
          </button>
          <button onClick={applyTimeWindow} disabled={!entry.timestamp} className="ctl">
            按时间区间 ±5 分钟
          </button>
        </section>
      </div>
    </aside>
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
