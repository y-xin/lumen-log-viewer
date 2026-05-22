// 应用启动后若没有已打开的文件，自动尝试打开"最近"列表里的第一个。
// 文件已删除 / 移动 → 静默跳过，让用户走正常入口；不打扰。

import { useEffect, useRef } from 'react';
import { listRecentFiles, openFile } from '../api/commands';
import { useSession } from '../state/session';

export function useAutoOpenRecent() {
  const tried = useRef(false);

  useEffect(() => {
    if (tried.current) return;
    tried.current = true;

    const { metadata, loadFile, setLoading } = useSession.getState();
    if (metadata) return; // 已经手动打开过文件，跳过

    (async () => {
      try {
        const recent = await listRecentFiles();
        if (recent.length === 0) return;
        setLoading(true);
        try {
          const md = await openFile(recent[0]);
          loadFile(md);
        } catch {
          // 文件不存在 / 不可访问 — 静默吞掉，不显示错误
        } finally {
          setLoading(false);
        }
      } catch {
        // listRecentFiles 失败也静默
      }
    })();
  }, []);
}
