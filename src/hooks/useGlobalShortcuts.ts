// 全局快捷键集中处理：唯一的 window keydown 监听者
//
// 直接做的事：⌘O 开 dialog、⌘R 刷新、⌘K 清空、⌘T toggle follow
// 需要触发其他组件的：⌘F / ⌘E / ⌘S 通过 window CustomEvent 派发
// Esc 按优先级关：help → rotationDialog → drawer
// ? 在输入框聚焦时不触发（避免吃掉用户输入的 ? 字符）

import { useEffect } from 'react';
import { useSession } from '../state/session';
import { openFileViaDialog } from '../api/dialog';
import { getNeighbor } from '../api/commands';
import type { LogLevel } from '../types/log';

const ALL_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'unknown'];

function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return true;
  return t.isContentEditable;
}

export function useGlobalShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const s = useSession.getState();

      // ─── Esc：按优先级关闭 ─────────────────
      if (e.key === 'Escape') {
        if (s.helpOpen) { s.setHelpOpen(false); e.preventDefault(); return; }
        if (s.gotoOpen) { s.setGotoOpen(false); e.preventDefault(); return; }
        if (s.rotationKind) { s.setRotationKind(null); e.preventDefault(); return; }
        if (s.selectedEntry) { s.setSelectedEntry(null); e.preventDefault(); return; }
        return;
      }

      // ─── ? 弹 help（仅非输入态） ───────────
      if (!mod && e.key === '?' && !isTypingTarget(e)) {
        s.setHelpOpen(!s.helpOpen);
        e.preventDefault();
        return;
      }

      // ─── ↑/↓ 在 drawer 打开时切换相邻 matched entry（非输入态） ───
      if (!mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && s.selectedEntry && !isTypingTarget(e)) {
        const dir = e.key === 'ArrowUp' ? 'prev' : 'next';
        const lineNo = s.selectedEntry.line_no;
        // 异步：不 block 事件循环；防默认（避免触发列表 / 输入框滚动）
        e.preventDefault();
        getNeighbor(s.spec, lineNo, dir).then((n) => {
          if (!n) return;
          useSession.getState().setSelectedEntry(n.entry);
          // 同步滚动列表（drawer 内 useEffect 也会刷新 position/total）
          window.dispatchEvent(new CustomEvent('lv:goto-line', { detail: { lineNo: n.entry.line_no } }));
        }).catch(() => {});
        return;
      }

      // ─── 以下都需 ⌘/Ctrl ────────────────
      if (!mod) return;

      switch (key) {
        case 'o':
          openFileViaDialog({ loadFile: s.loadFile, setLoading: s.setLoading, setError: s.setError });
          e.preventDefault();
          return;
        case 'r':
          if (s.metadata) {
            s.setSpec({ ...s.spec }); // 新引用触发 useAutoQuery
          }
          e.preventDefault();
          return;
        case 'f':
          window.dispatchEvent(new CustomEvent('lv:focus-keyword'));
          e.preventDefault();
          return;
        case 'k':
          s.patchSpec({
            levels: ALL_LEVELS,
            scope_filter: null,
            scope_in: null,
            text_search: null,
            time_range: null,
          });
          e.preventDefault();
          return;
        case 't':
          if (s.metadata) s.setFollow(!s.follow);
          e.preventDefault();
          return;
        case 'e':
          if (s.metadata) window.dispatchEvent(new CustomEvent('lv:open-export'));
          e.preventDefault();
          return;
        case 's':
          if (s.metadata) window.dispatchEvent(new CustomEvent('lv:open-saved-filters'));
          e.preventDefault();
          return;
        case '=':
        case '+':
          s.setFontSize(s.fontSize + 1);
          e.preventDefault();
          return;
        case '-':
          s.setFontSize(s.fontSize - 1);
          e.preventDefault();
          return;
        case '0':
          s.setFontSize(12);
          e.preventDefault();
          return;
        case 'g':
          if (s.metadata) s.setGotoOpen(true);
          e.preventDefault();
          return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
