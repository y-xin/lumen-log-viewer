# Cross-page Detail Nav + Keyword Highlight v1 设计文档

- **日期**：2026-05-22
- **状态**：设计已认可，待生成实现计划
- **前置**：当前已实现 Shortcuts + Saved Filters + Style v3

## 1. 目标

1. **跨页详情导航**：DetailDrawer 头部加 ↑/↓ 按钮，能在全部 matched entries 之间跳转（不局限于已加载的 200 条 page），并显示位置 "第 X 条 / 共 Y 条匹配"。
2. **关键词高亮**：当 `spec.text_search` 非空时，列表行的 message+fields 区 和 详情抽屉的 Message/Raw 区，把命中子串用 `<mark>` 标黄。

## 2. 非目标

- 键盘 `↑`/`↓` 跳行（用户明确只要 drawer 按钮）
- vim 风格 `j/k` 全局导航
- regex 高亮（保持 substring，与 text_search filter 语义一致）
- 大小写敏感高亮（与 filter 一致，case-insensitive）
- "跳到 drawer 对应行"（drawer 内导航不滚动列表 — 避免与 follow auto-scroll 冲突；后续可加）

## 3. 后端设计

### 3.1 新模块 `src-tauri/src/query/neighbor.rs`

```rust
use crate::error::AppError;
use crate::model::LogEntry;
use crate::query::{self, QuerySpec};
use crate::session::SessionState;

#[derive(serde::Serialize)]
pub struct NeighborResponse {
    pub entry: LogEntry,
    pub position: u32,   // 1-based 在 matched 列表中的位置
    pub total: u32,
}

#[derive(serde::Serialize)]
pub struct PositionResponse {
    pub position: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NeighborDir { Prev, Next }

/// 在 spec 的 matched 列表里找 line_no 的位置；找不到返回 None
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

/// 当前 line_no 在 matched 中的位置（drawer 首次打开时用）
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
```

### 3.2 Tauri 命令（追加到 `commands.rs`）

```rust
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

注册到 `lib.rs` invoke_handler。

### 3.3 query/mod.rs 导出 neighbor

```rust
pub mod neighbor;
```

### 3.4 Rust 单测（在 `neighbor.rs` 末尾）

5 个：
- `next_from_middle_returns_next` — 正常 next
- `prev_from_middle_returns_prev` — 正常 prev
- `next_from_last_returns_none` — 末条 next
- `prev_from_first_returns_none` — 首条 prev
- `line_no_not_in_matched_returns_none` — 当前行不在筛选结果

## 4. 前端设计

### 4.1 类型 `src/types/log.ts`

```ts
export type NeighborDir = 'prev' | 'next';

export interface NeighborResponse {
  entry: LogEntry;
  position: number;
  total: number;
}

export interface PositionResponse {
  position: number;
  total: number;
}
```

### 4.2 API 封装 `src/api/commands.ts`

```ts
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

### 4.3 高亮 helper `src/lib/highlight.ts`

```ts
// 把 text 按 needle（大小写不敏感）切成 hit / 非 hit 段
// needle 空 → 单元素 [{hit:false, text}]
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

测试 5 例：empty needle / no match / single match / multi match / case-insensitive。

### 4.4 共享组件 `src/components/HighlightedText.tsx`

```tsx
import { highlightSpans } from '../lib/highlight';

interface Props { text: string; needle: string; className?: string; }

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

### 4.5 LogList 行内高亮

把 row 里：
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

需要从 `useSession` 拿 `spec.text_search`。

### 4.6 DetailDrawer 头部 + 高亮

#### 4.6.1 头部改造

把：
```tsx
<header className="flex items-center justify-between px-4 py-2 border-b">
  <h3 className="text-sm font-semibold">详情 #{lineLabel}</h3>
  <button onClick={() => setSelectedEntry(null)} ...>✕</button>
</header>
```

改为：
```tsx
<header className="flex items-center gap-2 px-4 py-2 border-b">
  <button onClick={onPrev} disabled={!canPrev} className="ctl" title="上一条 matched (drawer 内)">
    ↑
  </button>
  <button onClick={onNext} disabled={!canNext} className="ctl" title="下一条 matched (drawer 内)">
    ↓
  </button>
  <span className="text-xs text-slate-500 min-w-[100px]">
    {position && total ? `第 ${position} / 共 ${total} 条匹配` : '—'}
  </span>
  <h3 className="text-sm font-semibold ml-2">详情 #{lineLabel}</h3>
  <button onClick={() => setSelectedEntry(null)} className="ml-auto text-slate-500 hover:text-slate-700" title="关闭 (Esc)">
    ✕
  </button>
</header>
```

#### 4.6.2 position 状态 + neighbor handlers

```tsx
const [position, setPosition] = useState<number | null>(null);
const [total, setTotal] = useState<number | null>(null);

// drawer 首次打开 / selectedEntry 切换时获取 position
useEffect(() => {
  if (!selectedEntry) { setPosition(null); setTotal(null); return; }
  getPosition(spec, selectedEntry.line_no).then((p) => {
    if (p) { setPosition(p.position); setTotal(p.total); }
    else { setPosition(null); setTotal(null); }   // 不在 matched
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

#### 4.6.3 Message + Raw 高亮

Message section：
```tsx
<div className="border rounded p-2 font-mono text-xs whitespace-pre-wrap break-words">
  {entry.message ? <HighlightedText text={entry.message} needle={spec.text_search ?? ''} /> : '(空)'}
</div>
```

Raw section 同理。

### 4.7 不在 matched 时的显示

如果 `position == null && total == null && selectedEntry`：
- ↑/↓ 按钮都 disabled
- 位置文字显示 `已不在筛选结果中`
- entry 本身仍展示（用户能继续看 fields/raw）

## 5. 边界 / 异常

- **首条 prev / 末条 next**：cmd 返 None；button disabled
- **spec 变了 → 当前 entry 不在 matched**：position cmd 返 None；显示提示文字，按钮禁用
- **follow 模式 + matched 增长**：每次点 ↑/↓ 都重新 run_query → position/total 实时反映
- **高亮 needle 包含 regex 特殊字符**：highlightSpans 用 `indexOf` 字符串查找，不当 regex，无需 escape
- **needle 过长**：单元素 hit span 即可，浏览器自然换行
- **高亮命中过多导致 DOM 爆炸**：理论上一行 message 几十字符，命中 spans <10 个，可接受。如果出现性能问题再加上限

## 6. 测试

### 6.1 Rust 单测（`neighbor.rs`，5 个）

见 §3.4。需要 mock SessionState — 复用现有 test helper 模式。

### 6.2 前端单测（`highlight.test.ts`，5 个）

- empty needle → 单元素 hit=false
- no match → 单元素 hit=false
- single match → 三段（前/hit/后）
- multi match → 多段交替
- case-insensitive → `"Foo bar Foo"` + `"foo"` → 2 个 hit

### 6.3 集成

无需新加，build + 现有 vitest 不破即可。

## 7. 文件清单

```
src-tauri/src/
├── query/
│   ├── mod.rs                       (修改：pub mod neighbor)
│   └── neighbor.rs                  (新：neighbor/position fn + 5 测试)
├── commands.rs                      (修改：2 个 tauri cmd)
└── lib.rs                           (修改：注册)

src/
├── types/log.ts                     (修改：3 个 type)
├── api/commands.ts                  (修改：2 个 invoke 封装)
├── lib/
│   └── highlight.ts                 (新：highlightSpans)
├── components/
│   ├── HighlightedText.tsx          (新：mark 渲染组件)
│   ├── LogList.tsx                  (修改：row 用 HighlightedText)
│   └── DetailDrawer.tsx             (修改：头部 ↑↓ + position + Message/Raw 高亮)
└── __tests__/
    └── highlight.test.ts            (新：5 测试)
```

## 8. 验收清单

- [ ] `cargo test` 全绿（含新 5 个 neighbor 测试）
- [ ] `npm test` 全绿（含新 5 个 highlight 测试）
- [ ] 手动跑 `npm run tauri dev`：
  - [ ] 关键词 "auth" + 点击一行 → drawer 打开，头部显示 "第 X / 共 Y 条匹配"
  - [ ] 点 ↓ → entry 切到下一条；position 加 1；row 仍显示原选中（list 不滚动）
  - [ ] 点 ↑ 回退
  - [ ] 末条按 ↓ disabled；首条按 ↑ disabled
  - [ ] 关键词 "Auth"（大写）→ 列表行 message 里 "auth"（小写）也黄底高亮
  - [ ] 关键词为空时 row 不渲染 `<mark>`（直接纯文本）
  - [ ] DetailDrawer Message + Raw 区命中黄底高亮
  - [ ] 改 spec 让当前 entry 不再 matched → drawer 显示 "已不在筛选结果中" + ↑↓ 禁用

## 9. 估算

- 后端 ~3 task（模块 / cmd + 注册 / 测试）
- 前端 ~5 task（types / api / highlight + 测试 / HighlightedText / LogList / DetailDrawer）
- 收尾 ~2 task（全测 + README）
- 合计 ~10 task / 1.5-2 小时
