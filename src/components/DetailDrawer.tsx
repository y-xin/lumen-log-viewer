// 详情抽屉：右侧滑出，显示选中行的 fields + raw + 快捷筛选按钮
// 关键：直接读 selectedEntry（store 里整个对象），而不是 line_no 反向查 page_entries —
//      避免几万行后的行因不在首页就找不到。

import { useEffect, useState } from 'react';
import { useSession } from '../state/session';
import { getNeighbor, getPosition, saveDetailDock } from '../api/commands';
import { copyText } from '../api/clipboard';
import { HighlightedText } from './HighlightedText';

export function DetailDrawer() {
  const { selectedEntry, setSelectedEntry, patchSpec, spec } = useSession();
  const fontSize = useSession((s) => s.fontSize);
  const detailDock = useSession((s) => s.detailDock);
  const setDetailDock = useSession((s) => s.setDetailDock);

  const [position, setPosition] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  // 复制反馈：记住刚复制的按钮 id + 成败，1.3s 后清除
  const [copyMsg, setCopyMsg] = useState<{ id: string; ok: boolean } | null>(null);

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
    if (n) {
      setSelectedEntry(n.entry);
      setPosition(n.position);
      setTotal(n.total);
      // 同步滚动列表到新 entry（复用 lv:goto-line 事件，避免给 LogList 钻 prop）
      window.dispatchEvent(new CustomEvent('lv:goto-line', { detail: { lineNo: n.entry.line_no } }));
    }
  };
  const onNext = async () => {
    if (!selectedEntry) return;
    const n = await getNeighbor(spec, selectedEntry.line_no, 'next');
    if (n) {
      setSelectedEntry(n.entry);
      setPosition(n.position);
      setTotal(n.total);
      window.dispatchEvent(new CustomEvent('lv:goto-line', { detail: { lineNo: n.entry.line_no } }));
    }
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

  // 停靠位置切换：right ↔ bottom，写盘记忆（跨窗同步走 lv:prefs-changed）
  const toggleDock = () => {
    const next = detailDock === 'right' ? 'bottom' : 'right';
    setDetailDock(next);
    saveDetailDock(next).catch(() => {});
  };

  // 统一复制入口：走 copyText（WKWebView 下可靠），并给出"已复制/复制失败"反馈
  const doCopy = (id: string, text: string) => {
    copyText(text).then((ok) => {
      setCopyMsg({ id, ok });
      window.setTimeout(() => setCopyMsg((m) => (m && m.id === id ? null : m)), 1300);
    });
  };
  // 按钮文案：刚复制的那个显示反馈，其余显示常态文案
  const copyLabel = (id: string, normal: string) =>
    copyMsg && copyMsg.id === id ? (copyMsg.ok ? '✓ 已复制' : '✕ 失败') : normal;

  const exportEntry = () => {
    // 导出单条 entry 为 JSON 文件（用 anchor download，不需要 tauri save 对话框 — 直接落到浏览器默认下载位置/Tauri 也支持）
    const json = JSON.stringify(entry, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `entry-${entry.line_no}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 不用 overlay：作为 flex 子元素挤压列表（不再盖住）。点别的行可直接切换详情。
  // 关闭路径：右上 ✕、Esc（useKeyboardNav）、再点一次同一行（LogList 行 toggle）。
  // 停靠：right → 右侧固定宽列；bottom → 底部固定高行。
  const dockClass = detailDock === 'bottom'
    ? 'h-[38vh] min-h-[220px] w-full border-t'
    : 'w-[35vw] min-w-[380px] max-w-[720px] h-full border-l';
  return (
    <aside className={`shrink-0 bg-white shadow-xl flex flex-col ${dockClass}`}>
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
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={toggleDock}
            className="text-xs text-slate-500 hover:text-slate-700"
            title={detailDock === 'right' ? '停靠到底部' : '停靠到右侧'}
          >
            {detailDock === 'right' ? '⤓ 底部' : '⤖ 右侧'}
          </button>
          <button
            onClick={() => setSelectedEntry(null)}
            className="text-slate-500 hover:text-slate-700"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm selectable">
        <section className="grid grid-cols-2 gap-2 text-xs">
          <Field label="时间" value={entry.timestamp ? entry.timestamp.replace('T',' ').replace(/Z$/,'').replace(/([+-]\d{2}:?\d{2})$/,'').replace(/(\.\d{3})\d+$/,'$1') : '-'} />
          <Field label="级别" value={entry.level.toUpperCase()} />
          <Field label="Scope" value={entry.scope ?? '-'} />
          <Field label="行号" value={lineLabel} />
        </section>

        <section>
          <div className="flex items-center justify-between mb-1 gap-2">
            <span className="text-xs text-slate-500">Message</span>
            <button
              onClick={() => doCopy('msg', entry.message ?? '')}
              disabled={!entry.message}
              className="text-xs text-blue-600 hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
            >{copyLabel('msg', '📋 复制')}</button>
          </div>
          <div className="border rounded p-2 font-mono whitespace-pre-wrap break-words" style={{ fontSize }}>
            {entry.message
              ? <HighlightedText text={entry.message} needle={spec.text_search ?? ''} />
              : '(空)'}
          </div>
        </section>

        {fieldEntries.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-1 gap-2">
              <span className="text-xs text-slate-500">Fields ({fieldEntries.length})</span>
              <button
                onClick={() => doCopy('fields', fieldEntries.map(([k, v]) => `${k}=${v}`).join('\n'))}
                className="text-xs text-blue-600 hover:underline"
              >{copyLabel('fields', '📋 复制全部')}</button>
            </div>
            <div className="border rounded divide-y text-xs">
              {fieldEntries.map(([k, v]) => (
                <div key={k} className="group flex items-center gap-2 px-2 py-1 font-mono">
                  <span className="text-slate-500 min-w-[100px]">{k}</span>
                  <span className="flex-1 break-all">{v}</span>
                  <button
                    onClick={() => doCopy(`f:${k}`, v)}
                    title="复制该字段值"
                    className="shrink-0 text-blue-600 opacity-0 group-hover:opacity-100 hover:underline"
                  >{copyMsg?.id === `f:${k}` ? (copyMsg.ok ? '✓' : '✕') : '📋'}</button>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="flex items-center justify-between mb-1 gap-2">
            <span className="text-xs text-slate-500">Raw</span>
            <div className="flex items-center gap-2 text-xs">
              <button onClick={() => doCopy('raw', entry.raw)} className="text-blue-600 hover:underline">{copyLabel('raw', '📋 raw')}</button>
              <button onClick={() => doCopy('json', JSON.stringify(entry, null, 2))} className="text-blue-600 hover:underline">{copyLabel('json', '📋 JSON')}</button>
              <button onClick={exportEntry} className="text-blue-600 hover:underline">💾 导出</button>
            </div>
          </div>
          <div className="border rounded p-2 font-mono whitespace-pre-wrap break-words bg-slate-50" style={{ fontSize }}>
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
