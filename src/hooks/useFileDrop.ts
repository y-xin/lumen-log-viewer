// 文件拖入：拖 .log/.jsonl/.txt/.out 文件到窗口任意位置 → 自动 openFile
// 返回 isDragging（用于显示 overlay 提示）

import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { openInNewWindow } from '../api/window';

const LOG_EXTENSIONS = ['log', 'jsonl', 'txt', 'out'];

function isLogPath(path: string): boolean {
  const lower = path.toLowerCase();
  return LOG_EXTENSIONS.some((ext) => lower.endsWith('.' + ext));
}

export function useFileDrop(): boolean {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const handleDrop = async (target: string) => {
      await openInNewWindow(target);
    };

    const setup = async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent((event) => {
          // Tauri 2.x payload.type: 'enter' | 'over' | 'leave' | 'drop'
          const t = (event.payload as { type: string }).type;
          if (t === 'enter' || t === 'over') {
            setIsDragging(true);
          } else if (t === 'leave') {
            setIsDragging(false);
          } else if (t === 'drop') {
            setIsDragging(false);
            const paths = (event.payload as { paths?: string[] }).paths ?? [];
            if (paths.length === 0) return;
            // 优先取符合 log 扩展名的；否则取第一个（让 reader 自己尝试）
            const target = paths.find(isLogPath) ?? paths[0];
            handleDrop(target);
          }
        });
      } catch {
        // 非 Tauri 环境（如 vitest）下静默
      }
    };
    setup();

    return () => { unlisten?.(); };
  }, []);

  return isDragging;
}
