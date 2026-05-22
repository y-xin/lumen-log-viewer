// 顶部"📂 打开 + ▾"复合按钮：
// - 左半"📂 打开"：tauri open dialog → loadFile
// - 右半"▾"：下拉显示最近文件 → 点选直接打开

import { useEffect, useState } from 'react';
import { openFile, listRecentFiles, clearRecentFiles } from '../api/commands';
import { openFileViaDialog } from '../api/dialog';
import { useSession } from '../state/session';

function formatPath(p: string): { name: string; dir: string } {
  const idx = p.lastIndexOf('/');
  if (idx < 0) return { name: p, dir: '' };
  return { name: p.slice(idx + 1), dir: p.slice(0, idx) };
}

export function OpenFileMenu() {
  const { loadFile, setError, setLoading, metadata } = useSession();
  const [dropOpen, setDropOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);

  const refresh = async () => {
    try {
      const list = await listRecentFiles();
      setRecent(list);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    }
  };

  useEffect(() => { refresh(); }, [metadata]);

  const loadByPath = async (path: string) => {
    setDropOpen(false);
    setError(null);
    try {
      setLoading(true);
      const md = await openFile(path);
      loadFile(md);
    } catch (e) {
      setError(`打开失败：${typeof e === 'string' ? e : JSON.stringify(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenDialog = () => openFileViaDialog({ loadFile, setLoading, setError });

  const handleClear = async () => {
    if (!confirm('清除最近打开列表？')) return;
    await clearRecentFiles();
    await refresh();
  };

  return (
    <div className="relative">
      <div className="ctl-segment">
        <button onClick={handleOpenDialog}>📂 打开</button>
        <button onClick={() => { refresh(); setDropOpen((v) => !v); }} style={{ padding: '0 6px' }}>▾</button>
      </div>
      {dropOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setDropOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-[28rem] bg-white border rounded shadow-lg z-20 text-sm">
            <div className="px-3 py-1.5 text-xs text-slate-500 border-b flex items-center justify-between">
              <span>最近打开</span>
              {recent.length > 0 && (
                <button onClick={handleClear} className="text-slate-400 hover:text-red-600 text-xs">
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
                  onClick={() => loadByPath(p)}
                  className={[
                    'w-full text-left px-3 py-1.5 hover:bg-slate-100 flex flex-col min-w-0 overflow-hidden',
                    isCurrent ? 'bg-blue-50' : '',
                  ].join(' ')}
                  title={p}
                >
                  <span className="text-slate-800 truncate block max-w-full">{isCurrent ? '✓ ' : ''}{name}</span>
                  <span className="text-slate-400 text-xs truncate block max-w-full">{dir}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
