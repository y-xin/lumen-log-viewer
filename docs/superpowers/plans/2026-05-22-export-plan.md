# Export 导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能把当前 QuerySpec 下的全部匹配条目导出为 CSV / JSON Lines / JSON Array 三种格式之一到本地文件。

**Architecture:** 后端新增 `src-tauri/src/export.rs` 模块（3 个 streaming 写函数）+ 1 个 Tauri command `cmd_export(spec, format, path)`。前端在 FilterBar 右侧放 `ExportMenu` 下拉，选格式 → tauri `save` dialog 拿路径 → 调 command。

**Tech Stack:** Rust `std::io::BufWriter` + 已有 `serde_json`（不引入新 crate）。前端无新增依赖。

**Spec：** [2026-05-22-export-design.md](../specs/2026-05-22-export-design.md)

---

## 文件结构

```
src-tauri/
├── src/
│   ├── export.rs              (新)
│   ├── commands.rs            (修改：+ ExportFormat / ExportResult / cmd_export)
│   └── lib.rs                 (修改：注册 cmd_export)
└── tests/
    └── integration_export.rs  (新)

src/
├── types/log.ts               (修改：+ ExportFormat / ExportResult)
├── api/commands.ts            (修改：+ exportToFile)
├── components/
│   ├── ExportMenu.tsx         (新)
│   └── FilterBar.tsx          (修改：右侧嵌入 ExportMenu)
```

---

## Phase 1：后端 export 模块

### Task 1.1：CSV 导出函数

**Files:**
- Create: `src-tauri/src/export.rs`

- [ ] **Step 1：写 CSV 实现 + 测试**

新建 `src-tauri/src/export.rs`：

```rust
// 三种导出格式：CSV / JSONL / JSON Array
// 全部 streaming：BufWriter 逐条写，避免大文件内存峰值

use crate::model::LogEntry;
use std::io::{BufWriter, Write};

const CSV_HEADER: &str = "line_no,line_count,timestamp,level,scope,message,fields_json\n";

/// CSV：7 列固定，UTF-8 无 BOM，RFC4180 转义
pub fn export_csv<W: Write>(
    entries: &[LogEntry],
    matched: &[u32],
    w: &mut BufWriter<W>,
) -> std::io::Result<()> {
    w.write_all(CSV_HEADER.as_bytes())?;
    for &idx in matched {
        let Some(e) = entries.get(idx as usize) else { continue; };
        let fields_json = serde_json::to_string(&e.fields).unwrap_or_else(|_| "{}".into());
        let ts = e.timestamp.map(|t| t.to_rfc3339()).unwrap_or_default();
        let level = level_lower(&e.level);
        let scope = e.scope.as_deref().unwrap_or("");
        writeln!(
            w,
            "{},{},{},{},{},{},{}",
            e.line_no,
            e.line_count,
            csv_escape(&ts),
            csv_escape(&level),
            csv_escape(scope),
            csv_escape(&e.message),
            csv_escape(&fields_json),
        )?;
    }
    Ok(())
}

fn level_lower(l: &crate::model::LogLevel) -> String {
    serde_json::to_string(l).unwrap_or_default().trim_matches('"').to_string()
}

/// RFC4180 转义：含 , " \n \r 之一 → 整体加 " 包裹；内部 " → ""
fn csv_escape(s: &str) -> String {
    let needs_quote = s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r');
    if !needs_quote { return s.to_string(); }
    let escaped = s.replace('"', "\"\"");
    format!("\"{}\"", escaped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LogEntry, LogLevel};
    use chrono::{TimeZone, Utc};
    use std::collections::HashMap;
    use std::io::Cursor;

    fn e(line: u32, scope: Option<&str>, message: &str, fields: &[(&str, &str)]) -> LogEntry {
        let mut f = HashMap::new();
        for (k, v) in fields { f.insert(k.to_string(), v.to_string()); }
        LogEntry {
            line_no: line,
            line_count: 1,
            timestamp: Some(Utc.with_ymd_and_hms(2026, 5, 22, 9, 0, 0).unwrap()),
            level: LogLevel::Info,
            scope: scope.map(String::from),
            message: message.into(),
            fields: f,
            raw: String::new(),
        }
    }

    fn export_to_string<F>(write_fn: F) -> String
    where F: FnOnce(&mut BufWriter<Cursor<Vec<u8>>>) -> std::io::Result<()> {
        let mut w = BufWriter::new(Cursor::new(Vec::new()));
        write_fn(&mut w).unwrap();
        w.flush().unwrap();
        let inner = w.into_inner().unwrap().into_inner();
        String::from_utf8(inner).unwrap()
    }

    #[test]
    fn csv_header_only_when_no_matches() {
        let s = export_to_string(|w| export_csv(&[], &[], w));
        assert_eq!(s, CSV_HEADER);
    }

    #[test]
    fn csv_writes_one_row_per_match() {
        let entries = vec![
            e(1, Some("a"), "hello", &[]),
            e(2, Some("b"), "world", &[("k", "v")]),
        ];
        let s = export_to_string(|w| export_csv(&entries, &[0, 1], w));
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[1].starts_with("1,1,2026-05-22T09:00:00+00:00,info,a,hello,"));
        assert!(lines[1].ends_with("{}"));
        assert!(lines[2].contains(",b,world,"));
        assert!(lines[2].contains("\"k\":\"v\""));
    }

    #[test]
    fn csv_escapes_special_chars() {
        // message 含逗号 / 双引号 / 换行
        let entries = vec![
            e(1, Some("scope"), "msg, with \"quote\"\nand newline", &[]),
        ];
        let s = export_to_string(|w| export_csv(&entries, &[0], w));
        // message 整体包引号；内部 " 翻倍为 ""
        assert!(s.contains("\"msg, with \"\"quote\"\"\nand newline\""));
    }

    #[test]
    fn csv_handles_chinese_and_empty_scope() {
        let entries = vec![ e(1, None, "中文消息", &[]) ];
        let s = export_to_string(|w| export_csv(&entries, &[0], w));
        let lines: Vec<&str> = s.lines().collect();
        // scope 空 → 空字段（两个逗号之间）
        assert!(lines[1].contains(",info,,中文消息,"));
    }
}
```

- [ ] **Step 2：在 lib.rs 声明模块**

在 `src-tauri/src/lib.rs` 顶部 module 声明区加：
```rust
pub mod export;
```

- [ ] **Step 3：跑测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib export::
```
Expected: 4 pass。

- [ ] **Step 4：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{export.rs,lib.rs}
git commit -m "feat(export): CSV streaming writer with RFC4180 escape"
```

---

### Task 1.2：JSONL 导出函数

**Files:** Modify `src-tauri/src/export.rs`

- [ ] **Step 1：在 export.rs 加 export_jsonl + 测试**

在 `src-tauri/src/export.rs` 的 `export_csv` 之后（main 代码区，tests 之前）追加：

```rust
/// JSON Lines：每行一个 LogEntry JSON，行尾 \n
pub fn export_jsonl<W: Write>(
    entries: &[LogEntry],
    matched: &[u32],
    w: &mut BufWriter<W>,
) -> std::io::Result<()> {
    for &idx in matched {
        let Some(e) = entries.get(idx as usize) else { continue; };
        let line = serde_json::to_string(e)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        w.write_all(line.as_bytes())?;
        w.write_all(b"\n")?;
    }
    Ok(())
}
```

在 `tests` 模块末尾（最后一个 #[test] 之后，`}` 之前）追加：

```rust
    #[test]
    fn jsonl_empty_matched_is_empty_string() {
        let s = export_to_string(|w| export_jsonl(&[], &[], w));
        assert_eq!(s, "");
    }

    #[test]
    fn jsonl_each_line_roundtrips() {
        let entries = vec![
            e(1, Some("a"), "hi", &[("k", "v")]),
            e(2, Some("b"), "ho", &[]),
        ];
        let s = export_to_string(|w| export_jsonl(&entries, &[0, 1], w));
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines.len(), 2);
        for line in &lines {
            let back: LogEntry = serde_json::from_str(line).unwrap();
            assert!(back.line_no == 1 || back.line_no == 2);
        }
    }
```

- [ ] **Step 2：跑测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib export::
```
Expected: 6 pass。

- [ ] **Step 3：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/export.rs
git commit -m "feat(export): JSON Lines streaming writer"
```

---

### Task 1.3：JSON Array 导出函数

**Files:** Modify `src-tauri/src/export.rs`

- [ ] **Step 1：加 export_json_array + 测试**

在 `export.rs` 的 `export_jsonl` 之后追加：

```rust
/// JSON Array：整文件是一个 JSON 数组（每个元素 pretty 打印）。
/// 空 matched 输出 "[]\n" 以避免 "[\n\n]" 这种丑形态
pub fn export_json_array<W: Write>(
    entries: &[LogEntry],
    matched: &[u32],
    w: &mut BufWriter<W>,
) -> std::io::Result<()> {
    if matched.is_empty() {
        w.write_all(b"[]\n")?;
        return Ok(());
    }
    w.write_all(b"[\n")?;
    let mut first = true;
    for &idx in matched {
        let Some(e) = entries.get(idx as usize) else { continue; };
        if !first {
            w.write_all(b",\n")?;
        }
        first = false;
        let pretty = serde_json::to_string_pretty(e)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        w.write_all(pretty.as_bytes())?;
    }
    w.write_all(b"\n]\n")?;
    Ok(())
}
```

在 `tests` 末尾追加：

```rust
    #[test]
    fn json_array_empty_matched_is_brackets_only() {
        let s = export_to_string(|w| export_json_array(&[], &[], w));
        assert_eq!(s, "[]\n");
    }

    #[test]
    fn json_array_parses_back_to_vec() {
        let entries = vec![
            e(1, Some("a"), "hi", &[("k", "v")]),
            e(2, Some("b"), "ho", &[]),
        ];
        let s = export_to_string(|w| export_json_array(&entries, &[0, 1], w));
        let back: Vec<LogEntry> = serde_json::from_str(&s).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].line_no, 1);
        assert_eq!(back[1].line_no, 2);
    }
```

- [ ] **Step 2：跑测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib export::
```
Expected: 8 pass。

- [ ] **Step 3：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/export.rs
git commit -m "feat(export): JSON Array writer with empty-set special case"
```

---

## Phase 2：Tauri command

### Task 2.1：cmd_export + 集成测试

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/integration_export.rs`

- [ ] **Step 1：commands.rs 加 ExportFormat / ExportResult / cmd_export**

在 `src-tauri/src/commands.rs` 顶部 import 区追加（如果已有部分则跳过）：
```rust
use serde::Deserialize;
use std::io::BufWriter;
```

文件中间合适位置（其他类型定义附近）加：

```rust
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Jsonl,
    JsonArray,
}

#[derive(Serialize)]
pub struct ExportResult {
    pub count: u32,
    pub bytes_written: u64,
}
```

在文件末尾追加：

```rust
#[tauri::command]
pub fn cmd_export(
    spec: QuerySpec,
    format: ExportFormat,
    path: String,
    state: State<'_, SessionState>,
) -> Result<ExportResult, AppError> {
    let matched = query::run_query(&state, &spec)?;
    let file = std::fs::File::create(&path)
        .map_err(|e| AppError::Io(format!("创建导出文件失败：{e}")))?;
    let mut w = BufWriter::new(file);
    state.with_entries(|entries| -> std::io::Result<()> {
        match format {
            ExportFormat::Csv       => crate::export::export_csv(entries, &matched, &mut w),
            ExportFormat::Jsonl     => crate::export::export_jsonl(entries, &matched, &mut w),
            ExportFormat::JsonArray => crate::export::export_json_array(entries, &matched, &mut w),
        }
    })?.map_err(|e| AppError::Io(format!("写入导出文件失败：{e}")))?;
    w.flush().map_err(|e| AppError::Io(format!("flush 失败：{e}")))?;
    let bytes_written = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportResult { count: matched.len() as u32, bytes_written })
}
```

- [ ] **Step 2：lib.rs 注册 command**

打开 `src-tauri/src/lib.rs`，在 `invoke_handler!` 列表末尾添加 `commands::cmd_export,`：

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
    commands::cmd_list_recent_files,
    commands::cmd_clear_recent_files,
    commands::cmd_export,
])
```

- [ ] **Step 3：写集成测试**

新建 `src-tauri/tests/integration_export.rs`：

```rust
// 端到端：跑 fixture → 用 cmd_export 的内部逻辑写文件 → 读回断言

use log_viewer_lib::export;
use log_viewer_lib::loader::reader;
use log_viewer_lib::parser;
use log_viewer_lib::parser::registry::Registry;
use std::io::BufWriter;
use std::path::Path;
use tempfile::tempdir;

#[test]
fn jsonl_roundtrips_full_fixture() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/sample.jsonl")).unwrap();
    let (entries, _) = parser::parse_with_sniff(&Registry::new_with_builtins(), &lines);
    let matched: Vec<u32> = (0..entries.len() as u32).collect();

    let dir = tempdir().unwrap();
    let path = dir.path().join("out.jsonl");
    let file = std::fs::File::create(&path).unwrap();
    let mut w = BufWriter::new(file);
    export::export_jsonl(&entries, &matched, &mut w).unwrap();
    drop(w);

    let body = std::fs::read_to_string(&path).unwrap();
    let line_count = body.lines().count();
    assert_eq!(line_count, entries.len());
}

#[test]
fn csv_has_header_plus_one_row_per_entry() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/sample.jsonl")).unwrap();
    let (entries, _) = parser::parse_with_sniff(&Registry::new_with_builtins(), &lines);
    let matched: Vec<u32> = (0..entries.len() as u32).collect();

    let dir = tempdir().unwrap();
    let path = dir.path().join("out.csv");
    let file = std::fs::File::create(&path).unwrap();
    let mut w = BufWriter::new(file);
    export::export_csv(&entries, &matched, &mut w).unwrap();
    drop(w);

    let body = std::fs::read_to_string(&path).unwrap();
    let line_count = body.lines().count();
    assert_eq!(line_count, entries.len() + 1, "expected 1 header + N data rows");
    assert!(body.starts_with("line_no,line_count,timestamp,level,scope,message,fields_json\n"));
}

#[test]
fn json_array_parses_back_to_vec() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/sample.jsonl")).unwrap();
    let (entries, _) = parser::parse_with_sniff(&Registry::new_with_builtins(), &lines);
    let matched: Vec<u32> = (0..entries.len() as u32).collect();

    let dir = tempdir().unwrap();
    let path = dir.path().join("out.json");
    let file = std::fs::File::create(&path).unwrap();
    let mut w = BufWriter::new(file);
    export::export_json_array(&entries, &matched, &mut w).unwrap();
    drop(w);

    let body = std::fs::read_to_string(&path).unwrap();
    let back: Vec<log_viewer_lib::model::LogEntry> = serde_json::from_str(&body).unwrap();
    assert_eq!(back.len(), entries.len());
}
```

- [ ] **Step 4：跑全部测试 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | tail -10
```
Expected: all green，含新的 3 个 integration_export tests。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{commands.rs,lib.rs} src-tauri/tests/integration_export.rs
git commit -m "feat(commands): cmd_export wiring CSV/JSONL/JSONArray with end-to-end tests"
```

---

## Phase 3：前端

### Task 3.1：TS 类型 + API 封装

**Files:** Modify `src/types/log.ts`, `src/api/commands.ts`

- [ ] **Step 1：types/log.ts 末尾追加**

```ts
// ─── 导出 ───

export type ExportFormat = 'csv' | 'jsonl' | 'json_array';

export interface ExportResult {
  count: number;
  bytes_written: number;
}
```

- [ ] **Step 2：api/commands.ts 加 exportToFile**

在 import 区把新类型加入：
```ts
import type {
  FileMetadata, QueryResponse, QuerySpec, LogEntry,
  TemplateInfo, CustomTemplate, TestResult,
  ExportFormat, ExportResult,
} from '../types/log';
```

在文件末尾加：
```ts
export async function exportToFile(
  spec: QuerySpec,
  format: ExportFormat,
  path: string,
): Promise<ExportResult> {
  return invoke<ExportResult>('cmd_export', {
    spec: serializeSpec(spec),
    format,
    path,
  });
}
```

- [ ] **Step 3：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/types/log.ts src/api/commands.ts
git commit -m "feat(fe): ExportFormat/ExportResult types + exportToFile client"
```

---

### Task 3.2：ExportMenu 组件

**Files:** Create `src/components/ExportMenu.tsx`

- [ ] **Step 1：写组件**

新建 `src/components/ExportMenu.tsx`：

```tsx
// 导出菜单：在 FilterBar 右侧。选格式 → tauri save dialog → 调 cmd_export
// 期间按钮显示 spinner，完成显示一行 inline 提示，3 秒消失。

import { useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { exportToFile } from '../api/commands';
import { useSession } from '../state/session';
import type { ExportFormat } from '../types/log';

interface Option {
  label: string;
  format: ExportFormat;
  ext: string;
}

const OPTIONS: Option[] = [
  { label: 'CSV (.csv)',           format: 'csv',        ext: 'csv'  },
  { label: 'JSON Lines (.jsonl)',  format: 'jsonl',      ext: 'jsonl'},
  { label: 'JSON Array (.json)',   format: 'json_array', ext: 'json' },
];

function defaultName(path: string | undefined, ext: string): string {
  const base = path
    ? path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'export'
    : 'export';
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${base}-export-${ts}.${ext}`;
}

export function ExportMenu() {
  const { spec, metadata, setError } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  if (!metadata) return null;

  const handle = async (opt: Option) => {
    setOpen(false);
    setError(null);
    const target = await save({
      defaultPath: defaultName(metadata.path, opt.ext),
      filters: [{ name: opt.label, extensions: [opt.ext] }],
    });
    if (typeof target !== 'string') return;
    try {
      setBusy(true);
      const r = await exportToFile(spec, opt.format, target);
      setToast(`已导出 ${r.count.toLocaleString()} 条到 ${target.split('/').pop()}`);
      setTimeout(() => setToast(null), 3000);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="px-2 py-0.5 text-xs rounded border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50"
        title="导出当前匹配条目"
      >
        {busy ? '导出中…' : '📥 导出 ▾'}
      </button>
      {open && !busy && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1 w-56 bg-white border rounded shadow-lg z-20 text-xs">
            {OPTIONS.map((opt) => (
              <button
                key={opt.format}
                onClick={() => handle(opt)}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-100"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
      {toast && (
        <div className="absolute top-full right-0 mt-1 px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded text-xs whitespace-nowrap shadow z-20">
          {toast}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/ExportMenu.tsx
git commit -m "feat(fe): ExportMenu dropdown — save dialog + inline toast"
```

---

### Task 3.3：嵌入 FilterBar

**Files:** Modify `src/components/FilterBar.tsx`

- [ ] **Step 1：在 FilterBar 顶部 import 加**

```tsx
import { ExportMenu } from './ExportMenu';
```

- [ ] **Step 2：把 ExportMenu 放在级别 toggle 行右对齐**

`src/components/FilterBar.tsx` 里的 "级别" 行：

```tsx
<div className="flex items-center gap-2 text-sm">
  <span className="text-slate-500">级别：</span>
  {LEVELS.map((lv) => (
    <button ...>{lv}</button>
  ))}
</div>
```

改为：

```tsx
<div className="flex items-center gap-2 text-sm">
  <span className="text-slate-500">级别：</span>
  {LEVELS.map((lv) => (
    <button ...>{lv}</button>
  ))}
  <div className="ml-auto"><ExportMenu /></div>
</div>
```

（保留原 button 渲染不变，只在末尾追加 `<div className="ml-auto">`）

- [ ] **Step 3：build + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/components/FilterBar.tsx
git commit -m "feat(fe): mount ExportMenu at end of FilterBar level row"
```

---

## Phase 4：收尾

### Task 4.1：全测试 + 手动验收

- [ ] **Step 1：Rust + 前端全测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | grep "test result" | head -5
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm test 2>&1 | tail -3
```

Expected: 全绿。Rust 新增 8 lib + 3 integration_export tests。

- [ ] **Step 2：手动验收（用户跑 `npm run tauri dev`）**

清单：
- [ ] 打开 main.log → FilterBar 级别行末尾出现 `📥 导出 ▾` 按钮
- [ ] 点击 → 弹下拉 3 个选项（CSV / JSON Lines / JSON Array）
- [ ] 选 CSV → 弹保存对话框（默认文件名带时间戳）→ 选路径
- [ ] 按钮变 `导出中…` → 完成后下方出现绿色 toast `已导出 N 条到 xxx.csv`，3 秒消失
- [ ] 用 Excel 或 `head out.csv` 看：第一行是表头 7 列，后续行数据正确，中文不乱码
- [ ] 同样测 JSONL 和 JSON Array
- [ ] 应用筛选（如只选 ERROR）→ 再次导出 → 文件只含 ERROR 条目
- [ ] 选不可写路径 → 顶部错误横幅显示 "创建导出文件失败：..."

---

### Task 4.2：README 更新

**Files:** Modify `README.md`

- [ ] **Step 1：在 README 已实现列表里加导出条目**

打开 `README.md`。在 "核心能力" 列表里加一行（合适位置）：

```markdown
- **导出筛选结果**：CSV / JSON Lines / JSON Array 三种格式，从 FilterBar 右侧 📥 菜单触发，保存对话框选路径
```

在 "未实现" 列表里**删除** "导出 CSV / JSON" 一行（如果存在）。

- [ ] **Step 2：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add README.md
git commit -m "docs: README — export feature shipped"
```

---

## 完成判定

- [ ] `cargo test` 全绿（≈ 102 lib + 9 integration）
- [ ] `npm test` 全绿
- [ ] 手动验收清单全过
- [ ] 提交按 task 分散

预估：10 个 task，~1.5-2 小时。
