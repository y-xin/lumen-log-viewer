# Cross-page Detail Nav + Keyword Highlight v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DetailDrawer 头部加 ↑/↓ + "第 X / 共 Y 条匹配"，跨全部 matched entries 导航；列表行 + drawer Message/Raw 区在 `text_search` 非空时高亮命中子串。

**Architecture:** 后端新模块 `query/neighbor.rs` 复用 `run_query` 算 matched 索引，按 line_no 定位后 ±1；2 个 Tauri command 包装。前端新 `lib/highlight.ts` 出 `highlightSpans` helper + `HighlightedText` 共享组件，由 LogList 行和 DetailDrawer Message/Raw 共用。

**Tech Stack:** Rust（已有） + React + TypeScript。无新依赖。

**Spec：** [2026-05-22-cross-page-nav-highlight-design.md](../specs/2026-05-22-cross-page-nav-highlight-design.md)

---

## 文件结构

```
src-tauri/src/
├── query/
│   ├── mod.rs                       (修改：pub mod neighbor + 导出 NeighborDir)
│   └── neighbor.rs                  (新：neighbor/position fn + 5 测试)
├── commands.rs                      (修改：cmd_get_neighbor + cmd_get_position)
└── lib.rs                           (修改：注册 2 个 cmd)

src/
├── types/log.ts                     (修改：NeighborDir + NeighborResponse + PositionResponse)
├── api/commands.ts                  (修改：getNeighbor + getPosition)
├── lib/
│   └── highlight.ts                 (新：highlightSpans helper)
├── components/
│   ├── HighlightedText.tsx          (新：mark 渲染组件)
│   ├── LogList.tsx                  (修改：row combined 用 HighlightedText)
│   └── DetailDrawer.tsx             (修改：头部 ↑↓ + position + Message/Raw 高亮)
└── __tests__/
    └── highlight.test.ts            (新：5 测试)
```

---

## Phase 1：后端 neighbor 模块

### Task 1.1：query/neighbor.rs

**Files:** Create `src-tauri/src/query/neighbor.rs`

- [ ] **Step 1：写模块**

新建 `src-tauri/src/query/neighbor.rs`：

```rust
// 跨页详情导航：在 spec 的 matched 列表里按 line_no 定位 ±1
// 复用 query::run_query 的 matched 索引（cache 命中时几乎零成本）

use crate::error::AppError;
use crate::model::LogEntry;
use crate::query::{self, QuerySpec};
use crate::session::SessionState;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct NeighborResponse {
    pub entry: LogEntry,
    pub position: u32,   // 1-based
    pub total: u32,
}

#[derive(Serialize)]
pub struct PositionResponse {
    pub position: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NeighborDir { Prev, Next }

/// 在 matched 列表里找指定 line_no 的位置（None = 不在列表里）
fn find_index(matched: &[u32], entries: &[LogEntry], line_no: u32) -> Option<usize> {
    matched.iter().position(|&i| entries.get(i as usize).map(|e| e.line_no) == Some(line_no))
}

/// 找邻居 entry + 它的位置信息；line_no 不在 matched 或越界 → None
pub fn neighbor(
    state: &SessionState,
    spec: &QuerySpec,
    line_no: u32,
    dir: NeighborDir,
) -> Result<Option<NeighborResponse>, AppError> {
    let matched = query::run_query(state, spec)?;
    state.with_entries(|entries| {
        let cur = find_index(&matched, entries, line_no)?;
        let next_idx = match dir {
            NeighborDir::Prev => if cur == 0 { return None; } else { cur - 1 },
            NeighborDir::Next => if cur + 1 >= matched.len() { return None; } else { cur + 1 },
        };
        let entry_idx = matched[next_idx] as usize;
        let entry = entries.get(entry_idx)?.clone();
        Some(NeighborResponse {
            entry,
            position: (next_idx + 1) as u32,
            total: matched.len() as u32,
        })
    })
}

/// 当前 line_no 在 matched 中的位置（drawer 首次打开用）
pub fn position(
    state: &SessionState,
    spec: &QuerySpec,
    line_no: u32,
) -> Result<Option<PositionResponse>, AppError> {
    let matched = query::run_query(state, spec)?;
    let total = matched.len() as u32;
    let pos = state.with_entries(|entries| find_index(&matched, entries, line_no))?;
    Ok(pos.map(|p| PositionResponse { position: (p + 1) as u32, total }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FileMetadata, LogEntry, LogLevel};
    use std::collections::HashMap;

    fn e(line_no: u32, level: LogLevel, msg: &str) -> LogEntry {
        LogEntry {
            line_no, line_count: 1, timestamp: None, level,
            scope: None, message: msg.into(), fields: HashMap::new(), raw: msg.into(),
        }
    }

    fn fixture() -> SessionState {
        let s = SessionState::default();
        let entries = vec![
            e(1, LogLevel::Info,  "a"),
            e(2, LogLevel::Error, "b"),  // matched
            e(3, LogLevel::Error, "c"),  // matched
            e(4, LogLevel::Info,  "d"),
            e(5, LogLevel::Error, "e"),  // matched
        ];
        let md = FileMetadata {
            path: "/x".into(), total: entries.len() as u32, time_range: None,
            level_counts: HashMap::new(), scopes: vec![],
            scope_counts: HashMap::new(), template_id: "x".into(),
        };
        s.load(md, entries);
        s
    }

    fn err_spec() -> QuerySpec {
        QuerySpec { levels: Some([LogLevel::Error].into_iter().collect()), ..Default::default() }
    }

    #[test]
    fn next_from_middle_returns_next() {
        let s = fixture();
        let r = neighbor(&s, &err_spec(), 2, NeighborDir::Next).unwrap().unwrap();
        assert_eq!(r.entry.line_no, 3);
        assert_eq!(r.position, 2);
        assert_eq!(r.total, 3);
    }

    #[test]
    fn prev_from_middle_returns_prev() {
        let s = fixture();
        let r = neighbor(&s, &err_spec(), 3, NeighborDir::Prev).unwrap().unwrap();
        assert_eq!(r.entry.line_no, 2);
        assert_eq!(r.position, 1);
    }

    #[test]
    fn next_from_last_returns_none() {
        let s = fixture();
        let r = neighbor(&s, &err_spec(), 5, NeighborDir::Next).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn prev_from_first_returns_none() {
        let s = fixture();
        let r = neighbor(&s, &err_spec(), 2, NeighborDir::Prev).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn line_no_not_in_matched_returns_none() {
        let s = fixture();
        let r = neighbor(&s, &err_spec(), 4, NeighborDir::Next).unwrap();
        assert!(r.is_none());
        let p = position(&s, &err_spec(), 4).unwrap();
        assert!(p.is_none());
    }
}
```

- [ ] **Step 2：query/mod.rs 导出**

打开 `src-tauri/src/query/mod.rs`，在已有 `pub mod spec; pub mod filter;` 下方加：

```rust
pub mod neighbor;
```

- [ ] **Step 3：build + 测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib query::neighbor:: 2>&1 | tail -15
```

Expected: 5 个测试全过。

- [ ] **Step 4：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/query/
git commit -m "feat(query): neighbor module — find prev/next matched entry by line_no"
```

---

## Phase 2：Tauri command 装配

### Task 2.1：2 个 tauri command

**Files:** Modify `src-tauri/src/commands.rs`

- [ ] **Step 1：扩展 import + 写 cmd**

打开 `src-tauri/src/commands.rs`。

找到 `use crate::query::{self, QuerySpec};` 那行，下方加：

```rust
use crate::query::neighbor::{NeighborDir, NeighborResponse, PositionResponse};
```

在文件末尾追加：

```rust

// ─── Cross-page Detail Nav ───

#[tauri::command]
pub fn cmd_get_neighbor(
    spec: QuerySpec,
    line_no: u32,
    dir: NeighborDir,
    state: State<'_, SessionState>,
) -> Result<Option<NeighborResponse>, AppError> {
    query::neighbor::neighbor(&state, &spec, line_no, dir)
}

#[tauri::command]
pub fn cmd_get_position(
    spec: QuerySpec,
    line_no: u32,
    state: State<'_, SessionState>,
) -> Result<Option<PositionResponse>, AppError> {
    query::neighbor::position(&state, &spec, line_no)
}
```

- [ ] **Step 2：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -3
```

- [ ] **Step 3：commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(cmd): cmd_get_neighbor + cmd_get_position for drawer ↑/↓ nav"
```

---

### Task 2.2：lib.rs 注册

**Files:** Modify `src-tauri/src/lib.rs`

- [ ] **Step 1：追加 2 个 cmd 到 invoke_handler**

打开 `src-tauri/src/lib.rs`，在 `commands::cmd_rename_saved_filter,` 下方加：

```rust
            commands::cmd_get_neighbor,
            commands::cmd_get_position,
```

- [ ] **Step 2：build + 全测**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -3
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | grep "test result" | head -10
```

Expected: 全绿，prefs 测试 + neighbor 5 个测试都通过。

- [ ] **Step 3：commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(cmd): register cmd_get_neighbor + cmd_get_position"
```

---

## Phase 3：前端基础

### Task 3.1：TS 类型

**Files:** Modify `src/types/log.ts`

- [ ] **Step 1：加 3 个 type**

打开 `src/types/log.ts`，在文件末尾追加：

```ts

// ─── Cross-page Detail Nav ───

export type NeighborDir = 'prev' | 'next';

export interface NeighborResponse {
  entry: LogEntry;
  position: number;     // 1-based
  total: number;
}

export interface PositionResponse {
  position: number;
  total: number;
}
```

- [ ] **Step 2：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 3：commit**

```bash
git add src/types/log.ts
git commit -m "feat(fe): NeighborResponse / PositionResponse / NeighborDir types"
```

---

### Task 3.2：highlight helper + 测试

**Files:** Create `src/lib/highlight.ts`, Create `src/__tests__/highlight.test.ts`

- [ ] **Step 1：写 helper**

新建 `src/lib/highlight.ts`：

```ts
// 关键词高亮辅助：把 text 按 needle（大小写不敏感）切成 hit / 非 hit 段
// needle 空 → 单元素 [{hit:false, text}]，由调用方决定是否包 <mark>

export interface Span { hit: boolean; text: string; }

export function highlightSpans(text: string, needle: string): Span[] {
  if (!needle) return [{ hit: false, text }];
  const lcText = text.toLowerCase();
  const lcNeedle = needle.toLowerCase();
  const out: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lcText.indexOf(lcNeedle, i);
    if (idx < 0) {
      out.push({ hit: false, text: text.slice(i) });
      break;
    }
    if (idx > i) out.push({ hit: false, text: text.slice(i, idx) });
    out.push({ hit: true, text: text.slice(idx, idx + needle.length) });
    i = idx + needle.length;
  }
  return out;
}
```

- [ ] **Step 2：写测试**

新建 `src/__tests__/highlight.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { highlightSpans } from '../lib/highlight';

describe('highlightSpans', () => {
  it('empty needle returns single non-hit span', () => {
    expect(highlightSpans('hello', '')).toEqual([{ hit: false, text: 'hello' }]);
  });

  it('no match returns single non-hit span', () => {
    expect(highlightSpans('hello world', 'xyz')).toEqual([{ hit: false, text: 'hello world' }]);
  });

  it('single match splits into pre / hit / post', () => {
    expect(highlightSpans('foo bar baz', 'bar')).toEqual([
      { hit: false, text: 'foo ' },
      { hit: true, text: 'bar' },
      { hit: false, text: ' baz' },
    ]);
  });

  it('multi match alternates', () => {
    expect(highlightSpans('a-b-c-b', 'b')).toEqual([
      { hit: false, text: 'a-' },
      { hit: true, text: 'b' },
      { hit: false, text: '-c-' },
      { hit: true, text: 'b' },
    ]);
  });

  it('case-insensitive match preserves original casing in output', () => {
    expect(highlightSpans('Foo bar FOO', 'foo')).toEqual([
      { hit: true, text: 'Foo' },
      { hit: false, text: ' bar ' },
      { hit: true, text: 'FOO' },
    ]);
  });
});
```

- [ ] **Step 3：run tests**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm test 2>&1 | tail -7
```

Expected: highlight 5 个 + 已有测试都通过。

- [ ] **Step 4：commit**

```bash
git add src/lib/highlight.ts src/__tests__/highlight.test.ts
git commit -m "feat(fe): highlightSpans helper + 5 unit tests"
```

---

### Task 3.3：HighlightedText 组件

**Files:** Create `src/components/HighlightedText.tsx`

- [ ] **Step 1：写组件**

新建 `src/components/HighlightedText.tsx`：

```tsx
// 关键词高亮渲染：把命中段包 <mark>。
// needle 为空 → 直接渲染 text（不创建 mark 节点）

import { highlightSpans } from '../lib/highlight';

interface Props {
  text: string;
  needle: string;
  className?: string;
}

export function HighlightedText({ text, needle, className }: Props) {
  if (!needle) return <span className={className}>{text}</span>;
  const spans = highlightSpans(text, needle);
  return (
    <span className={className}>
      {spans.map((s, i) =>
        s.hit
          ? <mark key={i} className="bg-yellow-200 text-slate-900 px-0.5 rounded-sm">{s.text}</mark>
          : <span key={i}>{s.text}</span>
      )}
    </span>
  );
}
```

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/HighlightedText.tsx
git commit -m "feat(fe): HighlightedText component wrapping highlightSpans + <mark>"
```

---

## Phase 4：API + UI 集成

### Task 4.1：API invoke 封装

**Files:** Modify `src/api/commands.ts`

- [ ] **Step 1：扩展 import**

打开 `src/api/commands.ts`，把 import 区里的 type 列表追加 3 个：

```ts
import type {
  ...,
  SavedFilter,
  NeighborDir,
  NeighborResponse,
  PositionResponse,
} from '../types/log';
```

- [ ] **Step 2：在文件末尾追加 2 个 invoke**

```ts

// ─── Cross-page Detail Nav ───

export async function getNeighbor(
  spec: QuerySpec,
  lineNo: number,
  dir: NeighborDir,
): Promise<NeighborResponse | null> {
  return invoke<NeighborResponse | null>('cmd_get_neighbor', {
    spec: serializeSpec(spec), lineNo, dir,
  });
}

export async function getPosition(
  spec: QuerySpec,
  lineNo: number,
): Promise<PositionResponse | null> {
  return invoke<PositionResponse | null>('cmd_get_position', {
    spec: serializeSpec(spec), lineNo,
  });
}
```

- [ ] **Step 3：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/api/commands.ts
git commit -m "feat(fe): getNeighbor + getPosition invoke wrappers"
```

---

### Task 4.2：LogList 行高亮

**Files:** Modify `src/components/LogList.tsx`

- [ ] **Step 1：import HighlightedText + 从 useSession 拿 spec**

打开 `src/components/LogList.tsx`。

把已有 import 追加：
```tsx
import { HighlightedText } from './HighlightedText';
```

在 `export function LogList() { ... }` 组件内，找到现有的 useSession 解构：
```tsx
const { spec, result, selectedEntry, setSelectedEntry, newEntriesPending, clearNewEntriesPending } = useSession();
```
`spec` 已经在里面（用于 query），所以不用改 destructure。

- [ ] **Step 2：替换 row 里 combined 渲染**

找到 Row 组件里：
```tsx
<span className="flex-1 flex items-center truncate px-2" title={combined}>
  {combined}
</span>
```

改为：
```tsx
<span className="flex-1 flex items-center truncate px-2" title={combined}>
  <HighlightedText text={combined} needle={spec.text_search ?? ''} />
</span>
```

- [ ] **Step 3：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/LogList.tsx
git commit -m "feat(fe): LogList row highlights text_search hits in message+fields"
```

---

### Task 4.3：DetailDrawer 头部 ↑↓ + position + 高亮

**Files:** Modify `src/components/DetailDrawer.tsx`

- [ ] **Step 1：扩展 import + state + handlers**

打开 `src/components/DetailDrawer.tsx`。

把 `import { useSession } from '../state/session';` 下方加：

```tsx
import { useEffect, useState } from 'react';
import { getNeighbor, getPosition } from '../api/commands';
import { HighlightedText } from './HighlightedText';
```

在 `export function DetailDrawer() {` 内部，原来的 useSession 解构上面/下面合适位置（建议紧贴 useSession 下），加：

```tsx
  const { spec } = useSession();
```

注：原解构是 `const { selectedEntry, setSelectedEntry, patchSpec } = useSession();`，可以合并为：
```tsx
const { selectedEntry, setSelectedEntry, patchSpec, spec } = useSession();
```

- [ ] **Step 2：加 position state + neighbor handlers**

在 `if (!selectedEntry) return null;` **上面** 加：

```tsx
  const [position, setPosition] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  // drawer 首次打开 / selectedEntry 切换 / spec 变化 → 重新算 position
  useEffect(() => {
    if (!selectedEntry) { setPosition(null); setTotal(null); return; }
    getPosition(spec, selectedEntry.line_no).then((p) => {
      if (p) { setPosition(p.position); setTotal(p.total); }
      else { setPosition(null); setTotal(null); }
    }).catch(() => { setPosition(null); setTotal(null); });
  }, [selectedEntry?.line_no, spec]);

  const onPrev = async () => {
    if (!selectedEntry) return;
    const n = await getNeighbor(spec, selectedEntry.line_no, 'prev');
    if (n) { setSelectedEntry(n.entry); setPosition(n.position); setTotal(n.total); }
  };
  const onNext = async () => {
    if (!selectedEntry) return;
    const n = await getNeighbor(spec, selectedEntry.line_no, 'next');
    if (n) { setSelectedEntry(n.entry); setPosition(n.position); setTotal(n.total); }
  };

  const canPrev = position != null && position > 1;
  const canNext = position != null && total != null && position < total;
```

- [ ] **Step 3：替换 header**

找到现有 header：

```tsx
<header className="flex items-center justify-between px-4 py-2 border-b">
  <h3 className="text-sm font-semibold">详情 #{lineLabel}</h3>
  <button
    onClick={() => setSelectedEntry(null)}
    className="text-slate-500 hover:text-slate-700"
    title="关闭 (Esc)"
  >
    ✕
  </button>
</header>
```

改为：

```tsx
<header className="flex items-center gap-2 px-4 py-2 border-b">
  <button
    onClick={onPrev} disabled={!canPrev}
    className="ctl disabled:opacity-40 disabled:cursor-not-allowed"
    style={{ minWidth: 32, justifyContent: 'center' }}
    title="上一条 matched"
  >↑</button>
  <button
    onClick={onNext} disabled={!canNext}
    className="ctl disabled:opacity-40 disabled:cursor-not-allowed"
    style={{ minWidth: 32, justifyContent: 'center' }}
    title="下一条 matched"
  >↓</button>
  <span className="text-xs text-slate-500 min-w-[140px]">
    {position != null && total != null
      ? `第 ${position} / 共 ${total} 条匹配`
      : selectedEntry
        ? '已不在筛选结果中'
        : '—'}
  </span>
  <h3 className="text-sm font-semibold ml-2">详情 #{lineLabel}</h3>
  <button
    onClick={() => setSelectedEntry(null)}
    className="ml-auto text-slate-500 hover:text-slate-700"
    title="关闭 (Esc)"
  >
    ✕
  </button>
</header>
```

- [ ] **Step 4：Message + Raw 高亮**

找到 Message section：
```tsx
<section>
  <div className="text-xs text-slate-500 mb-1">Message</div>
  <div className="border rounded p-2 font-mono text-xs whitespace-pre-wrap break-words">
    {entry.message || '(空)'}
  </div>
</section>
```

改为：
```tsx
<section>
  <div className="text-xs text-slate-500 mb-1">Message</div>
  <div className="border rounded p-2 font-mono text-xs whitespace-pre-wrap break-words">
    {entry.message
      ? <HighlightedText text={entry.message} needle={spec.text_search ?? ''} />
      : '(空)'}
  </div>
</section>
```

找到 Raw section：
```tsx
<div className="border rounded p-2 font-mono text-xs whitespace-pre-wrap break-words bg-slate-50">
  {entry.raw}
</div>
```

改为：
```tsx
<div className="border rounded p-2 font-mono text-xs whitespace-pre-wrap break-words bg-slate-50">
  <HighlightedText text={entry.raw} needle={spec.text_search ?? ''} />
</div>
```

- [ ] **Step 5：build + 测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3 && npm test 2>&1 | tail -5
```

- [ ] **Step 6：commit**

```bash
git add src/components/DetailDrawer.tsx
git commit -m "feat(fe): DetailDrawer ↑↓ neighbor nav + position + Message/Raw highlight"
```

---

## Phase 5：收尾

### Task 5.1：全测试 + 手动验收

- [ ] **Step 1：全测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | grep "test result" | head -10
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm test 2>&1 | tail -5
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

Expected: 全绿。cargo neighbor 5 个新测试 + vitest highlight 5 个新测试。

- [ ] **Step 2：手动验收（用户跑 `npm run tauri dev`）**

清单：
- [ ] 关键词输 "auth" + 点列表中一条 → drawer 头部显示 `↑ ↓ 第 X / 共 Y 条匹配`
- [ ] 点 `↓` → entry 切换；position 加 1；末条时 `↓` disabled
- [ ] 点 `↑` 回退；首条时 `↑` disabled
- [ ] 列表行 message 里 "auth"（不区分大小写）黄底高亮
- [ ] 关键词清空后行内不再渲染 `<mark>` 节点
- [ ] drawer Message + Raw 区也黄底高亮命中
- [ ] 改 spec 让当前 entry 不在 matched（如把 level "ERROR" 取消勾）→ drawer 头显示 "已不在筛选结果中" + 按钮禁用，entry 内容仍可见

---

### Task 5.2：README 更新

**Files:** Modify `README.md`

- [ ] **Step 1：核心能力列表追加 1 条 + 未实现里删**

打开 `README.md`：

在核心能力列表末尾追加：
```markdown
- **跨页详情导航 + 关键词高亮**：详情抽屉 ↑/↓ 跨全部 matched entries 跳转 + 显示 "第 X / 共 Y 条匹配"；列表行 / Message / Raw 区按 text_search 命中黄底高亮
```

在"未实现"段把 `- 跨页详情导航` 那行删掉。

在"已知 MVP 限制"段把 `- 详情抽屉的 ↑/↓ 仅在当前已加载的 200 条页面内导航` 那行删掉（已不是限制）。

更新顶部"当前状态"行：
```markdown
## 当前状态：Plan 2b + Export + Style v3 + Saved Filters + Shortcuts + Detail Nav 已完成
```

- [ ] **Step 2：commit**

```bash
git add README.md
git commit -m "docs: README — cross-page detail nav + keyword highlight shipped"
```

---

## 完成判定

- [ ] `cargo test` 全绿（含 5 个新 neighbor 测试）
- [ ] `npm test` 全绿（含 5 个新 highlight 测试）
- [ ] `npm run build` 干净
- [ ] 手动验收清单全过
- [ ] 提交按 task 分散

预估：10 个 task / 1.5-2 小时。
