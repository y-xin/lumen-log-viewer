// 顶部"📂 打开 + ▾"复合按钮：
// - 左半"📂 打开"：tauri open dialog → 新窗口打开
// - 右半"▾"：下拉显示最近文件 → 点选在新窗口打开

import { useEffect, useState } from 'react';
import { listRecentFiles, clearRecentFiles } from '../api/commands';
import { open } from '@tauri-apps/plugin-dialog';
import { useSession } from '../state/session';
import { openInNewWindow } from '../api/window';
import { OpenRemoteDialog } from './OpenRemoteDialog';
import { testSshConnection, openRemoteInNewWindow } from '../api/remote';
import { isSshSupported } from '../lib/platform';
import { toLocalPath } from '../types/log';

function formatPath(uriOrPath: string): { name: string; dir: string; isRemote: boolean } {
  // recent 列表里可能是 file:///abs/path（Task 1.4 migration 后）、ssh://user@host:port/path、或旧裸路径
  const isRemote = uriOrPath.startsWith('ssh://');
  // 展示用：file:// 前缀去掉看着干净；ssh:// 保留 host 信息
  const display = uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath;
  const idx = display.lastIndexOf('/');
  if (idx < 0) return { name: display, dir: '', isRemote };
  return { name: display.slice(idx + 1), dir: display.slice(0, idx), isRemote };
}

export function OpenFileMenu() {
  const { metadata } = useSession();
  const [dropOpen, setDropOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [showRemote, setShowRemote] = useState(false);
  // 默认 true 避免初始 flash 隐藏；Windows 上异步拿到结果后置 false
  const [sshSupported, setSshSupported] = useState(true);
  useEffect(() => {
    isSshSupported().then(setSshSupported).catch(() => setSshSupported(true));
  }, []);

  const refresh = async () => {
    try {
      const list = await listRecentFiles();
      setRecent(list);
    } catch {
      // 静默忽略刷新错误
    }
  };

  useEffect(() => { refresh(); }, [metadata]);

  // 最近文件点击：在新窗口打开，当前窗口不动
  // 入参可能是 file:///abs/path（migration 后的标准格式）或 ssh://...（远程）或旧裸路径
  const loadByPath = (uriOrPath: string) => {
    setDropOpen(false);
    const localPath = toLocalPath(uriOrPath);
    if (localPath === null) {
      // ssh:// 远程文件：MVP 先提示用户手动重开（passphrase 没存盘，无法直接打开）
      alert('远程文件需要重新输入密码，请用「🌐 打开远程文件…」入口手动连接。');
      return;
    }
    openInNewWindow(localPath).catch((e) => console.error('openInNewWindow failed', e));
  };

  // 主按钮：弹 dialog 选文件后在新窗口打开
  const handleOpenDialog = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Log', extensions: ['log', 'jsonl', 'txt'] }],
    });
    if (typeof selected === 'string') {
      openInNewWindow(selected).catch(() => {});
    }
  };

  const handleClear = async () => {
    if (!confirm('清除最近打开列表？')) return;
    await clearRecentFiles();
    await refresh();
  };

  return (
    <>
    <div className="relative">
      <div className="ctl-segment">
        <button onClick={handleOpenDialog}>📂 打开</button>
        <button onClick={() => { refresh(); setDropOpen((v) => !v); }} style={{ padding: '0 6px' }}>▾</button>
      </div>
      {dropOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setDropOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-[28rem] bg-white border rounded shadow-lg z-20 text-sm">
            {sshSupported && (
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-sm border-b"
                onClick={() => { setDropOpen(false); setShowRemote(true); }}
              >
                🌐 打开远程文件…
              </button>
            )}
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
    {showRemote && (
      <OpenRemoteDialog
        onClose={() => setShowRemote(false)}
        onTest={async (params) => {
          try { await testSshConnection(params); return { ok: true }; }
          catch (e: unknown) {
            // Tauri AppError 序列化为 { kind, message }；HostKeyUnknown 的 message 是 { host, port, fingerprint }
            const err = e as { kind?: string; message?: unknown };
            if (err?.kind === 'HostKeyUnknown' && err.message && typeof err.message === 'object') {
              const m = err.message as { host: string; port: number; fingerprint: string };
              return { ok: false, hostKeyUnknown: m };
            }
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, error: msg };
          }
        }}
        onSubmit={async (params, path, tailLines) => {
          try {
            await openRemoteInNewWindow(params, path, tailLines);
            setShowRemote(false);
          } catch (e) { console.error(e); }
        }}
      />
    )}
    </>
  );
}
