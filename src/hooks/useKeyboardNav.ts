// 在详情抽屉打开时，监听 ↑/↓ 切换到上/下一条匹配；Esc 关闭抽屉

import { useEffect } from 'react';
import { useSession } from '../state/session';

export function useKeyboardNav() {
  const { result, selectedLineNo, setSelectedLineNo } = useSession();

  useEffect(() => {
    if (selectedLineNo == null) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedLineNo(null);
        return;
      }
      if (!result) return;
      const entries = result.page_entries;
      const idx = entries.findIndex((x) => x.line_no === selectedLineNo);
      if (idx < 0) return;
      if (e.key === 'ArrowDown' && idx + 1 < entries.length) {
        e.preventDefault();
        setSelectedLineNo(entries[idx + 1].line_no);
      } else if (e.key === 'ArrowUp' && idx > 0) {
        e.preventDefault();
        setSelectedLineNo(entries[idx - 1].line_no);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedLineNo, result, setSelectedLineNo]);
}
