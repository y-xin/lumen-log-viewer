// 应用启动后若没有已打开的文件，自动尝试打开"最近"列表里的第一个。
// 文件已删除 / 移动 → 静默跳过，让用户走正常入口；不打扰。

import { useEffect, useRef } from 'react';
import { listRecentFiles, openFile } from '../api/commands';
import { useSession } from '../state/session';
import { toLocalPath } from '../types/log';

export function useAutoOpenRecent() {
  const tried = useRef(false);

  useEffect(() => {
    if (tried.current) return;
    tried.current = true;

    // 如果当前窗口是 cmd_open_in_new_window spawn 的（URL 带 ?path= 或 ?pending=），
    // 让那条流程处理，避免和 ?path= 的 openFile 赛跑覆盖
    const params = new URLSearchParams(window.location.search);
    if (params.get('path') || params.get('pending')) return;

    const { metadata, loadFile, setLoading } = useSession.getState();
    if (metadata) return; // 已经手动打开过文件，跳过

    (async () => {
      try {
        const recent = await listRecentFiles();
        // recent[] 经 Task 1.4 migration 后是 file:///abs/path（或 ssh://...）URI 形式
        // 找第一个本地文件 — 跳过 ssh:// 远程（passphrase 已丢失，没法自动打开）
        const firstLocal = recent
          .map(toLocalPath)
          .find((p): p is string => p !== null);
        if (!firstLocal) return;
        setLoading(true);
        try {
          const md = await openFile(firstLocal);
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
