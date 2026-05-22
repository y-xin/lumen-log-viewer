# 样式优化 v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 UI 按 v3 mockup 收敛到 Linear/Notion 风格 + 统一控件高度（28px）+ StatsPanel 瘦身（level counts 下沉到 footer）。

**Architecture:** 全部前端改动，无后端涉及。先在 `index.css` 加 design tokens + 4 个 utility class（`.ctl` / `.ctl-segment` / `.input-ctl` / `.select-ctl`），再让各组件 className 替换到这些 utility，并合并/重组少量组件（OpenFileButton + RecentFilesMenu → OpenFileMenu）。

**Tech Stack:** 仅 CSS + React — 无新依赖。

**Spec：** [2026-05-22-style-design.md](../specs/2026-05-22-style-design.md)

---

## 文件结构

```
src/
├── index.css                        (修改：tokens + 4 个 utility class)
├── App.tsx                          (修改：合并按钮 + chip + 路径简化)
├── components/
│   ├── OpenFileButton.tsx           (删除)
│   ├── RecentFilesMenu.tsx          (删除)
│   ├── OpenFileMenu.tsx             (新：segment 复合 "📂 打开 + ▾")
│   ├── FollowToggle.tsx             (重写：chip 风格)
│   ├── TemplateMenu.tsx             (微调：.ctl)
│   ├── FilterBar.tsx                (重写：全控件用 utility class)
│   ├── StatsPanel.tsx               (修改：去 total/level 行)
│   ├── LogList.tsx                  (修改：footer 加 level counts)
│   ├── ExportMenu.tsx               (微调：.ctl)
│   ├── TemplateManagerDialog.tsx    (微调：内部 button)
│   ├── DetailDrawer.tsx             (微调：内部 button)
│   └── RotationDialog.tsx           (微调：内部 button)
```

---

## Phase 1：Design tokens + utility classes

### Task 1.1：index.css 加 tokens + utility

**Files:** Modify `src/index.css`

- [ ] **Step 1：覆盖整个文件**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* === Design tokens ─ Style v3 === */
:root {
  --bg: #f8fafc;
  --surface: #ffffff;
  --border: #e2e8f0;
  --border-strong: #cbd5e1;
  --text: #0f172a;
  --text-2: #475569;
  --text-3: #94a3b8;
  --accent: #2563eb;
  --accent-bg: #eff6ff;

  --h-control: 28px;
  --h-control-sm: 22px;
  --radius: 5px;
  --radius-sm: 4px;
}

/* === Utility: 统一 toolbar 控件高度与外观 === */
.ctl {
  height: var(--h-control);
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  font-size: 12px;
  line-height: 1;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
.ctl:hover { background: #f1f5f9; }
.ctl:disabled { opacity: 0.5; cursor: not-allowed; }
.ctl-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.ctl-primary:hover { background: #1d4ed8; }

.ctl-segment {
  height: var(--h-control);
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  overflow: hidden;
  box-sizing: border-box;
}
.ctl-segment > button {
  padding: 0 8px;
  font-size: 12px;
  border: none;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  border-right: 1px solid var(--border-strong);
}
.ctl-segment > button:last-child { border-right: none; }
.ctl-segment > button:hover { background: #f1f5f9; }
.ctl-segment > button.active { background: #334155; color: #fff; }

.input-ctl {
  height: var(--h-control);
  box-sizing: border-box;
  padding: 0 8px;
  font-size: 12px;
  line-height: 1;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
}
.input-ctl:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
}

.select-ctl {
  height: var(--h-control);
  box-sizing: border-box;
  padding: 0 18px 0 6px;
  font-size: 11px;
  line-height: 1;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 4l3 3 3-3' stroke='%2394a3b8' fill='none' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 6px center;
  appearance: none;
  -webkit-appearance: none;
  color: var(--text);
  cursor: pointer;
}

/* === 已有：禁 overscroll bounce + 拖拽误选 === */
html, body, #root {
  overscroll-behavior: none;
  overflow: hidden;
  height: 100%;
}

body {
  user-select: none;
  -webkit-user-select: none;
}

input, textarea, .selectable, [data-selectable] {
  user-select: text;
  -webkit-user-select: text;
}
```

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/index.css
git commit -m "style: design tokens + 4 utility classes (.ctl / .ctl-segment / .input-ctl / .select-ctl)"
```

---

## Phase 2：Header 重组

### Task 2.1：合并 OpenFileButton + RecentFilesMenu → OpenFileMenu

**Files:**
- Create: `src/components/OpenFileMenu.tsx`
- Delete: `src/components/OpenFileButton.tsx`、`src/components/RecentFilesMenu.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1：写 OpenFileMenu.tsx**

```tsx
// 顶部"📂 打开 + ▾"复合按钮：
// - 左半"📂 打开"：tauri save/open dialog → loadFile
// - 右半"▾"：下拉显示最近文件 → 点选直接打开

import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { openFile, listRecentFiles, clearRecentFiles } from '../api/commands';
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

  const handleOpenDialog = async () => {
    setError(null);
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Log', extensions: ['log', 'jsonl', 'txt'] }],
    });
    if (typeof selected === 'string') await loadByPath(selected);
  };

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
                    'w-full text-left px-3 py-1.5 hover:bg-slate-100 flex flex-col',
                    isCurrent ? 'bg-blue-50' : '',
                  ].join(' ')}
                  title={p}
                >
                  <span className="text-slate-800 truncate">{isCurrent ? '✓ ' : ''}{name}</span>
                  <span className="text-slate-400 text-xs truncate">{dir}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2：删除旧组件**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
rm src/components/OpenFileButton.tsx src/components/RecentFilesMenu.tsx
```

- [ ] **Step 3：App.tsx 把两个旧 import 替换为 OpenFileMenu**

打开 `src/App.tsx`：

把：
```tsx
import { OpenFileButton } from './components/OpenFileButton';
import { RecentFilesMenu } from './components/RecentFilesMenu';
```
改为：
```tsx
import { OpenFileMenu } from './components/OpenFileMenu';
```

把 header 里：
```tsx
<div className="flex items-center gap-px">
  <OpenFileButton />
  <RecentFilesMenu />
</div>
```
改为：
```tsx
<OpenFileMenu />
```

- [ ] **Step 4：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
# 用 -A 让 git 同时追踪新增 (OpenFileMenu.tsx) 和删除 (OpenFileButton.tsx / RecentFilesMenu.tsx)
git add -A src/components/ src/App.tsx
git commit -m "feat(fe): merge OpenFileButton + RecentFilesMenu → OpenFileMenu segment"
```

---

### Task 2.2：FollowToggle 改 chip 风格

**Files:** Modify `src/components/FollowToggle.tsx`

- [ ] **Step 1：覆写为 chip 风格（28px 高，开/关用颜色 + dot 区分）**

```tsx
// 顶部实时跟踪 chip：28px 等高
// - 开启：绿底 + 绿边 + 绿色 dot 脉冲 + "实时跟踪"
// - 关闭：灰底 + 灰边 + 灰色 dot（无脉冲）+ "实时跟踪"

import { useSession } from '../state/session';

export function FollowToggle() {
  const { follow, setFollow, metadata } = useSession();
  if (!metadata) return null;

  return (
    <button
      onClick={() => setFollow(!follow)}
      style={{ height: 'var(--h-control)' }}
      className={[
        'box-border inline-flex items-center gap-1.5 px-2.5 text-xs rounded-[5px] border transition-colors',
        follow
          ? 'bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100'
          : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50',
      ].join(' ')}
      title={follow ? '实时跟踪中（点击关闭）' : '实时跟踪关闭（点击开启）'}
    >
      <span className="relative inline-flex items-center justify-center w-2.5 h-2.5">
        {follow && (
          <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-75 animate-ping" />
        )}
        <span className={[
          'relative inline-block w-1.5 h-1.5 rounded-full',
          follow ? 'bg-emerald-500' : 'bg-slate-400',
        ].join(' ')} />
      </span>
      实时跟踪
    </button>
  );
}
```

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/FollowToggle.tsx
git commit -m "style(FollowToggle): 28px chip — green dot when on / gray when off"
```

---

### Task 2.3：TemplateMenu 用 .ctl + App.tsx 路径简化

**Files:** Modify `src/components/TemplateMenu.tsx`、`src/App.tsx`

- [ ] **Step 1：TemplateMenu 触发按钮换 .ctl**

打开 `src/components/TemplateMenu.tsx`。找到主按钮：

```tsx
<button
  onClick={() => setOpen((v) => !v)}
  className="px-3 py-1.5 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50"
>
  模板：{current?.name ?? currentTemplateId ?? '—'} ▾
</button>
```

改为：

```tsx
<button
  onClick={() => setOpen((v) => !v)}
  className="ctl"
>
  模板：{current?.name ?? currentTemplateId ?? '—'} ▾
</button>
```

- [ ] **Step 2：App.tsx 顶部右侧只显示 path（去掉行数 / 模板）**

`src/App.tsx` 找到：

```tsx
<div className="ml-auto text-xs text-slate-500">
  {metadata ? `${metadata.path} · ${metadata.total} 行 · 模板 ${metadata.template_id}` : '未打开文件'}
</div>
```

改为：

```tsx
<div className="ml-auto text-xs text-slate-500 truncate max-w-[50%]" title={metadata?.path}>
  {metadata ? metadata.path : '未打开文件'}
</div>
```

模板信息已通过 TemplateMenu 按钮文字展示；行数信息在底部 footer 显示（`匹配 N 条`）已有。

- [ ] **Step 3：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/TemplateMenu.tsx src/App.tsx
git commit -m "style(header): TemplateMenu → .ctl; top-right shows path only"
```

---

## Phase 3：FilterBar 全面替换

### Task 3.1：FilterBar 控件 className 全替换

**Files:** Modify `src/components/FilterBar.tsx`

- [ ] **Step 1：替换 4 处控件 className**

打开 `src/components/FilterBar.tsx`。

**修改 1**：Scope select。把：
```tsx
<select
  value={scopeField}
  onChange={(e) => setScopeField(e.target.value)}
  className="border rounded px-1 py-0.5 text-xs"
>
```
改为：
```tsx
<select
  value={scopeField}
  onChange={(e) => setScopeField(e.target.value)}
  className="select-ctl"
>
```

**修改 2**：Scope pattern 输入框。把：
```tsx
<input
  value={scopePattern}
  onChange={(e) => setScopePattern(e.target.value)}
  placeholder="模式（如 auth.* 或 user-service）"
  className="border rounded px-2 py-0.5 text-xs w-full pr-6"
/>
```
改为：
```tsx
<input
  value={scopePattern}
  onChange={(e) => setScopePattern(e.target.value)}
  placeholder="模式（如 auth.* 或 user-service）"
  className="input-ctl w-full pr-6"
/>
```

**修改 3**：Scope mode 三按钮（exact/glob/regex）。把整段：
```tsx
<div className="flex border rounded overflow-hidden text-xs">
  {(['exact', 'glob', 'regex'] as const).map((m) => (
    <button
      key={m}
      onClick={() => setScopeMode(m)}
      className={['px-2 py-0.5', scopeMode === m ? 'bg-slate-700 text-white' : 'bg-white text-slate-600'].join(' ')}
    >
      {m}
    </button>
  ))}
</div>
```
改为：
```tsx
<div className="ctl-segment">
  {(['exact', 'glob', 'regex'] as const).map((m) => (
    <button
      key={m}
      onClick={() => setScopeMode(m)}
      className={scopeMode === m ? 'active' : ''}
    >
      {m}
    </button>
  ))}
</div>
```

**修改 4**：关键词 input。把：
```tsx
<input
  value={keyword}
  onChange={(e) => setKeyword(e.target.value)}
  placeholder="在 message / 原始行中搜索"
  className="border rounded px-2 py-0.5 text-xs flex-1 max-w-md"
/>
```
改为：
```tsx
<input
  value={keyword}
  onChange={(e) => setKeyword(e.target.value)}
  placeholder="在 message / 原始行中搜索"
  className="input-ctl flex-1 max-w-md"
/>
```

**修改 5**：两个时间 input。把：
```tsx
<input
  type="datetime-local"
  value={from}
  onChange={(e) => setFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
  className="border rounded px-1 py-0.5 text-xs"
/>
```
（出现两次：from 和 to）改为：
```tsx
<input
  type="datetime-local"
  value={from}
  onChange={(e) => setFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
  className="input-ctl text-[11px]"
  style={{ width: 170 }}
/>
```
同样对 to。

- [ ] **Step 2：行间距 / gap 微调**

把外层 `<div className="p-3 border-b bg-white space-y-2">` 改为 `<div className="p-2 border-b bg-white space-y-1">`。

各 row 的 `gap-2` 改为 `gap-1.5`。

- [ ] **Step 3：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3 && npm test 2>&1 | tail -3
git add src/components/FilterBar.tsx
git commit -m "style(FilterBar): unify controls to .ctl / .input-ctl / .select-ctl / .ctl-segment"
```

注：`npm test` 跑 FilterBar.test.tsx 验证 toggle 测试不被破坏（应仍通过，level button 仅 className 变了，role 不变）。

---

## Phase 4：StatsPanel 瘦身 + LogList footer

### Task 4.1：StatsPanel 移除 total / level counts 行

**Files:** Modify `src/components/StatsPanel.tsx`

- [ ] **Step 1：删除 total/level 行**

打开 `src/components/StatsPanel.tsx`。删除下面整段（含外层 div）：

```tsx
<div className="flex items-center gap-4 flex-wrap mt-1">
  <span className="font-medium text-slate-700">总数 {total.toLocaleString()}</span>
  {LEVELS.map((lv) => {
    const n = level_counts[lv] ?? 0;
    if (n === 0) return null;
    return (
      <span key={lv} className={LEVEL_COLOR[lv]}>
        {lv.toUpperCase()} {n.toLocaleString()}
      </span>
    );
  })}
</div>
```

可顺便删除现在没用到的 `LEVELS` / `LEVEL_COLOR` 常量、`total` 解构（保留 `level_counts` 因为也不再用了 — 同样删除）。

scope tags 行的 `mt-1` 改为 `mt-0`（因为前面那块没了）。原来开头的 `Scope:` label 也保留即可。

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/StatsPanel.tsx
git commit -m "style(StatsPanel): drop total + level counts row (moved to LogList footer)"
```

---

### Task 4.2：LogList footer 显示 level counts

**Files:** Modify `src/components/LogList.tsx`

- [ ] **Step 1：扩展底部 footer**

打开 `src/components/LogList.tsx`。在文件顶部 import 区下方加：

```tsx
const FOOTER_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace', 'unknown'];
const FOOTER_LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-700',
  warn: 'text-amber-700',
  info: 'text-blue-700',
  debug: 'text-cyan-700',
  trace: 'text-slate-700',
  unknown: 'text-slate-500',
};
```

把现有 footer 那行：

```tsx
<div className="px-3 py-1 text-xs text-slate-500 border-t bg-slate-50">
  匹配 {result.total_matched.toLocaleString()} 条
</div>
```

改为：

```tsx
<div className="flex items-center gap-3 px-3 py-1 text-xs border-t bg-slate-50 flex-wrap">
  <span className="font-semibold text-slate-700">
    匹配 {result.total_matched.toLocaleString()} 条
  </span>
  {FOOTER_LEVELS.map((lv) => {
    const n = result.stats.level_counts[lv] ?? 0;
    if (n === 0) return null;
    return (
      <span key={lv} className="flex items-center gap-2">
        <span className="text-slate-300">·</span>
        <span className={FOOTER_LEVEL_COLOR[lv]}>
          {lv.toUpperCase()} {n.toLocaleString()}
        </span>
      </span>
    );
  })}
</div>
```

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/LogList.tsx
git commit -m "style(LogList): footer shows level counts inline next to match count"
```

---

## Phase 5：剩余小组件微调

### Task 5.1：ExportMenu / TemplateManagerDialog / DetailDrawer / RotationDialog 按钮微调

**Files:** Modify 4 files

- [ ] **Step 1：ExportMenu 主按钮换 .ctl**

打开 `src/components/ExportMenu.tsx`。把：
```tsx
<button
  onClick={() => setOpen((v) => !v)}
  disabled={busy}
  className="px-2 py-0.5 text-xs rounded border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50"
  title="导出当前匹配条目"
>
```
改为：
```tsx
<button
  onClick={() => setOpen((v) => !v)}
  disabled={busy}
  className="ctl"
  title="导出当前匹配条目"
>
```

- [ ] **Step 2：DetailDrawer 底部两个 button 换 .ctl**

打开 `src/components/DetailDrawer.tsx`。`<section className="flex gap-2 pt-2">` 内的两个按钮：

```tsx
<button
  onClick={applyScope}
  disabled={!entry.scope}
  className="px-3 py-1 text-xs bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-50"
>
  应用 scope 筛选
</button>
<button
  onClick={applyTimeWindow}
  disabled={!entry.timestamp}
  className="px-3 py-1 text-xs bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-50"
>
  按时间区间 ±5 分钟
</button>
```

改为：

```tsx
<button onClick={applyScope} disabled={!entry.scope} className="ctl">
  应用 scope 筛选
</button>
<button onClick={applyTimeWindow} disabled={!entry.timestamp} className="ctl">
  按时间区间 ±5 分钟
</button>
```

- [ ] **Step 3：RotationDialog 两个 button 换 .ctl / .ctl-primary**

打开 `src/components/RotationDialog.tsx`。

把：
```tsx
{canReload && (
  <button
    onClick={handleReload}
    className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
  >
    重新加载
  </button>
)}
<button
  onClick={() => setRotationKind(null)}
  className="px-3 py-1.5 bg-slate-100 text-sm rounded hover:bg-slate-200"
>
  关闭
</button>
```

改为：
```tsx
{canReload && (
  <button onClick={handleReload} className="ctl ctl-primary">
    重新加载
  </button>
)}
<button onClick={() => setRotationKind(null)} className="ctl">
  关闭
</button>
```

- [ ] **Step 4：TemplateManagerDialog 底部按钮换 .ctl**

打开 `src/components/TemplateManagerDialog.tsx`。找到底部一组按钮：

```tsx
<div className="flex gap-2 pt-2">
  <button onClick={handleTest} className="px-3 py-1 bg-slate-200 rounded hover:bg-slate-300">
    测试解析
  </button>
  <button
    onClick={handleSave}
    disabled={saving || !editing.id || !editing.pattern}
    className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
  >
    {saving ? '保存中…' : '保存'}
  </button>
  <button onClick={onClose} className="ml-auto px-3 py-1 bg-slate-100 rounded">取消</button>
</div>
```

改为：

```tsx
<div className="flex gap-2 pt-2">
  <button onClick={handleTest} className="ctl">测试解析</button>
  <button
    onClick={handleSave}
    disabled={saving || !editing.id || !editing.pattern}
    className="ctl ctl-primary"
  >
    {saving ? '保存中…' : '保存'}
  </button>
  <button onClick={onClose} className="ctl ml-auto">取消</button>
</div>
```

- [ ] **Step 5：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/{ExportMenu,DetailDrawer,RotationDialog,TemplateManagerDialog}.tsx
git commit -m "style: misc components — buttons use .ctl / .ctl-primary"
```

---

## Phase 6：收尾

### Task 6.1：全测试 + 手动验收

- [ ] **Step 1：全测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | grep "test result" | head -5
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm test 2>&1 | tail -3
```
Expected: all green。

- [ ] **Step 2：手动验收 — 让用户跑 `npm run tauri dev`**

清单：
- [ ] 顶部 header 3 个控件视觉等高（28px）：`📂 打开 | ▾` segment / 模板按钮 / 实时跟踪 chip
- [ ] 实时跟踪点击开 → 绿色 chip 带脉冲 dot
- [ ] 顶部右上只显示 path（没有 "X 行" 和 "模板 Y"）
- [ ] FilterBar 三行内 input / select / segment 全 28px 等高
- [ ] StatsPanel 顶部只有 sparkline + scope tags（无 total / level counts 行）
- [ ] 列表底部 footer：`匹配 N 条 · ERROR x · WARN y · INFO z`（0 计数 level 不显示）
- [ ] 顶部"📂 打开"点击触发文件对话框；"▾" 点击展开最近文件下拉，点选直接打开
- [ ] 详情抽屉底部两个按钮、模板管理对话框三按钮、轮转对话框两按钮都是 28px 高
- [ ] Export 菜单按钮也是 28px

---

### Task 6.2：README 更新

**Files:** Modify `README.md`

- [ ] **Step 1：把当前状态改为最新**

在 README 的 "当前状态" 行下方加一句：

```markdown
**最新视觉规范**：统一 28px 控件高度、Linear/Notion 风格、StatsPanel 瘦身、level 计数下沉到 footer。
```

- [ ] **Step 2：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add README.md
git commit -m "docs: README — style v3 visual norms shipped"
```

---

## 完成判定

- [ ] `cargo test` 全绿（不动 Rust，应继续过）
- [ ] `npm test` 全绿
- [ ] 手动验收清单全过
- [ ] 提交按 task 分散

预估：9 个 task / 1.5-2 小时。
