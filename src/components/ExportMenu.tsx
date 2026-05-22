// 导出菜单：在 FilterBar 右侧。选格式 → tauri save dialog → 调 cmd_export
// 期间按钮显示 spinner；完成显示一行 inline toast，3 秒消失

import { useEffect, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { exportToFile } from '../api/commands';
import { useSession } from '../state/session';
import type { ExportFormat } from '../types/log';

interface Option {
  label: string;
  format: ExportFormat;
  ext: string;
}

const OPTIONS: Option[] = [
  { label: 'CSV (.csv)',           format: 'csv',        ext: 'csv'  },
  { label: 'JSON Lines (.jsonl)',  format: 'jsonl',      ext: 'jsonl'},
  { label: 'JSON Array (.json)',   format: 'json_array', ext: 'json' },
];

function defaultName(path: string | undefined, ext: string): string {
  const base = path
    ? path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'export'
    : 'export';
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${base}-export-${ts}.${ext}`;
}

export function ExportMenu() {
  const { spec, metadata, setError } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 接收 ⌘E 全局快捷键：打开下拉
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('lv:open-export', handler);
    return () => window.removeEventListener('lv:open-export', handler);
  }, []);

  if (!metadata) return null;

  const handle = async (opt: Option) => {
    setOpen(false);
    setError(null);
    const target = await save({
      defaultPath: defaultName(metadata.path, opt.ext),
      filters: [{ name: opt.label, extensions: [opt.ext] }],
    });
    if (typeof target !== 'string') return;
    try {
      setBusy(true);
      const r = await exportToFile(spec, opt.format, target);
      setToast(`已导出 ${r.count.toLocaleString()} 条到 ${target.split('/').pop()}`);
      setTimeout(() => setToast(null), 3000);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="ctl"
        title="导出当前匹配条目"
      >
        {busy ? '导出中…' : '📥 导出 ▾'}
      </button>
      {open && !busy && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1 w-56 bg-white border rounded shadow-lg z-20 text-xs">
            {OPTIONS.map((opt) => (
              <button
                key={opt.format}
                onClick={() => handle(opt)}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-100"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
      {toast && (
        <div className="absolute top-full right-0 mt-1 px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded text-xs whitespace-nowrap shadow z-20">
          {toast}
        </div>
      )}
    </div>
  );
}
