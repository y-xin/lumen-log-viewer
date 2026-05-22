// 最近文件下拉：在 OpenFileButton 旁，展示最近 10 个打开过的文件
// 点击任意一个直接调 openFile 加载

import { useEffect, useState } from 'react';
import { listRecentFiles, clearRecentFiles, openFile } from '../api/commands';
import { useSession } from '../state/session';

export function RecentFilesMenu() {
  const { setMetadata, setError, setLoading, setResult, metadata } = useSession();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);

  // 每次菜单打开 + metadata 变化时刷新（打开新文件后下次菜单展开看到最新)
  const refresh = async () => {
    try {
      const list = await listRecentFiles();
      setRecent(list);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    }
  };

  useEffect(() => { refresh(); }, [metadata]);

  const handleOpen = async (path: string) => {
    setOpen(false);
    setError(null);
    try {
      setLoading(true);
      setResult(null);
      const md = await openFile(path);
      setMetadata(md);
    } catch (e) {
      const msg = typeof e === 'string' ? e : JSON.stringify(e);
      setError(`打开失败：${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    if (!confirm('清除最近打开列表？')) return;
    await clearRecentFiles();
    await refresh();
  };

  const formatPath = (p: string): { name: string; dir: string } => {
    const idx = p.lastIndexOf('/');
    if (idx < 0) return { name: p, dir: '' };
    return { name: p.slice(idx + 1), dir: p.slice(0, idx) };
  };

  return (
    <div className="relative">
      <button
        onClick={() => { refresh(); setOpen((v) => !v); }}
        className="px-2 py-1.5 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50"
        title="最近打开"
      >
        ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-[28rem] bg-white border rounded shadow-lg z-20 text-sm">
            <div className="px-3 py-1.5 text-xs text-slate-500 border-b flex items-center justify-between">
              <span>最近打开</span>
              {recent.length > 0 && (
                <button
                  onClick={handleClear}
                  className="text-slate-400 hover:text-red-600 text-xs"
                >
                  清除
                </button>
              )}
            </div>
            {recent.length === 0 && (
              <div className="px-3 py-3 text-slate-400 italic text-xs">(无最近文件)</div>
            )}
            {recent.map((p) => {
              const { name, dir } = formatPath(p);
              const isCurrent = metadata?.path === p;
              return (
                <button
                  key={p}
                  onClick={() => handleOpen(p)}
                  className={[
                    'w-full text-left px-3 py-1.5 hover:bg-slate-100 flex flex-col',
                    isCurrent ? 'bg-blue-50' : '',
                  ].join(' ')}
                  title={p}
                >
                  <span className="text-slate-800 truncate">
                    {isCurrent ? '✓ ' : ''}{name}
                  </span>
                  <span className="text-slate-400 text-xs truncate">{dir}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
