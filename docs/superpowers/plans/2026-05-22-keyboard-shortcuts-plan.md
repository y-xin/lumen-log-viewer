# Keyboard Shortcuts v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一套全局快捷键覆盖文件操作 / 筛选 / 菜单切换；`?` 弹一览表；`Esc` 按优先级统一关闭。

**Architecture:** `useGlobalShortcuts` 是唯一的 `window` keydown 监听者，挂在 App.tsx。直接做的事走 store/API；需要触发其他组件状态的（聚焦 keyword input、开 ExportMenu / SavedFiltersMenu）通过 `window.dispatchEvent(new CustomEvent(...))`，避免给已有组件加 props 钻洞。`helpOpen` 加到 zustand；`ShortcutsHelp` 是简单 modal。

**Tech Stack:** React + zustand + Tauri dialog plugin。无新依赖（`@testing-library/react` 已用）。

**Spec：** [2026-05-22-keyboard-shortcuts-design.md](../specs/2026-05-22-keyboard-shortcuts-design.md)

---

## 文件结构

```
src/
├── api/
│   └── dialog.ts                        (新：openFileViaDialog helper)
├── hooks/
│   ├── useGlobalShortcuts.ts            (新：集中 keydown 监听 + Esc 优先级)
│   └── useKeyboardNav.ts                (删除)
├── components/
│   ├── ShortcutsHelp.tsx                (新：modal 一览表)
│   ├── FilterBar.tsx                    (修改：keyword input ref + 监听 lv:focus-keyword)
│   ├── ExportMenu.tsx                   (修改：监听 lv:open-export)
│   ├── SavedFiltersMenu.tsx             (修改：监听 lv:open-saved-filters)
│   ├── OpenFileMenu.tsx                 (修改：用 openFileViaDialog helper)
│   ├── TemplateManagerDialog.tsx        (修改：自己加 Esc)
│   ├── DetailDrawer.tsx                 (修改：去掉 useKeyboardNav 调用)
│   └── App.tsx                          (修改：useGlobalShortcuts + <ShortcutsHelp />)
├── state/session.ts                     (修改：加 helpOpen + setHelpOpen)
└── __tests__/
    └── useGlobalShortcuts.test.tsx      (新：5 个单测)
```

---

## Phase 1：基础设施

### Task 1.1：zustand 加 helpOpen + setHelpOpen

**Files:** Modify `src/state/session.ts`

- [ ] **Step 1：interface + 默认值 + setter**

打开 `src/state/session.ts`。

把 `interface SessionStore { ... }` 里 `newEntriesPending: number;` 那行下方加：
```ts
  /** 快捷键 help overlay 是否打开 */
  helpOpen: boolean;
```

把 `clearNewEntriesPending: () => void;` 下方加：
```ts
  setHelpOpen: (b: boolean) => void;
```

在 `create<SessionStore>((set) => ({` 的 store 初值里，`newEntriesPending: 0,` 下方加：
```ts
  helpOpen: false,
```

最后在 action 列表里 `clearNewEntriesPending: () => set({ newEntriesPending: 0 }),` 下方加：
```ts
  setHelpOpen: (helpOpen) => set({ helpOpen }),
```

- [ ] **Step 2：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 3：commit**

```bash
git add src/state/session.ts
git commit -m "feat(state): add helpOpen + setHelpOpen for shortcuts overlay"
```

---

### Task 1.2：api/dialog.ts helper + OpenFileMenu 改用

**Files:** Create `src/api/dialog.ts`, Modify `src/components/OpenFileMenu.tsx`

- [ ] **Step 1：写 dialog.ts**

新建 `src/api/dialog.ts`：

```ts
// 共享：通过原生 open dialog 选日志文件 → 调 openFile → loadFile
// 由 OpenFileMenu 和 useGlobalShortcuts（⌘O）共用，避免逻辑两份。

import { open } from '@tauri-apps/plugin-dialog';
import { openFile } from './commands';
import type { FileMetadata } from '../types/log';

interface Deps {
  loadFile: (md: FileMetadata) => void;
  setLoading: (b: boolean) => void;
  setError: (msg: string | null) => void;
}

export async function openFileViaDialog({ loadFile, setLoading, setError }: Deps): Promise<void> {
  setError(null);
  const selected = await open({
    multiple: false,
    filters: [{ name: 'Log', extensions: ['log', 'jsonl', 'txt'] }],
  });
  if (typeof selected !== 'string') return;
  try {
    setLoading(true);
    const md = await openFile(selected);
    loadFile(md);
  } catch (e) {
    setError(`打开失败：${typeof e === 'string' ? e : JSON.stringify(e)}`);
  } finally {
    setLoading(false);
  }
}
```

- [ ] **Step 2：OpenFileMenu 改用 helper**

打开 `src/components/OpenFileMenu.tsx`。

把 import 区里：
```ts
import { open } from '@tauri-apps/plugin-dialog';
import { openFile, listRecentFiles, clearRecentFiles } from '../api/commands';
```
改为：
```ts
import { openFile, listRecentFiles, clearRecentFiles } from '../api/commands';
import { openFileViaDialog } from '../api/dialog';
```

把 `handleOpenDialog` 函数：
```ts
  const handleOpenDialog = async () => {
    setError(null);
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Log', extensions: ['log', 'jsonl', 'txt'] }],
    });
    if (typeof selected === 'string') await loadByPath(selected);
  };
```
改为：
```ts
  const handleOpenDialog = () => openFileViaDialog({ loadFile, setLoading, setError });
```

注：原 `loadByPath` 留着 — 它给"最近打开"下拉项点击调用，与 dialog 流程不同（最近列表直接走 path）。

- [ ] **Step 3：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 4：commit**

```bash
git add src/api/dialog.ts src/components/OpenFileMenu.tsx
git commit -m "refactor(fe): extract openFileViaDialog helper for shortcut reuse"
```

---

## Phase 2：ShortcutsHelp + useGlobalShortcuts

### Task 2.1：ShortcutsHelp modal

**Files:** Create `src/components/ShortcutsHelp.tsx`

- [ ] **Step 1：写组件**

新建 `src/components/ShortcutsHelp.tsx`：

```tsx
// 快捷键一览 modal：?/Esc/遮罩点击 → 关
// 显示由 useSession.helpOpen 控制，按下 ? 由 useGlobalShortcuts 触发

import { useSession } from '../state/session';

interface Item { keys: string; desc: string; }

// macOS 显示 ⌘，其他平台显示 Ctrl
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const M = isMac ? '⌘' : 'Ctrl';

const ITEMS: Item[] = [
  { keys: `${M} O`, desc: '打开文件' },
  { keys: `${M} R`, desc: '刷新当前查询' },
  { keys: `${M} F`, desc: '聚焦关键词搜索' },
  { keys: `${M} K`, desc: '清空所有筛选' },
  { keys: `${M} T`, desc: '切换实时跟踪' },
  { keys: `${M} E`, desc: '打开导出菜单' },
  { keys: `${M} S`, desc: '打开 saved-filter 菜单' },
  { keys: '?',      desc: '本帮助' },
  { keys: 'Esc',    desc: '关闭抽屉 / 弹窗 / 本帮助' },
];

export function ShortcutsHelp() {
  const { helpOpen, setHelpOpen } = useSession();
  if (!helpOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
      onClick={() => setHelpOpen(false)}
    >
      <div
        className="bg-white rounded shadow-xl p-5 min-w-[360px] max-w-[480px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">键盘快捷键</h3>
          <button onClick={() => setHelpOpen(false)} className="text-slate-400 hover:text-slate-700" title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <table className="w-full text-xs">
          <tbody>
            {ITEMS.map((it) => (
              <tr key={it.keys} className="border-b border-slate-100 last:border-b-0">
                <td className="py-1.5 pr-4 font-mono text-slate-700 whitespace-nowrap">{it.keys}</td>
                <td className="py-1.5 text-slate-600">{it.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 3：commit**

```bash
git add src/components/ShortcutsHelp.tsx
git commit -m "feat(fe): ShortcutsHelp modal — keyboard shortcuts overview"
```

---

### Task 2.2：useGlobalShortcuts hook

**Files:** Create `src/hooks/useGlobalShortcuts.ts`

- [ ] **Step 1：写 hook**

新建 `src/hooks/useGlobalShortcuts.ts`：

```ts
// 全局快捷键集中处理：唯一的 window keydown 监听者
//
// 直接做的事：⌘O 开 dialog、⌘R 刷新、⌘K 清空、⌘T toggle follow
// 需要触发其他组件的：⌘F / ⌘E / ⌘S 通过 window CustomEvent 派发
// Esc 按优先级关：help → rotationDialog → drawer
// ? 在输入框聚焦时不触发（避免吃掉用户输入的 ? 字符）

import { useEffect } from 'react';
import { useSession } from '../state/session';
import { openFileViaDialog } from '../api/dialog';
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
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
```

- [ ] **Step 2：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 3：commit**

```bash
git add src/hooks/useGlobalShortcuts.ts
git commit -m "feat(fe): useGlobalShortcuts — 8 cmd shortcuts + ? help + Esc priority"
```

---

### Task 2.3：App.tsx 装配 + 删除 useKeyboardNav

**Files:** Modify `src/App.tsx`, Modify `src/components/DetailDrawer.tsx`, Delete `src/hooks/useKeyboardNav.ts`

- [ ] **Step 1：App.tsx 加 hook + 渲染 ShortcutsHelp**

打开 `src/App.tsx`，在 import 区下方现有 hook import 后追加：

```tsx
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { ShortcutsHelp } from './components/ShortcutsHelp';
```

在已有的 `useFileDrop` 调用前加：
```tsx
  useGlobalShortcuts();
```

在 JSX 末尾的 `<RotationDialog />` 下方加：
```tsx
      <ShortcutsHelp />
```

- [ ] **Step 2：DetailDrawer 移除 useKeyboardNav 调用**

打开 `src/components/DetailDrawer.tsx`。

把 import：
```tsx
import { useKeyboardNav } from '../hooks/useKeyboardNav';
```
删掉。

把组件函数里：
```tsx
  useKeyboardNav();
```
删掉。

- [ ] **Step 3：删除旧 hook 文件**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
rm src/hooks/useKeyboardNav.ts
```

- [ ] **Step 4：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 5：commit**

```bash
git add -A src/App.tsx src/components/DetailDrawer.tsx src/hooks/
git commit -m "feat(fe): mount useGlobalShortcuts + ShortcutsHelp; drop useKeyboardNav"
```

---

## Phase 3：各组件订阅 CustomEvent

### Task 3.1：FilterBar 监听 lv:focus-keyword

**Files:** Modify `src/components/FilterBar.tsx`

- [ ] **Step 1：keyword input 加 ref**

打开 `src/components/FilterBar.tsx`。

`import { useEffect, useMemo, useState } from 'react';` 改为：
```ts
import { useEffect, useMemo, useRef, useState } from 'react';
```

在 `export function FilterBar() {` 内部，`const { spec, patchSpec, metadata } = useSession();` 下方加：
```ts
  const keywordRef = useRef<HTMLInputElement>(null);
```

找到关键词输入框（找带 `placeholder="在 message / 原始行中搜索"` 的 input），给它加 `ref`：
```tsx
<input
  ref={keywordRef}
  value={keyword}
  ...
/>
```

- [ ] **Step 2：加监听 effect**

在文件顶部已有 useEffect 链下方（任意位置，比如所有 useEffect 之后），加：

```tsx
  // 接收 ⌘F 全局快捷键：聚焦关键词输入框并全选
  useEffect(() => {
    const handler = () => {
      const el = keywordRef.current;
      if (!el) return;
      el.focus();
      el.select();
    };
    window.addEventListener('lv:focus-keyword', handler);
    return () => window.removeEventListener('lv:focus-keyword', handler);
  }, []);
```

- [ ] **Step 3：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 4：commit**

```bash
git add src/components/FilterBar.tsx
git commit -m "feat(fe): FilterBar keyword input listens for lv:focus-keyword"
```

---

### Task 3.2：ExportMenu 监听 lv:open-export

**Files:** Modify `src/components/ExportMenu.tsx`

- [ ] **Step 1：加 useEffect**

打开 `src/components/ExportMenu.tsx`。

确认 `useState` 已 import；在文件内（return 之前）加：

```tsx
  // 接收 ⌘E 全局快捷键：打开下拉
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('lv:open-export', handler);
    return () => window.removeEventListener('lv:open-export', handler);
  }, []);
```

若 `useEffect` 还未 import，把 `import { useState } from 'react';` 改为 `import { useEffect, useState } from 'react';`。

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/ExportMenu.tsx
git commit -m "feat(fe): ExportMenu listens for lv:open-export"
```

---

### Task 3.3：SavedFiltersMenu 监听 lv:open-saved-filters

**Files:** Modify `src/components/SavedFiltersMenu.tsx`

- [ ] **Step 1：加 useEffect**

打开 `src/components/SavedFiltersMenu.tsx`。

在文件内、`return (` 之前合适位置（其他 useEffect 旁）加：

```tsx
  // 接收 ⌘S 全局快捷键：打开下拉
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('lv:open-saved-filters', handler);
    return () => window.removeEventListener('lv:open-saved-filters', handler);
  }, []);
```

`useEffect` 已 import（已用）。

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/SavedFiltersMenu.tsx
git commit -m "feat(fe): SavedFiltersMenu listens for lv:open-saved-filters"
```

---

### Task 3.4：TemplateManagerDialog 自己处理 Esc

**Files:** Modify `src/components/TemplateManagerDialog.tsx`

- [ ] **Step 1：加 useEffect 监听 Esc**

打开 `src/components/TemplateManagerDialog.tsx`。

确认 `useEffect` 已 import（顶部 `import { useEffect, useState }`）；找到 useEffect 区块（已有 `useEffect(() => { refresh(); }, []);`），下方加：

```tsx
  // Esc 关闭本对话框
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
```

注：useGlobalShortcuts 的 Esc 优先级里不管 TemplateManagerDialog（因为它的 open state 在 App.tsx 局部，不在 store）。所以让 dialog 自己处理。

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/TemplateManagerDialog.tsx
git commit -m "feat(fe): TemplateManagerDialog closes on Esc"
```

---

## Phase 4：测试

### Task 4.1：useGlobalShortcuts 单元测试

**Files:** Create `src/__tests__/useGlobalShortcuts.test.tsx`

- [ ] **Step 1：写测试**

新建 `src/__tests__/useGlobalShortcuts.test.tsx`：

```tsx
import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { useSession } from '../state/session';

function fireKey(opts: KeyboardEventInit & { key: string }, target?: EventTarget) {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts });
  (target ?? window).dispatchEvent(ev);
  return ev;
}

const ALL_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'unknown'];

describe('useGlobalShortcuts', () => {
  beforeEach(() => {
    useSession.setState({
      metadata: { path: '/x', total: 0, time_range: null, level_counts: {}, scopes: [], scope_counts: {}, template_id: 'json-lines' },
      spec: { levels: ['error'], text_search: 'foo' },
      helpOpen: false,
      selectedEntry: null,
      rotationKind: null,
      follow: false,
    });
  });

  it('? toggles help when not typing', () => {
    renderHook(() => useGlobalShortcuts());
    fireKey({ key: '?' });
    expect(useSession.getState().helpOpen).toBe(true);
    fireKey({ key: '?' });
    expect(useSession.getState().helpOpen).toBe(false);
  });

  it('? does NOT toggle help when typing in an input', () => {
    renderHook(() => useGlobalShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);
    // event.target 模拟 input
    const ev = new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'target', { value: input });
    window.dispatchEvent(ev);
    expect(useSession.getState().helpOpen).toBe(false);
    document.body.removeChild(input);
  });

  it('⌘F dispatches lv:focus-keyword CustomEvent', () => {
    renderHook(() => useGlobalShortcuts());
    const spy = vi.fn();
    window.addEventListener('lv:focus-keyword', spy);
    fireKey({ key: 'f', metaKey: true });
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener('lv:focus-keyword', spy);
  });

  it('⌘K resets all filter fields on spec', () => {
    renderHook(() => useGlobalShortcuts());
    fireKey({ key: 'k', metaKey: true });
    const { spec } = useSession.getState();
    expect(spec.levels).toEqual(ALL_LEVELS);
    expect(spec.scope_filter).toBeNull();
    expect(spec.scope_in).toBeNull();
    expect(spec.text_search).toBeNull();
    expect(spec.time_range).toBeNull();
  });

  it('Esc closes help first, then rotationDialog, then drawer (in priority order)', () => {
    useSession.setState({
      helpOpen: true,
      rotationKind: 'Truncated',
      selectedEntry: { line_no: 1, line_count: 1, timestamp: null, level: 'info', scope: null, message: '', fields: {}, raw: '' },
    });
    renderHook(() => useGlobalShortcuts());

    fireKey({ key: 'Escape' });
    expect(useSession.getState().helpOpen).toBe(false);
    expect(useSession.getState().rotationKind).toBe('Truncated'); // 还在
    expect(useSession.getState().selectedEntry).not.toBeNull();

    fireKey({ key: 'Escape' });
    expect(useSession.getState().rotationKind).toBeNull();
    expect(useSession.getState().selectedEntry).not.toBeNull(); // 还在

    fireKey({ key: 'Escape' });
    expect(useSession.getState().selectedEntry).toBeNull();
  });
});
```

- [ ] **Step 2：run tests**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm test 2>&1 | tail -10
```

Expected: 5 个新测试 + 已有 FilterBar 测试都通过。

- [ ] **Step 3：commit**

```bash
git add src/__tests__/useGlobalShortcuts.test.tsx
git commit -m "test(fe): 5 unit tests for useGlobalShortcuts"
```

---

## Phase 5：收尾

### Task 5.1：全测试 + 手动验收

- [ ] **Step 1：全测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | grep "test result" | head -5
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm test 2>&1 | tail -3
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

Expected: 全绿。

- [ ] **Step 2：手动验收（用户跑 `npm run tauri dev`）**

清单：
- [ ] `⌘O` 打开文件对话框
- [ ] `⌘R` 触发一次重新查询（loading 一闪）
- [ ] `⌘F` 聚焦关键词输入框；输入框已聚焦时再按不报错（保持聚焦 + 全选）
- [ ] `⌘K` 清空所有筛选；level chip 全亮、scope 输入框空、关键词空、时间空
- [ ] `⌘T` 切换实时跟踪 chip 状态
- [ ] `⌘E` 打开导出菜单
- [ ] `⌘S` 打开 saved-filter 菜单
- [ ] `?` 弹 help 一览；再按 `?` 或 Esc 关
- [ ] 在 keyword 输入框聚焦时按 `?` 不弹 help（能正常输入 `?` 字符）
- [ ] Esc 优先级：help 优先关 → 然后 RotationDialog → 然后 drawer
- [ ] 没打开文件时按 `⌘T` / `⌘E` / `⌘S` 无副作用
- [ ] 打开 TemplateManagerDialog（顶部"模板：…"下拉 → ⚙ 管理模板）→ Esc 能关

---

### Task 5.2：README 更新

**Files:** Modify `README.md`

- [ ] **Step 1：在"核心能力"末尾追加一条**

打开 `README.md`，在核心能力列表末尾追加：
```markdown
- **键盘快捷键**：⌘O 打开 / ⌘R 刷新 / ⌘F 聚焦搜索 / ⌘K 清空筛选 / ⌘T 跟踪 / ⌘E 导出 / ⌘S 筛选器 / ? 帮助 / Esc 关闭
```

在"未实现"段把 `- 键盘快捷键全集（⌘O / ⌘F 等）` 那行删掉。

- [ ] **Step 2：commit**

```bash
git add README.md
git commit -m "docs: README — keyboard shortcuts shipped"
```

---

## 完成判定

- [ ] `cargo test` 全绿（Rust 未动）
- [ ] `npm test` 全绿（含 5 个新测试）
- [ ] `npm run build` 干净
- [ ] 手动验收清单全过
- [ ] 提交按 task 分散

预估：12 个 task / 1.5-2 小时。
