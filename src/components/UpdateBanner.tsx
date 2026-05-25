// src/components/UpdateBanner.tsx
import { useEffect, useState } from 'react';
import { checkForUpdate, installUpdate, type UpdateInfo } from '../api/updater';

const SKIP_KEY = 'lv:skip-update-version';

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<{ d: number; t: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showChangelog, setShowChangelog] = useState(false);

  // 启动 5s 后台 check
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const u = await checkForUpdate();
        if (!u) return;
        if (localStorage.getItem(SKIP_KEY) === u.version) return;
        setInfo(u);
      } catch {
        // 离线 / 网络受限静默；Settings 手动检查时才报错
      }
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  if (!info) return null;

  const handleInstall = async () => {
    setError(null);
    setProgress({ d: 0, t: 0 });
    try {
      await installUpdate(info, (d, t) => setProgress({ d, t }));
      // 装完 plugin 自动 process::exit，前端走不到
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setProgress(null);
    }
  };

  const handleSkip = () => {
    localStorage.setItem(SKIP_KEY, info.version);
    setInfo(null);
  };

  return (
    <>
      <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 flex items-center gap-3 text-sm">
        <span>🎉 Lumen v{info.version} 可用</span>
        {progress ? (
          <span className="text-slate-600">
            下载中 {progress.t > 0
              ? `${Math.round((progress.d / progress.t) * 100)}%`
              : '...'}
          </span>
        ) : (
          <>
            <button className="ctl" onClick={() => setShowChangelog(true)}>看 changelog</button>
            <button className="ctl ctl-primary" onClick={handleInstall}>现在更新</button>
            <button className="ctl" onClick={() => setInfo(null)}>稍后</button>
            <button className="ctl text-slate-500" onClick={handleSkip}>跳过此版</button>
          </>
        )}
        {error && <span className="text-red-600">❌ {error}</span>}
      </div>
      {showChangelog && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
             onClick={() => setShowChangelog(false)}>
          <div className="bg-white rounded shadow-xl p-5 max-w-2xl max-h-[70vh] overflow-auto"
               onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold mb-3">v{info.version} 更新日志</h3>
            <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans">{info.notes || '（无 changelog）'}</pre>
            <div className="flex justify-end mt-3">
              <button className="ctl" onClick={() => setShowChangelog(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
