# Log Viewer — Plan 2b（实时跟踪 + 详情抽屉 + sparkline + 轮转）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Plan 2a（多模板 + 嗅探 + 模板管理）基础上加：① 点击行打开详情抽屉看完整 fields/raw、② StatsPanel 嵌入时间桶 sparkline、③ 实时跟踪文件追加 + 文件轮转检测。

**Architecture:** 详情抽屉是纯前端（zustand 加 `selectedLineNo`）。Sparkline 后端在 `stats::aggregate` 同时算 time_buckets 一并返回；前端用 recharts AreaChart 嵌入 StatsPanel 顶部。实时跟踪用 `notify` watcher + 增量解析（保留多行合并语义，500ms 无新行 flush），新条目通过 Tauri event 推给前端。轮转检测在 watcher 事件里比对 inode + size 触发 RotationDialog。

**Tech Stack:** 复用 Plan 2a · Rust 新增 `notify = "6"` · 前端新增 `recharts`

**Spec：** [2026-05-22-log-viewer-plan2-design.md §4 §5](../specs/2026-05-22-log-viewer-plan2-design.md)

---

## 文件结构（本 Plan 涉及）

```
src-tauri/
├── Cargo.toml                              (修改：+ notify)
├── src/
│   ├── model.rs                            (修改：加 TimeBucket，Stats 加 time_buckets)
│   ├── loader/
│   │   ├── reader.rs                       (修改：加 file_size_and_inode helper)
│   │   ├── watcher.rs                      (新)
│   │   └── incremental.rs                  (新：IncrementalParser pending buffer)
│   ├── stats/
│   │   ├── aggregator.rs                   (修改：aggregate 同时算 time_buckets)
│   │   └── buckets.rs                      (新：time_buckets 函数 + 桶宽自适应)
│   ├── session/state.rs                    (修改：加 follow + watcher 句柄 + IncrementalState)
│   ├── commands.rs                         (修改：+ start/stop_follow，aggregate 调用补 time_range)
│   └── lib.rs                              (修改：注册 2 个新 command + app_handle 提供给 watcher)

src/
├── types/log.ts                            (修改：加 TimeBucket + Stats.time_buckets)
├── api/commands.ts                         (修改：+ startFollow/stopFollow)
├── state/session.ts                        (修改：+ follow/selectedLineNo/appendEntries/pendingAppend)
├── hooks/
│   ├── useTailFollow.ts                    (新)
│   └── useKeyboardNav.ts                   (新：drawer 里 ↑↓)
├── components/
│   ├── DetailDrawer.tsx                    (新)
│   ├── TrendSparkline.tsx                  (新)
│   ├── FollowToggle.tsx                    (新)
│   ├── RotationDialog.tsx                  (新)
│   ├── LogList.tsx                         (修改：点击行 + 高亮选中 + "↓N 条"浮动按钮)
│   ├── StatsPanel.tsx                      (修改：嵌入 TrendSparkline)
│   └── App.tsx                             (修改：装 DetailDrawer + FollowToggle + RotationDialog)
```

---

## Phase 1：详情抽屉

### Task 1.1：zustand 加 selectedLineNo

**Files:** Modify `src/state/session.ts`

- [ ] **Step 1：加 state + setter**

在 `src/state/session.ts` 的 `SessionStore` 接口加：
```ts
selectedLineNo: number | null;
setSelectedLineNo: (n: number | null) => void;
```

初值 `selectedLineNo: null`；action `setSelectedLineNo: (n) => set({ selectedLineNo: n })`。

`setMetadata` 已经更新 `currentTemplateId`，这里再加一行：换文件时清空选择：
```ts
setMetadata: (m) => set({ metadata: m, currentTemplateId: m?.template_id ?? null, selectedLineNo: null }),
```

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/state/session.ts
git commit -m "feat(fe): add selectedLineNo to session store"
```

---

### Task 1.2：LogList 点击高亮

**Files:** Modify `src/components/LogList.tsx`

- [ ] **Step 1：行点击 + 高亮选中**

打开 `src/components/LogList.tsx`。从 `useSession` 解构里加 `selectedLineNo`, `setSelectedLineNo`：

```tsx
const { spec, result, selectedLineNo, setSelectedLineNo } = useSession();
```

修改 `Row` 组件，加 `onClick` 和高亮 class：

```tsx
const Row = ({ index, style }: ListChildComponentProps) => {
  const e = entries[index];
  if (!e) {
    const pageIdx = Math.floor(index / PAGE_SIZE);
    fetchPage(pageIdx);
    return <div style={style} className="px-2 text-slate-300 text-xs flex items-center">…</div>;
  }
  const isSelected = selectedLineNo === e.line_no;
  return (
    <div
      style={style}
      onClick={() => setSelectedLineNo(isSelected ? null : e.line_no)}
      className={[
        'px-2 text-xs flex items-center gap-3 font-mono border-b border-slate-100 cursor-pointer',
        isSelected ? 'bg-blue-50' : 'hover:bg-slate-50',
      ].join(' ')}
    >
      <span className="text-slate-400 w-16 text-right">
        {e.line_count > 1 ? `#${e.line_no}-${e.line_no + e.line_count - 1}` : `#${e.line_no}`}
      </span>
      <span className="text-slate-500 w-40 truncate">{e.timestamp ?? '-'}</span>
      <span className={['w-12 uppercase', LEVEL_COLOR[e.level]].join(' ')}>{e.level}</span>
      <span className="text-slate-600 w-32 truncate">[{e.scope ?? '-'}]</span>
      <span className="flex-1 truncate">{e.message || e.raw}</span>
    </div>
  );
};
```

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/LogList.tsx
git commit -m "feat(fe): row click selects line + highlight selected row"
```

---

### Task 1.3：useKeyboardNav hook

**Files:** Create `src/hooks/useKeyboardNav.ts`

- [ ] **Step 1：写 hook**

```ts
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
```

注意：MVP 仅在当前已加载的 `page_entries`（首页 200 条）内切换。跨页用 `getPage` 复杂度高，留待将来。

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/hooks/useKeyboardNav.ts
git commit -m "feat(fe): keyboard nav for detail drawer (↑↓ Esc)"
```

---

### Task 1.4：DetailDrawer 组件 + App 装配

**Files:** Create `src/components/DetailDrawer.tsx`, Modify `src/App.tsx`

- [ ] **Step 1：写 DetailDrawer**

```tsx
// 详情抽屉：右侧滑出，显示选中行的 fields + raw + 快捷筛选按钮

import { useMemo } from 'react';
import { useSession } from '../state/session';
import { useKeyboardNav } from '../hooks/useKeyboardNav';
import type { LogEntry } from '../types/log';

export function DetailDrawer() {
  const { result, selectedLineNo, setSelectedLineNo, patchSpec } = useSession();
  useKeyboardNav();

  const entry: LogEntry | undefined = useMemo(() => {
    if (selectedLineNo == null || !result) return undefined;
    return result.page_entries.find((e) => e.line_no === selectedLineNo);
  }, [selectedLineNo, result]);

  if (!entry) return null;

  const fieldEntries = Object.entries(entry.fields);
  const lineLabel = entry.line_count > 1
    ? `#${entry.line_no}–${entry.line_no + entry.line_count - 1} (${entry.line_count} 行)`
    : `#${entry.line_no}`;

  const applyScope = () => {
    if (!entry.scope) return;
    patchSpec({ scope_filter: { field_name: 'scope', pattern: entry.scope, mode: 'exact' } });
  };

  const applyTimeWindow = () => {
    if (!entry.timestamp) return;
    const t = new Date(entry.timestamp).getTime();
    const from = new Date(t - 5 * 60_000).toISOString();
    const to = new Date(t + 5 * 60_000).toISOString();
    patchSpec({ time_range: [from, to] });
  };

  const copyRaw = () => {
    navigator.clipboard.writeText(entry.raw).catch(() => {});
  };

  return (
    <>
      {/* 半透明遮罩（点击关闭，但只覆盖抽屉之外） */}
      <div
        className="fixed inset-0 bg-transparent z-20"
        onClick={() => setSelectedLineNo(null)}
      />
      {/* 抽屉本体 */}
      <aside
        className="fixed top-0 right-0 h-full w-[35vw] min-w-[380px] max-w-[720px] bg-white shadow-xl border-l z-30 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-2 border-b">
          <h3 className="text-sm font-semibold">详情 {lineLabel}</h3>
          <button
            onClick={() => setSelectedLineNo(null)}
            className="text-slate-500 hover:text-slate-700"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
          <section className="grid grid-cols-2 gap-2 text-xs">
            <Field label="时间" value={entry.timestamp ?? '-'} />
            <Field label="级别" value={entry.level.toUpperCase()} />
            <Field label="Scope" value={entry.scope ?? '-'} />
            <Field label="行号" value={lineLabel} />
          </section>

          <section>
            <div className="text-xs text-slate-500 mb-1">Message</div>
            <div className="border rounded p-2 font-mono text-xs whitespace-pre-wrap break-words">
              {entry.message || '(空)'}
            </div>
          </section>

          {fieldEntries.length > 0 && (
            <section>
              <div className="text-xs text-slate-500 mb-1">Fields ({fieldEntries.length})</div>
              <div className="border rounded divide-y text-xs">
                {fieldEntries.map(([k, v]) => (
                  <div key={k} className="flex gap-2 px-2 py-1 font-mono">
                    <span className="text-slate-500 min-w-[100px]">{k}</span>
                    <span className="flex-1 break-all">{v}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-slate-500">Raw</span>
              <button onClick={copyRaw} className="text-xs text-blue-600 hover:underline">📋 复制</button>
            </div>
            <div className="border rounded p-2 font-mono text-xs whitespace-pre-wrap break-words bg-slate-50">
              {entry.raw}
            </div>
          </section>

          <section className="flex gap-2 pt-2">
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
          </section>
        </div>
      </aside>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-slate-500">{label}</div>
      <div className="font-mono break-all">{value}</div>
    </div>
  );
}
```

- [ ] **Step 2：App.tsx 装配**

在 `src/App.tsx` 顶部 import 加：
```tsx
import { DetailDrawer } from './components/DetailDrawer';
```

在 JSX 最末（`</div>` 之前）加：
```tsx
<DetailDrawer />
```

完整 App.tsx 的 root return JSX 末尾应像：
```tsx
      {showManager && <TemplateManagerDialog onClose={() => setShowManager(false)} />}
      <DetailDrawer />
    </div>
  );
```

- [ ] **Step 3：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/DetailDrawer.tsx src/App.tsx
git commit -m "feat(fe): DetailDrawer with fields/raw + scope/time quick filters"
```

---

## Phase 2：时间桶 sparkline

### Task 2.1：Rust 模型加 TimeBucket（数据迁移）

**Files:** Modify `src-tauri/src/model.rs`

- [ ] **Step 1：加 TimeBucket + 更新 Stats**

打开 `src-tauri/src/model.rs`。在文件末尾（Stats 定义之前的位置）加：

```rust
#[derive(Debug, Clone, Serialize)]
pub struct TimeBucket {
    pub bucket_start: DateTime<Utc>,
    pub total: u32,
    pub by_level: HashMap<LogLevel, u32>,
}
```

修改 `Stats`：
```rust
#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub total: u32,
    pub level_counts: HashMap<LogLevel, u32>,
    pub top_scopes: Vec<(String, u32)>,
    pub time_buckets: Vec<TimeBucket>,    // NEW
}
```

注意：`TimeBucket` 用 `Serialize`（不需要 Deserialize，前端只读）。

- [ ] **Step 2：更新 stats::aggregate 构造（编译让过）**

`stats/aggregator.rs` 里 `aggregate` 函数返回 Stats，要补 `time_buckets: vec![]`（先放空，Task 2.3 真正填）。把：
```rust
Stats { total: matched.len() as u32, level_counts, top_scopes: top }
```
改为：
```rust
Stats { total: matched.len() as u32, level_counts, top_scopes: top, time_buckets: vec![] }
```

- [ ] **Step 3：跑测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test
```
Expected: 全绿（time_buckets 是空 vec，stats 测试不验证它，所以不破现有断言）。

- [ ] **Step 4：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{model.rs,stats/aggregator.rs}
git commit -m "feat(model): add TimeBucket and Stats.time_buckets field"
```

---

### Task 2.2：time_buckets 函数

**Files:** Create `src-tauri/src/stats/buckets.rs`, Modify `src-tauri/src/stats/mod.rs`

- [ ] **Step 1：写 buckets.rs**

```rust
// 时间桶聚合：把 entries 按时间均匀分到 N 个桶，每桶含 total + by_level

use crate::model::{LogEntry, LogLevel, TimeBucket};
use chrono::{DateTime, Duration, Utc};
use std::collections::HashMap;

pub const DEFAULT_BUCKET_COUNT: u32 = 60;

/// 在已匹配的 entries 上按时间均分到 bucket_count 个桶。
/// range 是显示窗口；entries 之外的 ts 会被忽略。
/// 返回的 Vec 长度恰好 = bucket_count（即使某些桶是空也保留，便于前端图表 X 轴对齐）。
pub fn time_buckets(
    entries: &[LogEntry],
    matched: &[u32],
    range: (DateTime<Utc>, DateTime<Utc>),
    bucket_count: u32,
) -> Vec<TimeBucket> {
    let (start, end) = range;
    if end <= start || bucket_count == 0 {
        return vec![];
    }
    let total_ms = (end - start).num_milliseconds().max(1);
    let bucket_ms = (total_ms as f64 / bucket_count as f64).ceil() as i64;
    let bucket_dur = Duration::milliseconds(bucket_ms.max(1));

    // 初始化桶
    let mut buckets: Vec<TimeBucket> = (0..bucket_count).map(|i| TimeBucket {
        bucket_start: start + bucket_dur * (i as i32),
        total: 0,
        by_level: HashMap::new(),
    }).collect();

    for &idx in matched {
        let Some(e) = entries.get(idx as usize) else { continue; };
        let Some(t) = e.timestamp else { continue; };
        if t < start || t >= end { continue; }
        let offset_ms = (t - start).num_milliseconds();
        let bi = ((offset_ms / bucket_ms) as usize).min((bucket_count - 1) as usize);
        let b = &mut buckets[bi];
        b.total += 1;
        *b.by_level.entry(e.level).or_insert(0) += 1;
    }

    buckets
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::collections::HashMap as HMap;

    fn entry_at(level: LogLevel, ts: DateTime<Utc>) -> LogEntry {
        LogEntry {
            line_no: 0,
            line_count: 1,
            timestamp: Some(ts),
            level,
            scope: None,
            message: String::new(),
            fields: HMap::new(),
            raw: String::new(),
        }
    }

    #[test]
    fn allocates_entries_into_buckets() {
        let start = Utc.with_ymd_and_hms(2026, 5, 22, 9, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 5, 22, 9, 1, 0).unwrap();   // 60s
        let entries = vec![
            entry_at(LogLevel::Info,  start),                              // 桶 0
            entry_at(LogLevel::Info,  start + Duration::seconds(30)),     // 桶 30 (60-bucket-min, each ~1s)
            entry_at(LogLevel::Error, start + Duration::seconds(59)),     // 桶 59
        ];
        let matched: Vec<u32> = vec![0, 1, 2];
        let buckets = time_buckets(&entries, &matched, (start, end), 60);
        assert_eq!(buckets.len(), 60);
        assert_eq!(buckets[0].total, 1);
        assert_eq!(buckets[0].by_level.get(&LogLevel::Info), Some(&1));
        assert_eq!(buckets[30].total, 1);
        assert_eq!(buckets[59].total, 1);
        assert_eq!(buckets[59].by_level.get(&LogLevel::Error), Some(&1));
    }

    #[test]
    fn ignores_entries_outside_range() {
        let start = Utc.with_ymd_and_hms(2026, 5, 22, 9, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 5, 22, 9, 1, 0).unwrap();
        let entries = vec![
            entry_at(LogLevel::Info, start - Duration::seconds(10)),
            entry_at(LogLevel::Info, end + Duration::seconds(10)),
        ];
        let matched: Vec<u32> = vec![0, 1];
        let buckets = time_buckets(&entries, &matched, (start, end), 60);
        let sum: u32 = buckets.iter().map(|b| b.total).sum();
        assert_eq!(sum, 0);
    }

    #[test]
    fn returns_empty_for_invalid_range_or_zero_count() {
        let t = Utc.with_ymd_and_hms(2026, 5, 22, 9, 0, 0).unwrap();
        assert!(time_buckets(&[], &[], (t, t), 60).is_empty());
        assert!(time_buckets(&[], &[], (t, t + Duration::seconds(1)), 0).is_empty());
    }
}
```

- [ ] **Step 2：mod.rs 声明 + 重导出**

`src-tauri/src/stats/mod.rs` 改为：
```rust
pub mod aggregator;
pub mod buckets;

pub use aggregator::aggregate;
pub use buckets::{time_buckets, DEFAULT_BUCKET_COUNT};
```

- [ ] **Step 3：跑测试 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib stats::
```
Expected: 3（aggregator）+ 3（buckets） = 6 pass。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/stats
git commit -m "feat(stats): time_buckets allocator with adaptive bucket width"
```

---

### Task 2.3：cmd_query 同时填 time_buckets

**Files:** Modify `src-tauri/src/commands.rs`

- [ ] **Step 1：query 里调 time_buckets**

打开 `src-tauri/src/commands.rs`。`cmd_query` 当前是：

```rust
let matched = query::run_query(&state, &spec)?;
let stats = state.with_entries(|entries| stats::aggregate(entries, &matched))?;
```

把它改为：

```rust
let matched = query::run_query(&state, &spec)?;
let meta = state.metadata()?;
let stats = state.with_entries(|entries| {
    let mut s = stats::aggregate(entries, &matched);
    // 时间窗口：用 spec.time_range（若有）否则用文件整体 time_range
    let range = spec.time_range.or(meta.time_range);
    if let Some((from, to)) = range {
        s.time_buckets = stats::time_buckets(entries, &matched, (from, to), stats::DEFAULT_BUCKET_COUNT);
    }
    s
})?;
```

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -3
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/commands.rs
git commit -m "feat(commands): cmd_query fills stats.time_buckets when time range known"
```

---

### Task 2.4：TS 类型 + 安装 recharts

**Files:** Modify `src/types/log.ts`, `package.json`

- [ ] **Step 1：装依赖**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
npm install recharts
```

- [ ] **Step 2：加类型**

在 `src/types/log.ts` 的 `Stats` 接口下面加：

```ts
export interface TimeBucket {
  bucket_start: string;          // RFC3339
  total: number;
  by_level: Partial<Record<LogLevel, number>>;
}
```

然后 `Stats` 加字段：

```ts
export interface Stats {
  total: number;
  level_counts: Partial<Record<LogLevel, number>>;
  top_scopes: [string, number][];
  time_buckets: TimeBucket[];     // NEW
}
```

- [ ] **Step 3：build + commit**

```bash
npm run build 2>&1 | tail -3
git add src/types/log.ts package.json package-lock.json
git commit -m "feat(fe): TimeBucket type + install recharts"
```

---

### Task 2.5：TrendSparkline 组件 + 嵌入 StatsPanel

**Files:** Create `src/components/TrendSparkline.tsx`, Modify `src/components/StatsPanel.tsx`

- [ ] **Step 1：写 TrendSparkline**

```tsx
// 时间桶趋势图（嵌入 StatsPanel 顶部，约 60px 高，按 level 堆叠）

import { ResponsiveContainer, AreaChart, Area, Tooltip, Brush, type TooltipProps } from 'recharts';
import { useMemo } from 'react';
import { useSession } from '../state/session';
import type { TimeBucket } from '../types/log';

interface ChartRow {
  bucket_start: string;
  error: number;
  warn: number;
  info: number;
  debug: number;
  trace: number;
  unknown: number;
}

function toRows(buckets: TimeBucket[]): ChartRow[] {
  return buckets.map((b) => ({
    bucket_start: b.bucket_start,
    error: b.by_level.error ?? 0,
    warn:  b.by_level.warn  ?? 0,
    info:  b.by_level.info  ?? 0,
    debug: b.by_level.debug ?? 0,
    trace: b.by_level.trace ?? 0,
    unknown: b.by_level.unknown ?? 0,
  }));
}

function fmtBucket(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch { return ts; }
}

function TrendTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-white border rounded p-2 text-xs shadow">
      <div className="text-slate-500 mb-1">{fmtBucket(label as string)}</div>
      {payload.filter((p) => (p.value ?? 0) > 0).map((p) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {String(p.dataKey).toUpperCase()}: {p.value}
        </div>
      ))}
    </div>
  );
}

export function TrendSparkline() {
  const { result, patchSpec } = useSession();
  const rows = useMemo(() => toRows(result?.stats.time_buckets ?? []), [result]);

  // 数据少于 3 个非零桶时隐藏（避免不美观的图）
  const nonZeroCount = rows.filter((r) => r.error + r.warn + r.info + r.debug + r.trace + r.unknown > 0).length;
  if (nonZeroCount < 3) return null;

  const onBrushChange = (range: { startIndex?: number; endIndex?: number } | null) => {
    if (!range || range.startIndex == null || range.endIndex == null) return;
    if (range.startIndex === 0 && range.endIndex === rows.length - 1) return; // 全选不缩窄
    const from = rows[range.startIndex]?.bucket_start;
    const to = rows[range.endIndex]?.bucket_start;
    if (from && to) patchSpec({ time_range: [from, to] });
  };

  return (
    <div className="w-full" style={{ height: 76 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 2, right: 8, left: 8, bottom: 0 }}>
          <Area dataKey="error"   stackId="1" stroke="#b91c1c" fill="#fecaca" />
          <Area dataKey="warn"    stackId="1" stroke="#a16207" fill="#fde68a" />
          <Area dataKey="info"    stackId="1" stroke="#1d4ed8" fill="#bfdbfe" />
          <Area dataKey="debug"   stackId="1" stroke="#0e7490" fill="#a5f3fc" />
          <Area dataKey="trace"   stackId="1" stroke="#475569" fill="#e2e8f0" />
          <Area dataKey="unknown" stackId="1" stroke="#94a3b8" fill="#f1f5f9" />
          <Tooltip content={<TrendTooltip />} />
          <Brush dataKey="bucket_start" height={12} stroke="#94a3b8" travellerWidth={6} onChange={onBrushChange} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2：StatsPanel 嵌入**

打开 `src/components/StatsPanel.tsx`，在 `export function StatsPanel()` 的返回 JSX 顶部加 TrendSparkline。完整新版：

```tsx
import { useSession } from '../state/session';
import type { LogLevel } from '../types/log';
import { TrendSparkline } from './TrendSparkline';

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace', 'unknown'];
const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-700',
  warn: 'text-amber-700',
  info: 'text-blue-700',
  debug: 'text-cyan-700',
  trace: 'text-slate-700',
  unknown: 'text-slate-500',
};

export function StatsPanel() {
  const { result, patchSpec } = useSession();
  if (!result) return null;
  const { total, level_counts, top_scopes } = result.stats;

  return (
    <div className="border-b bg-slate-50 px-3 py-2 text-xs">
      <TrendSparkline />
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
      {top_scopes.length > 0 && (
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className="text-slate-500">Top scope：</span>
          {top_scopes.map(([name, count]) => (
            <button
              key={name}
              onClick={() => patchSpec({
                scope_filter: { field_name: 'scope', pattern: name, mode: 'exact' },
              })}
              className="px-2 py-0.5 rounded bg-white border hover:bg-slate-100"
              title="点击应用为 scope 筛选"
            >
              {name} <span className="text-slate-400">{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -5
git add src/components/{StatsPanel,TrendSparkline}.tsx
git commit -m "feat(fe): TrendSparkline with stacked level chart + Brush filter"
```

---

## Phase 3：实时跟踪 + 轮转检测

### Task 3.1：reader 加 file_meta helper

**Files:** Modify `src-tauri/src/loader/reader.rs`

- [ ] **Step 1：加 file_meta 函数**

打开 `src-tauri/src/loader/reader.rs`，在 `read_all_lines` 之后加：

```rust
use std::os::unix::fs::MetadataExt;

#[derive(Debug, Clone, Copy)]
pub struct FileMeta {
    pub size: u64,
    pub inode: u64,
}

pub fn file_meta(path: &Path) -> Result<FileMeta, AppError> {
    let m = std::fs::metadata(path)?;
    Ok(FileMeta { size: m.len(), inode: m.ino() })
}

/// 从 byte 偏移开始读到 EOF；返回新读到的字符串
pub fn read_from(path: &Path, offset: u64) -> Result<String, AppError> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}
```

注：仅 macOS / Linux 支持 `MetadataExt::ino()`；Windows 暂用 `0`（Plan 2b MVP 不验证 Windows，按 `#[cfg(unix)]` gating）。最简：先用 `#[cfg(unix)]` 包整段，windows 用 `pub fn file_meta(...) -> ... { Ok(FileMeta { size: m.len(), inode: 0 }) }`。

完整加法：

```rust
#[derive(Debug, Clone, Copy)]
pub struct FileMeta {
    pub size: u64,
    pub inode: u64,
}

#[cfg(unix)]
pub fn file_meta(path: &Path) -> Result<FileMeta, AppError> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path)?;
    Ok(FileMeta { size: m.len(), inode: m.ino() })
}

#[cfg(not(unix))]
pub fn file_meta(path: &Path) -> Result<FileMeta, AppError> {
    let m = std::fs::metadata(path)?;
    Ok(FileMeta { size: m.len(), inode: 0 })
}

pub fn read_from(path: &Path, offset: u64) -> Result<String, AppError> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}
```

- [ ] **Step 2：写测试**

在 `reader.rs` 末尾 `tests` 模块里加：

```rust
    #[test]
    fn file_meta_returns_size() {
        let f = write_temp(b"hello world");
        let m = file_meta(f.path()).unwrap();
        assert_eq!(m.size, 11);
    }

    #[test]
    fn read_from_returns_tail_after_offset() {
        let f = write_temp(b"line1\nline2\n");
        let tail = read_from(f.path(), 6).unwrap();
        assert_eq!(tail, "line2\n");
    }
```

- [ ] **Step 3：测试 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib loader::
```
Expected: 6 pass（原 4 + 2 新）。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/loader/reader.rs
git commit -m "feat(loader): add file_meta (size+inode) and read_from(offset)"
```

---

### Task 3.2：IncrementalParser（pending buffer + flush）

**Files:** Create `src-tauri/src/loader/incremental.rs`, Modify `src-tauri/src/loader/mod.rs`

- [ ] **Step 1：写 IncrementalParser**

```rust
// 增量解析：处理 watcher 持续追加的新行
// 关键问题：行可能"半截到"（追加缓冲不完整），且多行合并要跨事件保持状态

use crate::model::LogEntry;
use crate::parser::template::{self, ParserTemplate};

pub struct IncrementalParser {
    /// 未消化的 partial 行（最后一行可能没有 \n）
    partial: String,
    /// 当前正在累积的逻辑日志记录（多行合并）
    pending: Vec<String>,
    pending_start_line: u32,
    /// 下一条 entry 的起始行号
    next_line_no: u32,
}

impl IncrementalParser {
    pub fn new(next_line_no: u32) -> Self {
        Self {
            partial: String::new(),
            pending: Vec::new(),
            pending_start_line: next_line_no,
            next_line_no,
        }
    }

    /// 喂入新增的文本片段（可能跨多行，最后行可能不完整）。
    /// 返回本次完成的 LogEntry（不含还在 pending 里的当前 record）。
    pub fn feed<T: ParserTemplate + ?Sized>(&mut self, tpl: &T, chunk: &str) -> Vec<LogEntry> {
        self.partial.push_str(chunk);
        let mut out = Vec::new();
        // 反复找下一个 \n：完整行就 push 到 buffer 里走切分；最后没有 \n 的部分留作下次的 partial
        while let Some(pos) = self.partial.find('\n') {
            let mut line = self.partial[..pos].to_string();
            // 去掉行尾 \r
            if line.ends_with('\r') { line.pop(); }
            self.partial.drain(..=pos);
            self.consume_line(tpl, line, &mut out);
        }
        out
    }

    /// 时间到了（如 watcher 静默 500ms），把当前 pending 收尾推送
    pub fn flush<T: ParserTemplate + ?Sized>(&mut self, tpl: &T) -> Vec<LogEntry> {
        let mut out = Vec::new();
        if !self.pending.is_empty() {
            self.finalize_pending(tpl, &mut out);
        }
        out
    }

    pub fn next_line_no(&self) -> u32 { self.next_line_no }

    fn consume_line<T: ParserTemplate + ?Sized>(&mut self, tpl: &T, line: String, out: &mut Vec<LogEntry>) {
        let is_start = tpl.is_record_start(&line);
        if is_start {
            // 收尾旧 record
            if !self.pending.is_empty() {
                self.finalize_pending(tpl, out);
            }
            self.pending_start_line = self.next_line_no;
        } else if self.pending.is_empty() {
            // 文件最开头就遇到非起始行 — 用孤儿兜底（仅这一行）
            self.pending_start_line = self.next_line_no;
        }
        self.pending.push(line);
        self.next_line_no += 1;
    }

    fn finalize_pending<T: ParserTemplate + ?Sized>(&mut self, tpl: &T, out: &mut Vec<LogEntry>) {
        let line_count = self.pending.len() as u32;
        let raw_joined = self.pending.join("\n");
        let entry = match tpl.parse_record(&self.pending) {
            Some(p) => template::finalize(self.pending_start_line, line_count, &raw_joined, p),
            None    => template::fallback(self.pending_start_line, line_count, &raw_joined),
        };
        out.push(entry);
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::json_lines::JsonLinesTemplate;

    #[test]
    fn feed_complete_jsonl_lines() {
        let mut p = IncrementalParser::new(1);
        let r = p.feed(&JsonLinesTemplate, "{\"level\":\"info\",\"msg\":\"a\"}\n{\"level\":\"warn\",\"msg\":\"b\"}\n");
        // 注意：JsonLines 的 is_record_start 对每个 {..} 行返回 true，所以第一条会在第二条到来时 finalize
        // 第三条没到 —— 第二条还在 pending；第一条已 out
        assert_eq!(r.len(), 1);
        // flush 把第二条吐出
        let r2 = p.flush(&JsonLinesTemplate);
        assert_eq!(r2.len(), 1);
    }

    #[test]
    fn feed_handles_partial_last_line() {
        let mut p = IncrementalParser::new(1);
        // 第一次：完整一行 + 半行
        let r1 = p.feed(&JsonLinesTemplate, "{\"level\":\"info\",\"msg\":\"a\"}\n{\"lev");
        assert_eq!(r1.len(), 0); // 第一条还在 pending（json-lines 要新起始行才会收尾）
        // 第二次：补全半行
        let r2 = p.feed(&JsonLinesTemplate, "el\":\"warn\",\"msg\":\"b\"}\n");
        assert_eq!(r2.len(), 1); // 第一条被 finalize
        // flush 第二条
        let r3 = p.flush(&JsonLinesTemplate);
        assert_eq!(r3.len(), 1);
    }

    #[test]
    fn line_numbers_continue_across_feeds() {
        let mut p = IncrementalParser::new(100);
        let _ = p.feed(&JsonLinesTemplate, "{\"level\":\"info\",\"msg\":\"a\"}\n{\"level\":\"info\",\"msg\":\"b\"}\n");
        let _ = p.flush(&JsonLinesTemplate);
        assert_eq!(p.next_line_no(), 102);
    }
}
```

- [ ] **Step 2：声明子模块**

`src-tauri/src/loader/mod.rs` 改为：
```rust
pub mod reader;
pub mod incremental;
```

- [ ] **Step 3：测试 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib loader::incremental::
```
Expected: 3 pass。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/loader/{mod.rs,incremental.rs}
git commit -m "feat(loader): IncrementalParser with partial-line buffer + multi-line merge"
```

---

### Task 3.3：FileWatcher（notify + tail read + rotation detect）

**Files:** Create `src-tauri/src/loader/watcher.rs`, Modify `src-tauri/Cargo.toml`, `src-tauri/src/loader/mod.rs`

- [ ] **Step 1：加 notify 依赖**

`src-tauri/Cargo.toml` `[dependencies]`：
```toml
notify = "6"
```

- [ ] **Step 2：写 watcher**

```rust
// 文件 watcher：监听追加 → 触发 on_append；检测 rotation → 触发 on_rotation
// 内部维护 last_offset + last_inode，提供给上层做增量读

use crate::error::AppError;
use crate::loader::reader::{self, FileMeta};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "kind")]
pub enum RotationEvent {
    Truncated,
    InodeChanged,
    Removed,
}

/// 句柄：drop 时停止 watcher 线程
pub struct FileWatcher {
    _watcher: RecommendedWatcher,
    abort: Arc<AtomicBool>,
}

impl FileWatcher {
    /// 启动 watcher。`on_append(chunk)` 每次有新增字节就回调；`on_rotation` 检测到轮转回调。
    pub fn start(
        path: PathBuf,
        initial_meta: FileMeta,
        on_append: Arc<dyn Fn(String) + Send + Sync>,
        on_rotation: Arc<dyn Fn(RotationEvent) + Send + Sync>,
    ) -> Result<Self, AppError> {
        let (tx, rx) = channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }).map_err(|e| AppError::Internal(format!("watcher 初始化失败：{e}")))?;
        watcher.watch(&path, RecursiveMode::NonRecursive)
            .map_err(|e| AppError::Internal(format!("watch 失败：{e}")))?;

        let abort = Arc::new(AtomicBool::new(false));
        let abort_for_thread = abort.clone();
        let last_offset = Arc::new(AtomicU64::new(initial_meta.size));
        let last_inode = initial_meta.inode;
        let path_for_thread = path.clone();

        thread::spawn(move || {
            loop {
                if abort_for_thread.load(Ordering::Relaxed) { break; }
                match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(Ok(_event)) => {
                        // 任何事件都尝试读 tail，并检查 rotation
                        let Ok(meta) = reader::file_meta(&path_for_thread) else {
                            on_rotation(RotationEvent::Removed);
                            break;
                        };
                        if meta.inode != last_inode {
                            on_rotation(RotationEvent::InodeChanged);
                            break;
                        }
                        let cur_offset = last_offset.load(Ordering::Relaxed);
                        if meta.size < cur_offset {
                            on_rotation(RotationEvent::Truncated);
                            break;
                        }
                        if meta.size > cur_offset {
                            if let Ok(tail) = reader::read_from(&path_for_thread, cur_offset) {
                                last_offset.store(meta.size, Ordering::Relaxed);
                                on_append(tail);
                            }
                        }
                    }
                    Ok(Err(_e)) => { /* notify error，忽略下一轮再试 */ }
                    Err(RecvTimeoutError::Timeout) => { /* 周期性醒来检查 abort */ }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        Ok(Self { _watcher: watcher, abort })
    }

    pub fn stop(&self) {
        self.abort.store(true, Ordering::Relaxed);
    }
}

impl Drop for FileWatcher {
    fn drop(&mut self) { self.stop(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::sync::Mutex;
    use tempfile::NamedTempFile;

    #[test]
    fn detects_appended_bytes() {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "init").unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();
        let meta = reader::file_meta(&path).unwrap();

        let collected = Arc::new(Mutex::new(String::new()));
        let collected2 = collected.clone();
        let rot_called = Arc::new(AtomicBool::new(false));

        let _w = FileWatcher::start(
            path.clone(),
            meta,
            Arc::new(move |chunk| {
                collected2.lock().unwrap().push_str(&chunk);
            }),
            Arc::new({
                let r = rot_called.clone();
                move |_| r.store(true, Ordering::Relaxed)
            }),
        ).unwrap();

        // 给 watcher 一点时间装好
        thread::sleep(Duration::from_millis(150));
        // 追加内容
        let mut f2 = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f2, "appended").unwrap();
        f2.flush().unwrap();
        // 等待事件
        thread::sleep(Duration::from_millis(800));

        let s = collected.lock().unwrap().clone();
        assert!(s.contains("appended"), "expected to capture appended bytes, got: {:?}", s);
        assert!(!rot_called.load(Ordering::Relaxed), "no rotation expected");
    }

    #[test]
    fn detects_truncation() {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "lots of content here that will be truncated").unwrap();
        f.flush().unwrap();
        let path = f.path().to_path_buf();
        let meta = reader::file_meta(&path).unwrap();

        let rot_event = Arc::new(Mutex::new(None::<RotationEvent>));
        let rot_event2 = rot_event.clone();
        let _w = FileWatcher::start(
            path.clone(),
            meta,
            Arc::new(|_| {}),
            Arc::new(move |e| *rot_event2.lock().unwrap() = Some(e)),
        ).unwrap();

        thread::sleep(Duration::from_millis(150));
        // 截断为 0 字节
        fs::write(&path, b"").unwrap();
        thread::sleep(Duration::from_millis(800));

        let e = *rot_event.lock().unwrap();
        assert!(matches!(e, Some(RotationEvent::Truncated)), "got {:?}", e);
    }
}
```

- [ ] **Step 3：声明 + 跑测试**

`src-tauri/src/loader/mod.rs`：
```rust
pub mod reader;
pub mod incremental;
pub mod watcher;
```

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib loader::watcher::
```
Expected: 2 pass。第一个测试如果 flaky（OS notify 延迟），把 sleep 调大一点；测试本质是异步的。

- [ ] **Step 4：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/loader/{mod.rs,watcher.rs} src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(loader): FileWatcher with notify + tail read + rotation detect"
```

---

### Task 3.4：SessionState 加 follow + watcher 句柄 + IncrementalState

**Files:** Modify `src-tauri/src/session/state.rs`

- [ ] **Step 1：扩展 SessionInner**

打开 `src-tauri/src/session/state.rs`。`SessionInner` 加字段：

```rust
pub struct SessionInner {
    pub metadata: FileMetadata,
    pub entries: Arc<RwLock<Vec<LogEntry>>>,    // 改为 RwLock 以支持 watcher 追加
    pub cache: HashMap<u64, Arc<Vec<u32>>>,
    pub lines: Arc<Vec<String>>,
    pub watcher: Option<crate::loader::watcher::FileWatcher>,
    pub incremental: Option<crate::loader::incremental::IncrementalParser>,
    pub last_offset: u64,
    pub last_inode: u64,
}
```

注意：`entries` 从 `Arc<Vec<LogEntry>>` 改为 `Arc<RwLock<Vec<LogEntry>>>`，因为 watcher 要追加。

更新所有依赖 `entries` 的方法：

```rust
impl SessionState {
    pub fn load_with_lines(&self, metadata: FileMetadata, entries: Vec<LogEntry>, lines: Vec<String>) {
        let initial_meta = crate::loader::reader::file_meta(std::path::Path::new(&metadata.path))
            .unwrap_or(crate::loader::reader::FileMeta { size: 0, inode: 0 });
        let mut w = self.0.write();
        *w = Some(SessionInner {
            metadata,
            entries: Arc::new(RwLock::new(entries)),
            cache: HashMap::new(),
            lines: Arc::new(lines),
            watcher: None,
            incremental: None,
            last_offset: initial_meta.size,
            last_inode: initial_meta.inode,
        });
    }

    pub fn load(&self, metadata: FileMetadata, entries: Vec<LogEntry>) {
        self.load_with_lines(metadata, entries, vec![])
    }

    pub fn with_entries<F, R>(&self, f: F) -> Result<R, AppError>
    where F: FnOnce(&[LogEntry]) -> R {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        let entries = inner.entries.read();
        Ok(f(&entries))
    }

    pub fn metadata(&self) -> Result<FileMetadata, AppError> {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        Ok(inner.metadata.clone())
    }

    pub fn lines(&self) -> Result<Arc<Vec<String>>, AppError> {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        Ok(inner.lines.clone())
    }

    pub fn cached_or_compute<F>(&self, key: u64, compute: F) -> Result<Arc<Vec<u32>>, AppError>
    where F: FnOnce(&[LogEntry]) -> Vec<u32> {
        {
            let r = self.0.read();
            let inner = r.as_ref().ok_or(AppError::NoSession)?;
            if let Some(hit) = inner.cache.get(&key) {
                return Ok(hit.clone());
            }
        }
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        if let Some(hit) = inner.cache.get(&key) {
            return Ok(hit.clone());
        }
        let entries = inner.entries.read();
        let result = Arc::new(compute(&entries));
        drop(entries);
        inner.cache.insert(key, result.clone());
        Ok(result)
    }

    /// watcher 调用：追加新解析的 entries 到 session；返回新 total
    pub fn append_entries(&self, new_entries: Vec<LogEntry>) -> Result<u32, AppError> {
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        {
            let mut entries = inner.entries.write();
            entries.extend(new_entries);
        }
        inner.cache.clear();   // 简化：任何追加都失效全部缓存
        let total = inner.entries.read().len() as u32;
        // 更新 metadata.total
        inner.metadata.total = total;
        Ok(total)
    }

    pub fn install_watcher(
        &self,
        watcher: crate::loader::watcher::FileWatcher,
        incremental: crate::loader::incremental::IncrementalParser,
    ) -> Result<(), AppError> {
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        inner.watcher = Some(watcher);
        inner.incremental = Some(incremental);
        Ok(())
    }

    pub fn remove_watcher(&self) -> Result<(), AppError> {
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        inner.watcher = None;
        inner.incremental = None;
        Ok(())
    }

    pub fn is_following(&self) -> bool {
        let r = self.0.read();
        r.as_ref().map(|i| i.watcher.is_some()).unwrap_or(false)
    }

    /// 给 watcher 回调用的：拿 incremental 处理 chunk + 追加结果。
    /// 内部分两次 write lock 避免借用冲突（incremental.as_mut() 与 entries.write() 同时持有会失败）。
    pub fn feed_chunk<T: crate::parser::template::ParserTemplate + ?Sized + Sync>(
        &self,
        tpl: &T,
        chunk: &str,
    ) -> Result<Vec<LogEntry>, AppError> {
        // 第一次：跑 incremental
        let new_entries = {
            let mut w = self.0.write();
            let inner = w.as_mut().ok_or(AppError::NoSession)?;
            let inc = inner.incremental.as_mut()
                .ok_or_else(|| AppError::Internal("watcher 未启动".into()))?;
            inc.feed(tpl, chunk)
        };
        // 第二次：append + invalidate cache
        self.append_internal(&new_entries)?;
        Ok(new_entries)
    }

    pub fn flush_incremental<T: crate::parser::template::ParserTemplate + ?Sized + Sync>(
        &self,
        tpl: &T,
    ) -> Result<Vec<LogEntry>, AppError> {
        let new_entries = {
            let mut w = self.0.write();
            let inner = w.as_mut().ok_or(AppError::NoSession)?;
            let inc = inner.incremental.as_mut()
                .ok_or_else(|| AppError::Internal("watcher 未启动".into()))?;
            inc.flush(tpl)
        };
        self.append_internal(&new_entries)?;
        Ok(new_entries)
    }

    fn append_internal(&self, new_entries: &[LogEntry]) -> Result<(), AppError> {
        if new_entries.is_empty() { return Ok(()); }
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        {
            let mut entries = inner.entries.write();
            entries.extend(new_entries.iter().cloned());
        }
        inner.cache.clear();
        let new_total = inner.entries.read().len() as u32;
        inner.metadata.total = new_total;
        Ok(())
    }
}
```

注意：**`with_entries` 的签名变了**（从 `Arc<Vec<LogEntry>>` 闭包参数 → `&[LogEntry]`）。所有调用方都要同步更新。

- [ ] **Step 2：更新调用方**

`src-tauri/src/query/mod.rs` 里 `run_query` 的 closure 签名要改。当前：
```rust
session.cached_or_compute(key, |entries: &Arc<Vec<LogEntry>>| {
    entries.par_iter()
```
改为：
```rust
session.cached_or_compute(key, |entries: &[LogEntry]| {
    entries.par_iter()
```

`src-tauri/src/query/mod.rs` 里 tests 模块同样：dummy 不动，但有可能用 `Arc<Vec<...>>` 的地方都要改 — grep 一下确认。

`src-tauri/src/commands.rs` 的 `cmd_query` / `cmd_get_page` 里也有用：
```rust
let stats = state.with_entries(|entries| stats::aggregate(entries, &matched))?;
```
`entries` 类型从 `&Arc<Vec<LogEntry>>` 变成 `&[LogEntry]` — 实际 deref 后用法一样，可能不需要改字面代码。验证 build 即可。

- [ ] **Step 3：跑测试 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | tail -10
```
Expected: 全绿。如有编译错误（多半在 with_entries 闭包签名），按错误信息修。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{session/state.rs,query/mod.rs,commands.rs}
git commit -m "feat(session): hold watcher handle + incremental parser; mutable entries"
```

---

### Task 3.5：cmd_start_follow / cmd_stop_follow + Tauri event 推送

**Files:** Modify `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1：写 commands**

在 `src-tauri/src/commands.rs` 顶部 import 加：
```rust
use crate::loader::{incremental::IncrementalParser, watcher::{FileWatcher, RotationEvent}};
use tauri::{AppHandle, Emitter, Manager};  // Manager 提供 .state::<T>()
use std::sync::Arc;
```

在文件末尾加：

```rust
#[derive(Serialize, Clone)]
pub struct EntriesAppendedPayload {
    pub entries: Vec<LogEntry>,
    pub total: u32,
}

#[derive(Serialize, Clone)]
pub struct FileRotatedPayload {
    pub kind: String,    // "Truncated" / "InodeChanged" / "Removed"
}

#[tauri::command]
pub fn cmd_start_follow(
    app: AppHandle,
    state: State<'_, SessionState>,
    registry: State<'_, Registry>,
) -> Result<(), AppError> {
    if state.is_following() { return Ok(()); }
    let meta = state.metadata()?;
    let path: std::path::PathBuf = meta.path.clone().into();
    let template_id = meta.template_id.clone();
    let tpl_arc = registry.find(&template_id)
        .ok_or_else(|| AppError::Internal(format!("模板未找到：{template_id}")))?;

    let initial = crate::loader::reader::file_meta(&path)?;
    let next_line_no = meta.total + 1;
    let incremental = IncrementalParser::new(next_line_no);

    // 准备 watcher 回调（注意：Tauri State 不能直接传线程，必须通过 AppHandle 重取）
    let app_for_append = app.clone();
    let app_for_rotation = app.clone();
    let tpl_arc_for_append = tpl_arc.clone();

    let on_append = Arc::new(move |chunk: String| {
        let session: State<'_, SessionState> = app_for_append.state();
        if let Ok(new) = session.feed_chunk(tpl_arc_for_append.as_parser(), &chunk) {
            if !new.is_empty() {
                let total = session.metadata().map(|m| m.total).unwrap_or(0);
                let _ = app_for_append.emit("entries_appended", EntriesAppendedPayload { entries: new, total });
            }
        }
    });
    let on_rotation = Arc::new(move |ev: RotationEvent| {
        let kind = format!("{:?}", ev);
        let _ = app_for_rotation.emit("file_rotated", FileRotatedPayload { kind });
    });

    let watcher = FileWatcher::start(path, initial, on_append, on_rotation)?;
    state.install_watcher(watcher, incremental)?;
    Ok(())
}

#[tauri::command]
pub fn cmd_stop_follow(
    state: State<'_, SessionState>,
    registry: State<'_, Registry>,
) -> Result<(), AppError> {
    if !state.is_following() { return Ok(()); }
    // 先 flush 任何 pending 行
    let meta = state.metadata()?;
    if let Some(tpl_arc) = registry.find(&meta.template_id) {
        let _ = state.flush_incremental(tpl_arc.as_parser());
    }
    state.remove_watcher()
}
```

- [ ] **Step 2：lib.rs 注册**

```rust
.invoke_handler(tauri::generate_handler![
    commands::cmd_open_file,
    commands::cmd_query,
    commands::cmd_get_metadata,
    commands::cmd_get_page,
    commands::cmd_list_templates,
    commands::cmd_reparse_with_template,
    commands::cmd_save_custom_template,
    commands::cmd_delete_custom_template,
    commands::cmd_test_template,
    commands::cmd_start_follow,
    commands::cmd_stop_follow,
])
```

- [ ] **Step 3：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -10
```
Expected: clean compile（可能有 `Emitter` import 警告需要看 tauri 文档；Tauri 2.x 是 `tauri::Emitter` trait）。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{commands.rs,lib.rs}
git commit -m "feat(commands): start_follow/stop_follow + emit entries_appended/file_rotated"
```

---

### Task 3.6：前端 useTailFollow + zustand 扩展

**Files:** Modify `src/state/session.ts`, Modify `src/api/commands.ts`, Create `src/hooks/useTailFollow.ts`

- [ ] **Step 1：zustand 加 follow / pendingAppend / appendEntries**

打开 `src/state/session.ts`，扩展 SessionStore：

```ts
import type { FileMetadata, QuerySpec, QueryResponse, LogLevel, TemplateInfo, LogEntry } from '../types/log';

interface SessionStore {
  metadata: FileMetadata | null;
  spec: QuerySpec;
  result: QueryResponse | null;
  loading: boolean;
  error: string | null;
  templates: TemplateInfo[];
  currentTemplateId: string | null;
  selectedLineNo: number | null;

  follow: boolean;                            // NEW
  rotationKind: string | null;                // NEW: 触发对话框
  newEntriesPending: number;                  // NEW: 当用户不在底部时累积的新条目数

  setMetadata: (m: FileMetadata | null) => void;
  setSpec: (s: QuerySpec) => void;
  patchSpec: (p: Partial<QuerySpec>) => void;
  setResult: (r: QueryResponse | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setTemplates: (ts: TemplateInfo[]) => void;
  setSelectedLineNo: (n: number | null) => void;

  setFollow: (b: boolean) => void;
  setRotationKind: (k: string | null) => void;
  appendEntries: (entries: LogEntry[], total: number) => void;
  clearNewEntriesPending: () => void;
}
```

实现部分（关键新 actions）：

```ts
const ALL_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'unknown'];

export const useSession = create<SessionStore>((set, get) => ({
  metadata: null,
  spec: { levels: ALL_LEVELS },
  result: null,
  loading: false,
  error: null,
  templates: [],
  currentTemplateId: null,
  selectedLineNo: null,

  follow: false,
  rotationKind: null,
  newEntriesPending: 0,

  setMetadata: (m) => set({
    metadata: m,
    currentTemplateId: m?.template_id ?? null,
    selectedLineNo: null,
    newEntriesPending: 0,
  }),
  setSpec: (spec) => set({ spec }),
  patchSpec: (p) => set((s) => ({ spec: { ...s.spec, ...p } })),
  setResult: (result) => set({ result }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setTemplates: (templates) => set({ templates }),
  setSelectedLineNo: (n) => set({ selectedLineNo: n }),
  setFollow: (b) => set({ follow: b }),
  setRotationKind: (k) => set({ rotationKind: k }),
  appendEntries: (newEntries, total) => set((s) => {
    if (!s.result) {
      return {
        metadata: s.metadata ? { ...s.metadata, total } : s.metadata,
        newEntriesPending: s.newEntriesPending + newEntries.length,
      };
    }
    return {
      result: {
        ...s.result,
        total_matched: s.result.total_matched + newEntries.length,
        page_entries: [...s.result.page_entries, ...newEntries],
      },
      metadata: s.metadata ? { ...s.metadata, total } : s.metadata,
      newEntriesPending: s.newEntriesPending + newEntries.length,
    };
  }),
  clearNewEntriesPending: () => set({ newEntriesPending: 0 }),
}));
```

注意：`appendEntries` 简单把所有 entries 追加到 `result.page_entries` 末尾，不重新跑 filter — MVP 简化（新行如果不匹配当前 spec 也会"看起来"在列表，但接下来用户切 spec 时会重新 cmd_query 修正）。Plan 2c 后续可以做精确增量过滤。

- [ ] **Step 2：API 客户端**

`src/api/commands.ts` 末尾追加：

```ts
export async function startFollow(): Promise<void> {
  return invoke<void>('cmd_start_follow');
}

export async function stopFollow(): Promise<void> {
  return invoke<void>('cmd_stop_follow');
}
```

- [ ] **Step 3：useTailFollow hook**

`src/hooks/useTailFollow.ts`：

```ts
// 当 follow=true 时启动后端 watcher 并监听 entries_appended / file_rotated event
// follow=false 时停止

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { startFollow, stopFollow, getMetadata } from '../api/commands';
import { useSession } from '../state/session';
import type { LogEntry } from '../types/log';

interface AppendPayload { entries: LogEntry[]; total: number; }
interface RotatePayload { kind: string; }

export function useTailFollow() {
  const { metadata, follow, appendEntries, setRotationKind, setError, setFollow } = useSession();

  useEffect(() => {
    if (!metadata) return;
    if (!follow) {
      stopFollow().catch(() => {});   // best-effort，可能本来就没起
      return;
    }

    let unsubAppend: UnlistenFn | null = null;
    let unsubRotate: UnlistenFn | null = null;

    const setup = async () => {
      try {
        unsubAppend = await listen<AppendPayload>('entries_appended', (e) => {
          appendEntries(e.payload.entries, e.payload.total);
        });
        unsubRotate = await listen<RotatePayload>('file_rotated', (e) => {
          setRotationKind(e.payload.kind);
          setFollow(false);
        });
        await startFollow();
        // 启动后立即刷一次 metadata（让 UI 同步 total）
        const md = await getMetadata();
        useSession.getState().setMetadata(md);
      } catch (err) {
        setError(typeof err === 'string' ? err : JSON.stringify(err));
        setFollow(false);
      }
    };
    setup();

    return () => {
      unsubAppend?.();
      unsubRotate?.();
      stopFollow().catch(() => {});
    };
  }, [metadata, follow, appendEntries, setRotationKind, setError, setFollow]);
}
```

- [ ] **Step 4：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/state/session.ts src/api/commands.ts src/hooks/useTailFollow.ts
git commit -m "feat(fe): useTailFollow hook + appendEntries action + follow state"
```

---

### Task 3.7：FollowToggle + 浮动 "↓N 条" 按钮

**Files:** Create `src/components/FollowToggle.tsx`, Modify `src/components/LogList.tsx`, `src/App.tsx`

- [ ] **Step 1：FollowToggle**

```tsx
// 顶部实时跟踪开关 + 脉冲指示器

import { useSession } from '../state/session';

export function FollowToggle() {
  const { follow, setFollow, metadata } = useSession();
  if (!metadata) return null;

  return (
    <button
      onClick={() => setFollow(!follow)}
      className={[
        'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border',
        follow
          ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
          : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50',
      ].join(' ')}
      title={follow ? '实时跟踪中（点击关闭）' : '实时跟踪关闭（点击开启）'}
    >
      <span className="relative inline-flex items-center justify-center w-3 h-3">
        {follow && (
          <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-75 animate-ping" />
        )}
        <span className={[
          'relative inline-block w-2 h-2 rounded-full',
          follow ? 'bg-emerald-500' : 'bg-slate-400',
        ].join(' ')} />
      </span>
      ⚡ 实时跟踪 {follow ? 'ON' : 'OFF'}
    </button>
  );
}
```

- [ ] **Step 2：LogList 加 "↓N 条" 浮动按钮 + 滚动到底自动追**

打开 `src/components/LogList.tsx`。在 `LogList` 顶部用 `useRef` 拿 `List` 引用 + 监听 scroll 判断是否在底部：

修改 `LogList` 函数：

```tsx
import { useEffect, useRef, useState } from 'react';
import { FixedSizeList as List, ListChildComponentProps, ListOnScrollProps } from 'react-window';
import { getPage } from '../api/commands';
import { useSession } from '../state/session';
import type { LogEntry, LogLevel } from '../types/log';

const PAGE_SIZE = 200;
const ROW_HEIGHT = 28;
const BOTTOM_THRESHOLD = 20; // 距离底部 N px 视为"在底部"

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-700',
  warn: 'text-amber-700',
  info: 'text-blue-700',
  debug: 'text-cyan-700',
  trace: 'text-slate-500',
  unknown: 'text-slate-400',
};

export function LogList() {
  const { spec, result, selectedLineNo, setSelectedLineNo, newEntriesPending, clearNewEntriesPending } = useSession();
  const [entries, setEntries] = useState<(LogEntry | undefined)[]>([]);
  const pendingPages = useRef<Set<number>>(new Set());
  const seq = useRef(0);
  const listRef = useRef<List | null>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    seq.current++;
    pendingPages.current.clear();
    if (!result) { setEntries([]); return; }
    const arr = new Array<LogEntry | undefined>(result.total_matched);
    result.page_entries.forEach((e, i) => { arr[i] = e; });
    setEntries(arr);
    // 新数据：如果在底部，scroll 到新底部
    if (atBottomRef.current && listRef.current) {
      listRef.current.scrollToItem(result.total_matched - 1, 'end');
      clearNewEntriesPending();
    }
  }, [result, spec, clearNewEntriesPending]);

  const fetchPage = async (pageIdx: number) => {
    if (pendingPages.current.has(pageIdx)) return;
    pendingPages.current.add(pageIdx);
    const my = seq.current;
    try {
      const list = await getPage(spec, pageIdx, PAGE_SIZE);
      if (my !== seq.current) return;
      setEntries((prev) => {
        const next = prev.slice();
        list.forEach((e, i) => { next[pageIdx * PAGE_SIZE + i] = e; });
        return next;
      });
    } finally {
      pendingPages.current.delete(pageIdx);
    }
  };

  const onScroll = ({ scrollOffset }: ListOnScrollProps) => {
    if (!result) return;
    const maxScroll = result.total_matched * ROW_HEIGHT - listHeight();
    atBottomRef.current = (maxScroll - scrollOffset) < BOTTOM_THRESHOLD;
    if (atBottomRef.current && newEntriesPending > 0) {
      clearNewEntriesPending();
    }
  };

  const jumpToBottom = () => {
    if (!result || !listRef.current) return;
    listRef.current.scrollToItem(result.total_matched - 1, 'end');
    clearNewEntriesPending();
  };

  const Row = ({ index, style }: ListChildComponentProps) => {
    const e = entries[index];
    if (!e) {
      const pageIdx = Math.floor(index / PAGE_SIZE);
      fetchPage(pageIdx);
      return <div style={style} className="px-2 text-slate-300 text-xs flex items-center">…</div>;
    }
    const isSelected = selectedLineNo === e.line_no;
    return (
      <div
        style={style}
        onClick={() => setSelectedLineNo(isSelected ? null : e.line_no)}
        className={[
          'px-2 text-xs flex items-center gap-3 font-mono border-b border-slate-100 cursor-pointer',
          isSelected ? 'bg-blue-50' : 'hover:bg-slate-50',
        ].join(' ')}
      >
        <span className="text-slate-400 w-16 text-right">
          {e.line_count > 1 ? `#${e.line_no}-${e.line_no + e.line_count - 1}` : `#${e.line_no}`}
        </span>
        <span className="text-slate-500 w-40 truncate">{e.timestamp ?? '-'}</span>
        <span className={['w-12 uppercase', LEVEL_COLOR[e.level]].join(' ')}>{e.level}</span>
        <span className="text-slate-600 w-32 truncate">[{e.scope ?? '-'}]</span>
        <span className="flex-1 truncate">{e.message || e.raw}</span>
      </div>
    );
  };

  if (!result) return null;
  const showFloating = newEntriesPending > 0 && !atBottomRef.current;

  return (
    <div className="flex-1 overflow-hidden relative">
      <List
        ref={listRef}
        height={listHeight()}
        itemCount={result.total_matched}
        itemSize={ROW_HEIGHT}
        width="100%"
        onScroll={onScroll}
      >
        {Row}
      </List>
      {showFloating && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-8 right-6 px-3 py-1.5 bg-blue-600 text-white text-xs rounded-full shadow-lg hover:bg-blue-700"
        >
          ↓ {newEntriesPending.toLocaleString()} 条新日志
        </button>
      )}
      <div className="px-3 py-1 text-xs text-slate-500 border-t bg-slate-50">
        匹配 {result.total_matched.toLocaleString()} 条
      </div>
    </div>
  );
}

function listHeight() {
  return Math.max(0, window.innerHeight - 280);
}
```

- [ ] **Step 3：App.tsx 装 FollowToggle + useTailFollow**

打开 `src/App.tsx`，加 import：
```tsx
import { FollowToggle } from './components/FollowToggle';
import { useTailFollow } from './hooks/useTailFollow';
```

在 `App()` 顶部加：
```tsx
useTailFollow();
```

在 header 里 `<TemplateMenu>` 后面加：
```tsx
{metadata && <FollowToggle />}
```

- [ ] **Step 4：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/{FollowToggle,LogList}.tsx src/App.tsx
git commit -m "feat(fe): FollowToggle + auto-scroll + floating 'N new logs' button"
```

---

### Task 3.8：RotationDialog

**Files:** Create `src/components/RotationDialog.tsx`, Modify `src/App.tsx`

- [ ] **Step 1：组件**

```tsx
// 轮转/截断/删除时弹窗询问用户：重新加载 / 仅停止跟踪 / 关闭

import { useSession } from '../state/session';
import { openFile } from '../api/commands';

const MESSAGES: Record<string, string> = {
  Truncated: '文件被截断（可能日志轮转）。要重新加载文件吗？',
  InodeChanged: '文件被替换（inode 已变）。要重新加载新文件吗？',
  Removed: '文件已被删除。已停止跟踪，保留已加载数据。',
};

export function RotationDialog() {
  const { rotationKind, setRotationKind, metadata, setMetadata, setError } = useSession();
  if (!rotationKind) return null;

  const msg = MESSAGES[rotationKind] ?? `检测到文件变化：${rotationKind}`;
  const canReload = rotationKind !== 'Removed' && metadata;

  const handleReload = async () => {
    if (!metadata) return;
    try {
      const md = await openFile(metadata.path);
      setMetadata(md);
      setRotationKind(null);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
      setRotationKind(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40">
      <div className="bg-white rounded shadow-xl p-6 max-w-md">
        <h3 className="font-semibold mb-3">文件状态变化</h3>
        <p className="text-sm text-slate-700 mb-4">{msg}</p>
        <div className="flex justify-end gap-2">
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
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2：App.tsx**

加 import：
```tsx
import { RotationDialog } from './components/RotationDialog';
```

在 JSX 末尾（DetailDrawer 之前/后均可）加：
```tsx
<RotationDialog />
```

- [ ] **Step 3：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/RotationDialog.tsx src/App.tsx
git commit -m "feat(fe): RotationDialog for file truncation/replacement/removal"
```

---

## Phase 4：收尾

### Task 4.1：跑全测试 + 手动验收清单

- [ ] **Step 1：Rust + 前端全测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | tail -15
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm test 2>&1 | tail -5
```

Expected: all green。Plan 2b 新增大约 **3（buckets）+ 3（incremental）+ 2（watcher） = 8 个后端 test**，加 Plan 2a 的 78 = **86 lib + 6 integration**。

- [ ] **Step 2：手动验收（让用户跑 `npm run tauri dev`）**

清单：
- [ ] 打开 main.log，列表显示正常
- [ ] **StatsPanel 顶部出现 60px 高的彩色 sparkline**，按 level 堆叠
- [ ] sparkline 底部有 brush，拖选时间段 → 列表 + 统计同步收窄
- [ ] **点击列表任一行 → 右侧滑出详情抽屉**，显示 timestamp / level / scope / message / fields / raw
- [ ] 抽屉里按 **↓ ↑** 切换上下一条
- [ ] 按 Esc 或点抽屉外关闭
- [ ] 抽屉里点 "应用 scope 筛选" → 列表 + 统计联动
- [ ] 抽屉里点 "按时间区间 ±5 分钟" → 列表收窄
- [ ] 顶部 "⚡ 实时跟踪 OFF" toggle 点击 → 变 ON 带绿色脉冲指示
- [ ] 另一个终端跑 `echo "[2026-05-22 11:00:00.000] [info] [test] live append from echo" >> /Users/kimyeung/Library/Logs/scrm-client/main.log` → 1-2s 内列表底部出现新条目
- [ ] 滚动列表到上方 → 再次 echo 追加几条 → 右下角浮现 "↓ N 条新日志" 圆形按钮 → 点击跳底
- [ ] 关闭实时跟踪 toggle → 再 echo 不会出现新条目
- [ ] 重新打开 toggle → 之前 echo 累积的几条应该在下一次 watcher 事件时出现

- [ ] **Step 3：（可选）模拟轮转测试**

```bash
# 在 app 跟踪状态下：
# 1. 跑 cp main.log main.log.bak && echo "" > main.log
# 2. 看是否弹 "文件被截断" 对话框
# 3. 点"重新加载"应该重新打开空文件
```

如手动验收过，进入 Task 4.2；如有问题：停下定位 → 修 → 重测。

---

### Task 4.2：README 更新

**Files:** Modify `README.md`

覆盖 `README.md`：

````markdown
# Log Viewer

桌面 GUI 日志查看与分析工具（Tauri + React + TypeScript）。

## 当前状态：Plan 2b 已完成

**核心能力**：
- 6 种内置解析模板 + 自动嗅探 + 自定义模板（管理对话框 + 持久化）
- 多行 entry 自动合并（如 electron-log 尾部 JSON 跨多行）
- bracket-electron 同时支持 `[scope]` 和 `(scope)` 两种 scope 写法
- 按级别 / scope（exact/glob/regex）/ 时间区间 / 关键词筛选
- 虚拟滚动列表（按需分页）
- 总数 + level 分组 + Top scope + **时间桶 sparkline 趋势图**（堆叠 AreaChart + brush 拖选）
- **点击行打开详情抽屉**，显示 fields + raw + 快捷筛选（scope / 时间窗口 ±5min）
- **实时跟踪（tail -f）**：notify watcher 监听追加，自动追加列表 + "↓N 条新日志" 浮动跳底
- **文件轮转/截断/删除检测**：弹窗询问重新加载

## 开发

```bash
npm install
npm run tauri dev
```

## 测试

```bash
cd src-tauri && cargo test     # ~86 lib + 6 integration tests
npm test                       # 前端 vitest
```

## 路径

- 自定义模板存储：`~/Library/Application Support/log-viewer/prefs.json`（macOS）

## 已知 MVP 限制

- 实时跟踪的"增量过滤"目前不重新跑 spec filter — 新条目无条件追加到列表（切换 spec 会重新查询修正）
- 详情抽屉的 ↑/↓ 只在当前已加载的 200 条页面内导航
- 文件轮转检测仅 macOS / Linux（依赖 inode）
````

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add README.md
git commit -m "docs: update README for Plan 2b (tail follow + drawer + sparkline + rotation)"
```

---

## 完成判定

Plan 2b 完成的硬性条件：

- [ ] `cargo test` 全绿（≈ 86 lib + 6 integration）
- [ ] `npm test` 全绿
- [ ] Task 4.1 Step 2 手动验收清单全部通过
- [ ] Git 历史按 task 分散提交

完成后剩下的工作（不在 Plan 2 / 2a / 2b 内）：
- 最近打开文件列表
- 保存/复用筛选器
- 导出 CSV / JSON
- 键盘快捷键全集
- 跨页详情导航
- 增量过滤精确性
