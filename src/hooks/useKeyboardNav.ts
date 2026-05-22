// 详情抽屉打开时，监听 Esc 关闭。
// ↑/↓ 跨条目导航暂去掉 — 之前用 page_entries 找索引在几万行场景下不可靠，
// 跨页导航需要后端 next/prev API 支持，留待后续。

import { useEffect } from 'react';
import { useSession } from '../state/session';

export function useKeyboardNav() {
  const { selectedEntry, setSelectedEntry } = useSession();

  useEffect(() => {
    if (!selectedEntry) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedEntry(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedEntry, setSelectedEntry]);
}
