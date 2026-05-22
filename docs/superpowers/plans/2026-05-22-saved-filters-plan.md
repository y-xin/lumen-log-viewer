# Saved Filters v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给当前文件保存命名的 `levels + scope_filter + text_search` 组合，FilterBar 右侧下拉一键调出 / 管理。

**Architecture:** 后端 `prefs/store.rs` 扩展 `Prefs.saved_filters: HashMap<path, Vec<SavedFilter>>`，4 个 store 方法 + 4 个 Tauri command；前端新增 `SavedFiltersMenu` 组件，嵌入 FilterBar 第一行 `ml-auto` 容器内 ExportMenu 左侧。UUID 由前端 `crypto.randomUUID()` 生成。

**Tech Stack:** 已有 — Rust 端 serde + directories；前端 React + Tauri invoke。无新依赖。

**Spec：** [2026-05-22-saved-filters-design.md](../specs/2026-05-22-saved-filters-design.md)

---

## 文件结构

```
src-tauri/src/
├── prefs/
│   ├── store.rs                 (修改：加 SavedFilter struct + 4 方法 + 4 测试)
│   └── mod.rs                   (修改：导出 SavedFilter)
├── commands.rs                  (修改：加 4 个 tauri cmd)
└── lib.rs                       (修改：invoke_handler 注册 4 个 cmd)

src/
├── types/log.ts                 (修改：加 SavedFilter type)
├── api/commands.ts              (修改：加 4 个 invoke 封装)
├── components/
│   ├── SavedFiltersMenu.tsx     (新：dropdown + 内嵌管理视图)
│   └── FilterBar.tsx            (修改：嵌入到 ml-auto 容器)
```

---

## Phase 1：后端 prefs 扩展

### Task 1.1：SavedFilter struct + Prefs 字段

**Files:** Modify `src-tauri/src/prefs/store.rs`

- [ ] **Step 1：在 `use` 区下方加 `HashMap` 导入**

打开 `src-tauri/src/prefs/store.rs`，把：
```rust
use crate::error::AppError;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
```
改为：
```rust
use crate::error::AppError;
use crate::query::ScopeFilter;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
```

- [ ] **Step 2：定义 SavedFilter struct**

在 `CustomFieldMap` 定义下方，加：

```rust
/// 命名保存的筛选器（按文件路径独立）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedFilter {
    /// 前端 crypto.randomUUID() 生成
    pub id: String,
    pub name: String,
    /// ISO 8601 UTC，用于排序
    pub created_at: String,
    pub levels: Option<Vec<String>>,
    pub scope_filter: Option<ScopeFilter>,
    pub text_search: Option<String>,
}
```

- [ ] **Step 3：Prefs struct 加 saved_filters 字段**

把：
```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Prefs {
    pub version: u32,
    pub custom_templates: Vec<CustomTemplate>,
    /// 最近打开过的文件路径，最新的在前，最多保留 MAX_RECENT_FILES 个。
    /// 不存在/不可访问的路径在 list 时由前端忽略，文件内保留。
    #[serde(default)]
    pub recent_files: Vec<String>,
}
```
改为：
```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Prefs {
    pub version: u32,
    pub custom_templates: Vec<CustomTemplate>,
    /// 最近打开过的文件路径，最新的在前，最多保留 MAX_RECENT_FILES 个。
    /// 不存在/不可访问的路径在 list 时由前端忽略，文件内保留。
    #[serde(default)]
    pub recent_files: Vec<String>,
    /// 命名筛选器：key = 文件绝对路径，value = 该文件下保存的筛选器列表
    #[serde(default)]
    pub saved_filters: HashMap<String, Vec<SavedFilter>>,
}
```

`default_v1` 也加上：
```rust
impl Prefs {
    fn default_v1() -> Self {
        Prefs {
            version: 1,
            custom_templates: vec![],
            recent_files: vec![],
            saved_filters: HashMap::new(),
        }
    }
}
```

- [ ] **Step 4：build 确认无报错**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -5
```

Expected: `Finished`，无错误。可能有 unused import warning（`SavedFilter` 尚未使用），暂时忽略。

- [ ] **Step 5：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/prefs/store.rs
git commit -m "feat(prefs): add SavedFilter struct + saved_filters map on Prefs"
```

---

### Task 1.2：PrefsStore 4 个方法

**Files:** Modify `src-tauri/src/prefs/store.rs`

- [ ] **Step 1：实现 4 个方法**

在 `clear_recent` 方法下方加：

```rust
    /// 列出某文件下的所有保存筛选，按 created_at 倒序（最新在前）
    pub fn list_filters(&self, file_path: &str) -> Vec<SavedFilter> {
        let prefs = self.load();
        let mut v = prefs.saved_filters.get(file_path).cloned().unwrap_or_default();
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        v
    }

    /// 追加保存（id 重复时覆盖原条目），返回更新后排序好的列表
    pub fn save_filter(
        &self,
        file_path: &str,
        filter: SavedFilter,
    ) -> Result<Vec<SavedFilter>, AppError> {
        let mut prefs = self.load();
        let v = prefs.saved_filters.entry(file_path.to_string()).or_default();
        v.retain(|f| f.id != filter.id);
        v.push(filter);
        self.save(&prefs)?;
        Ok(self.list_filters(file_path))
    }

    /// 按 id 删除；找不到 id 不报错（幂等）
    pub fn delete_filter(
        &self,
        file_path: &str,
        id: &str,
    ) -> Result<Vec<SavedFilter>, AppError> {
        let mut prefs = self.load();
        if let Some(v) = prefs.saved_filters.get_mut(file_path) {
            v.retain(|f| f.id != id);
        }
        self.save(&prefs)?;
        Ok(self.list_filters(file_path))
    }

    /// 按 id 重命名；找不到返回 Err
    pub fn rename_filter(
        &self,
        file_path: &str,
        id: &str,
        new_name: &str,
    ) -> Result<Vec<SavedFilter>, AppError> {
        let mut prefs = self.load();
        let v = prefs
            .saved_filters
            .get_mut(file_path)
            .ok_or_else(|| AppError::Internal(format!("文件无任何保存筛选：{file_path}")))?;
        let target = v
            .iter_mut()
            .find(|f| f.id == id)
            .ok_or_else(|| AppError::Internal(format!("找不到 saved filter id={id}")))?;
        target.name = new_name.to_string();
        self.save(&prefs)?;
        Ok(self.list_filters(file_path))
    }
```

- [ ] **Step 2：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -3
```

Expected: `Finished`。

- [ ] **Step 3：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/prefs/store.rs
git commit -m "feat(prefs): list/save/delete/rename SavedFilter methods on PrefsStore"
```

---

### Task 1.3：4 个 store 单元测试

**Files:** Modify `src-tauri/src/prefs/store.rs`

- [ ] **Step 1：在 `mod tests` 末尾加 helper 和 4 个测试**

找到 `#[cfg(test)] mod tests { ... }`。在最后一个测试后、`}` 闭括号前加：

```rust
    use crate::query::{MatchMode, ScopeFilter as QScopeFilter};

    fn sample_filter(id: &str, name: &str, created: &str) -> SavedFilter {
        SavedFilter {
            id: id.into(),
            name: name.into(),
            created_at: created.into(),
            levels: Some(vec!["error".into()]),
            scope_filter: Some(QScopeFilter {
                field_name: "scope".into(),
                pattern: "auth.*".into(),
                mode: MatchMode::Glob,
            }),
            text_search: None,
        }
    }

    #[test]
    fn save_filter_and_list_roundtrip() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        let f = sample_filter("id1", "f1", "2026-05-22T10:00:00Z");
        let updated = store.save_filter("/a.log", f).unwrap();
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].id, "id1");
        let listed = store.list_filters("/a.log");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "f1");
    }

    #[test]
    fn save_filter_two_for_same_path_returns_sorted_desc_by_created_at() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        store
            .save_filter("/a.log", sample_filter("a", "old", "2026-05-22T08:00:00Z"))
            .unwrap();
        let v = store
            .save_filter("/a.log", sample_filter("b", "new", "2026-05-22T10:00:00Z"))
            .unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].id, "b"); // 新的在前
        assert_eq!(v[1].id, "a");
    }

    #[test]
    fn delete_filter_is_idempotent_on_missing_id() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        store
            .save_filter("/a.log", sample_filter("keep", "k", "2026-05-22T10:00:00Z"))
            .unwrap();
        let v = store.delete_filter("/a.log", "doesnotexist").unwrap();
        assert_eq!(v.len(), 1); // 原条目仍在
        let v2 = store.delete_filter("/a.log", "keep").unwrap();
        assert!(v2.is_empty());
    }

    #[test]
    fn rename_filter_errors_when_id_missing() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        store
            .save_filter("/a.log", sample_filter("x", "old", "2026-05-22T10:00:00Z"))
            .unwrap();
        let r = store.rename_filter("/a.log", "wrongid", "newname");
        assert!(matches!(r, Err(AppError::Internal(_))));
        // 原 name 没变
        let v = store.list_filters("/a.log");
        assert_eq!(v[0].name, "old");
    }

    #[test]
    fn filters_on_different_paths_are_isolated() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        store
            .save_filter("/a.log", sample_filter("a", "fa", "2026-05-22T10:00:00Z"))
            .unwrap();
        store
            .save_filter("/b.log", sample_filter("b", "fb", "2026-05-22T10:00:00Z"))
            .unwrap();
        let va = store.list_filters("/a.log");
        let vb = store.list_filters("/b.log");
        assert_eq!(va.len(), 1);
        assert_eq!(vb.len(), 1);
        assert_eq!(va[0].id, "a");
        assert_eq!(vb[0].id, "b");
    }
```

- [ ] **Step 2：run tests**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib prefs:: 2>&1 | tail -10
```

Expected: 5 个新测试全过 + 原有 prefs 测试不破。

- [ ] **Step 3：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/prefs/store.rs
git commit -m "test(prefs): 5 unit tests for SavedFilter store methods"
```

---

### Task 1.4：prefs/mod.rs 导出 SavedFilter

**Files:** Modify `src-tauri/src/prefs/mod.rs`

- [ ] **Step 1：导出 SavedFilter**

打开 `src-tauri/src/prefs/mod.rs`，把：
```rust
pub mod store;

pub use store::{CustomTemplate, PrefsStore};
```
改为：
```rust
pub mod store;

pub use store::{CustomTemplate, PrefsStore, SavedFilter};
```

- [ ] **Step 2：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -3
```

- [ ] **Step 3：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/prefs/mod.rs
git commit -m "feat(prefs): re-export SavedFilter from prefs module"
```

---

## Phase 2：后端 Tauri 命令

### Task 2.1：4 个 tauri command

**Files:** Modify `src-tauri/src/commands.rs`

- [ ] **Step 1：更新 prefs 导入**

打开 `src-tauri/src/commands.rs`，找到：
```rust
use crate::prefs::{CustomTemplate, PrefsStore};
```
改为：
```rust
use crate::prefs::{CustomTemplate, PrefsStore, SavedFilter};
```

- [ ] **Step 2：在文件末尾加 4 个 command**

把以下代码追加到 `commands.rs` 末尾：

```rust
// ─── Saved Filters ───

#[tauri::command]
pub fn cmd_list_saved_filters(
    prefs: State<Arc<PrefsStore>>,
    file_path: String,
) -> Vec<SavedFilter> {
    prefs.list_filters(&file_path)
}

#[tauri::command]
pub fn cmd_save_filter(
    prefs: State<Arc<PrefsStore>>,
    file_path: String,
    filter: SavedFilter,
) -> Result<Vec<SavedFilter>, AppError> {
    prefs.save_filter(&file_path, filter)
}

#[tauri::command]
pub fn cmd_delete_saved_filter(
    prefs: State<Arc<PrefsStore>>,
    file_path: String,
    id: String,
) -> Result<Vec<SavedFilter>, AppError> {
    prefs.delete_filter(&file_path, &id)
}

#[tauri::command]
pub fn cmd_rename_saved_filter(
    prefs: State<Arc<PrefsStore>>,
    file_path: String,
    id: String,
    new_name: String,
) -> Result<Vec<SavedFilter>, AppError> {
    prefs.rename_filter(&file_path, &id, &new_name)
}
```

**注**：`PrefsStore` 的 State 类型与现有 cmd（如 `cmd_save_custom_template`）保持一致 — 用 `State<Arc<PrefsStore>>`。如果现有代码用的是 `State<PrefsStore>`，按已有写法。

验证现有写法：在 `commands.rs` 里 grep `prefs:` 看 `cmd_save_custom_template` 的签名照搬。

- [ ] **Step 3：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -3
```

如果 build 失败：检查 State 包装类型是否匹配 `lib.rs` 里 `manage(prefs_store)` 那行注入的类型。

- [ ] **Step 4：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/commands.rs
git commit -m "feat(cmd): 4 tauri commands for SavedFilter list/save/delete/rename"
```

---

### Task 2.2：注册到 invoke_handler

**Files:** Modify `src-tauri/src/lib.rs`

- [ ] **Step 1：在 invoke_handler 数组末尾加 4 个**

打开 `src-tauri/src/lib.rs`，找到 `invoke_handler` 块（行 34-49 附近），把：

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

改为（在 `cmd_export,` 后追加）：

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
    commands::cmd_list_saved_filters,
    commands::cmd_save_filter,
    commands::cmd_delete_saved_filter,
    commands::cmd_rename_saved_filter,
])
```

- [ ] **Step 2：build + 全 cargo test**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -3
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | grep "test result" | head -10
```

Expected: 全绿，prefs 测试新增 5 条。

- [ ] **Step 3：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/lib.rs
git commit -m "feat(cmd): register 4 SavedFilter commands to invoke_handler"
```

---

## Phase 3：前端类型 + API

### Task 3.1：TS 类型

**Files:** Modify `src/types/log.ts`

- [ ] **Step 1：在 CustomTemplate 后追加 SavedFilter type**

打开 `src/types/log.ts`，找到 `export interface CustomTemplate { ... }` 块结束位置（约 line 93）。在它和 `export interface TestSample` 之间加：

```ts
// ─── Saved Filters ───

export interface SavedFilter {
  id: string;
  name: string;
  created_at: string;             // ISO 8601 UTC
  levels: LogLevel[] | null;
  scope_filter: ScopeFilter | null;
  text_search: string | null;
}
```

- [ ] **Step 2：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 3：commit**

```bash
git add src/types/log.ts
git commit -m "feat(fe): SavedFilter TS type"
```

---

### Task 3.2：API invoke 封装

**Files:** Modify `src/api/commands.ts`

- [ ] **Step 1：扩展 import**

打开 `src/api/commands.ts`，把：

```ts
import type {
  FileMetadata,
  QueryResponse,
  QuerySpec,
  LogEntry,
  TemplateInfo,
  CustomTemplate,
  TestResult,
  ExportFormat,
  ExportResult,
} from '../types/log';
```

改为（追加 `SavedFilter`）：

```ts
import type {
  FileMetadata,
  QueryResponse,
  QuerySpec,
  LogEntry,
  TemplateInfo,
  CustomTemplate,
  TestResult,
  ExportFormat,
  ExportResult,
  SavedFilter,
} from '../types/log';
```

- [ ] **Step 2：在文件末尾追加 4 个 invoke**

```ts

// ─── Saved Filters ───

export async function listSavedFilters(filePath: string): Promise<SavedFilter[]> {
  return invoke<SavedFilter[]>('cmd_list_saved_filters', { filePath });
}

export async function saveFilter(filePath: string, filter: SavedFilter): Promise<SavedFilter[]> {
  return invoke<SavedFilter[]>('cmd_save_filter', { filePath, filter });
}

export async function deleteSavedFilter(filePath: string, id: string): Promise<SavedFilter[]> {
  return invoke<SavedFilter[]>('cmd_delete_saved_filter', { filePath, id });
}

export async function renameSavedFilter(
  filePath: string,
  id: string,
  newName: string,
): Promise<SavedFilter[]> {
  return invoke<SavedFilter[]>('cmd_rename_saved_filter', { filePath, id, newName });
}
```

注：Tauri invoke 参数名是 camelCase；Rust 端用 `file_path: String`，但 tauri 默认会做 snake↔camel 转换。已有的 `cmd_export({ ... path })` 也是这模式。

- [ ] **Step 3：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 4：commit**

```bash
git add src/api/commands.ts
git commit -m "feat(fe): 4 invoke wrappers for SavedFilter API"
```

---

## Phase 4：SavedFiltersMenu 组件

### Task 4.1：组件基础结构（按钮 + 下拉空容器 + 状态）

**Files:** Create `src/components/SavedFiltersMenu.tsx`

- [ ] **Step 1：写组件骨架（按钮 + 数据加载 + 下拉空容器）**

新建 `src/components/SavedFiltersMenu.tsx`：

```tsx
// FilterBar 末尾的"保存筛选"下拉：按文件路径独立管理 SavedFilter
// 应用 saved 时只 patch levels / scope_filter / text_search
// time_range 与 scope_in 保持不变（瞬时探索语义）

import { useEffect, useState } from 'react';
import {
  listSavedFilters,
  saveFilter,
  deleteSavedFilter,
  renameSavedFilter,
} from '../api/commands';
import { useSession } from '../state/session';
import type { SavedFilter } from '../types/log';

type View = 'list' | 'save' | 'manage';

export function SavedFiltersMenu() {
  const { spec, metadata, patchSpec, setError } = useSession();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('list');
  const [filters, setFilters] = useState<SavedFilter[]>([]);

  const path = metadata?.path ?? null;

  // 打开 / 路径变化时刷新
  useEffect(() => {
    if (!open || !path) return;
    listSavedFilters(path).then(setFilters).catch((e) => setError(String(e)));
  }, [open, path, setError]);

  if (!metadata || !path) return null;

  const close = () => { setOpen(false); setView('list'); };

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="ctl" title="保存的筛选器">
        📌 筛选器 ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute top-full right-0 mt-1 w-80 bg-white border rounded shadow-lg z-20 text-xs">
            {/* 视图切换占位，下一步填充 */}
            <div className="px-3 py-2 text-slate-400 italic">(待填充)</div>
          </div>
        </>
      )}
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
git add src/components/SavedFiltersMenu.tsx
git commit -m "feat(fe): SavedFiltersMenu skeleton — button + dropdown shell"
```

---

### Task 4.2：list 视图 + apply / "✓ 当前匹配" 高亮

**Files:** Modify `src/components/SavedFiltersMenu.tsx`

- [ ] **Step 1：加 spec 匹配 helper + list 视图渲染**

在 `import` 区下方（`type View` 上方）加 helper：

```tsx
// 判断当前 spec 三项是否与 saved filter 严格一致（用于 ✓ 高亮）
function specMatches(
  s: { levels?: string[] | null; scope_filter?: object | null; text_search?: string | null },
  f: SavedFilter,
): boolean {
  const norm = <T,>(v: T | null | undefined): T | null => (v == null ? null : v);
  return (
    JSON.stringify(norm(s.levels)?.slice().sort()) ===
      JSON.stringify(norm(f.levels)?.slice().sort()) &&
    JSON.stringify(norm(s.scope_filter)) === JSON.stringify(norm(f.scope_filter)) &&
    norm(s.text_search) === norm(f.text_search)
  );
}
```

- [ ] **Step 2：替换占位 div 为完整 list 视图**

把：
```tsx
<div className="px-3 py-2 text-slate-400 italic">(待填充)</div>
```

替换为：
```tsx
{view === 'list' && (
  <>
    <div className="px-3 py-1.5 text-slate-500 border-b">当前文件的筛选器</div>
    {filters.length === 0 && (
      <div className="px-3 py-3 text-slate-400 italic">(无)</div>
    )}
    {filters.map((f) => {
      const active = specMatches(spec, f);
      return (
        <button
          key={f.id}
          onClick={() => {
            patchSpec({
              levels: f.levels ?? undefined,
              scope_filter: f.scope_filter,
              text_search: f.text_search,
            });
            close();
          }}
          className={[
            'w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2',
            active ? 'bg-blue-50 font-medium text-blue-700' : '',
          ].join(' ')}
        >
          <span className="w-3 inline-block">{active ? '✓' : ''}</span>
          <span className="truncate flex-1">{f.name}</span>
        </button>
      );
    })}
    <div className="border-t">
      <button
        onClick={() => setView('save')}
        className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700"
      >
        + 保存当前筛选...
      </button>
      <button
        onClick={() => setView('manage')}
        className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700"
        disabled={filters.length === 0}
      >
        ⚙ 管理...
      </button>
    </div>
  </>
)}
```

- [ ] **Step 3：build + 验证**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 4：commit**

```bash
git add src/components/SavedFiltersMenu.tsx
git commit -m "feat(fe): SavedFiltersMenu list view — apply + active highlight"
```

---

### Task 4.3：save 视图（输入名字）

**Files:** Modify `src/components/SavedFiltersMenu.tsx`

- [ ] **Step 1：加 save 视图本地态**

在 `useState<SavedFilter[]>([]);` 下方加：

```tsx
const [newName, setNewName] = useState('');
```

- [ ] **Step 2：加 save handler**

在 `close` 函数下方加：

```tsx
const handleSave = async () => {
  if (!newName.trim() || !path) return;
  const filter: SavedFilter = {
    id: crypto.randomUUID(),
    name: newName.trim(),
    created_at: new Date().toISOString(),
    levels: spec.levels ?? null,
    scope_filter: spec.scope_filter ?? null,
    text_search: spec.text_search ?? null,
  };
  try {
    const updated = await saveFilter(path, filter);
    setFilters(updated);
    setNewName('');
    setView('list');
  } catch (e) {
    setError(String(e));
  }
};

const canSave = newName.trim().length > 0 &&
  (spec.levels != null || spec.scope_filter != null || spec.text_search != null);
```

- [ ] **Step 3：在 list 视图块外（紧接 `{view === 'list' && ...}` 后）加 save 视图**

```tsx
{view === 'save' && (
  <div className="p-3 space-y-2">
    <div className="text-slate-500">保存当前筛选为：</div>
    <input
      value={newName}
      onChange={(e) => setNewName(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter' && canSave) handleSave(); }}
      placeholder="筛选器名字"
      autoFocus
      className="input-ctl w-full"
    />
    <div className="flex gap-2">
      <button onClick={handleSave} disabled={!canSave} className="ctl ctl-primary">
        保存
      </button>
      <button onClick={() => { setView('list'); setNewName(''); }} className="ctl ml-auto">
        取消
      </button>
    </div>
    {!canSave && newName.trim() && (
      <div className="text-slate-400 italic">当前 spec 三项都为空，无可保存内容</div>
    )}
  </div>
)}
```

- [ ] **Step 4：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 5：commit**

```bash
git add src/components/SavedFiltersMenu.tsx
git commit -m "feat(fe): SavedFiltersMenu save view — name input + Enter to save"
```

---

### Task 4.4：manage 视图（重命名 + 删除）

**Files:** Modify `src/components/SavedFiltersMenu.tsx`

- [ ] **Step 1：加 manage 视图本地态**

在 `const [newName, setNewName] = useState('');` 下方加：

```tsx
const [editingId, setEditingId] = useState<string | null>(null);
const [editName, setEditName] = useState('');
```

- [ ] **Step 2：加 handlers**

在 `handleSave` 函数下方加：

```tsx
const handleDelete = async (id: string) => {
  if (!path) return;
  if (!confirm('删除这个筛选器？')) return;
  try {
    const updated = await deleteSavedFilter(path, id);
    setFilters(updated);
  } catch (e) {
    setError(String(e));
  }
};

const startRename = (f: SavedFilter) => {
  setEditingId(f.id);
  setEditName(f.name);
};

const commitRename = async () => {
  if (!editingId || !editName.trim() || !path) {
    setEditingId(null);
    return;
  }
  try {
    const updated = await renameSavedFilter(path, editingId, editName.trim());
    setFilters(updated);
  } catch (e) {
    setError(String(e));
  } finally {
    setEditingId(null);
  }
};
```

- [ ] **Step 3：加 manage 视图（紧接 save 视图块后）**

```tsx
{view === 'manage' && (
  <>
    <div className="px-3 py-1.5 text-slate-500 border-b flex items-center">
      <span>管理筛选器</span>
      <button
        onClick={() => { setView('list'); setEditingId(null); }}
        className="ml-auto text-slate-400 hover:text-slate-700"
      >
        ← 返回
      </button>
    </div>
    {filters.map((f) => (
      <div key={f.id} className="px-3 py-1.5 border-b last:border-b-0 flex items-center gap-2">
        {editingId === f.id ? (
          <>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setEditingId(null);
              }}
              autoFocus
              className="input-ctl flex-1"
            />
            <button onClick={commitRename} className="ctl ctl-primary">保存</button>
          </>
        ) : (
          <>
            <span className="truncate flex-1">{f.name}</span>
            <button
              onClick={() => startRename(f)}
              className="text-slate-500 hover:text-slate-800"
              title="重命名"
            >
              ✎
            </button>
            <button
              onClick={() => handleDelete(f.id)}
              className="text-red-500 hover:text-red-700"
              title="删除"
            >
              ✕
            </button>
          </>
        )}
      </div>
    ))}
  </>
)}
```

- [ ] **Step 4：build**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

- [ ] **Step 5：commit**

```bash
git add src/components/SavedFiltersMenu.tsx
git commit -m "feat(fe): SavedFiltersMenu manage view — rename + delete"
```

---

## Phase 5：嵌入 FilterBar

### Task 5.1：嵌入 FilterBar

**Files:** Modify `src/components/FilterBar.tsx`

- [ ] **Step 1：加 import**

打开 `src/components/FilterBar.tsx`，找到：
```tsx
import { ExportMenu } from './ExportMenu';
```
改为：
```tsx
import { ExportMenu } from './ExportMenu';
import { SavedFiltersMenu } from './SavedFiltersMenu';
```

- [ ] **Step 2：把 level 行的 ExportMenu 容器改成两个组件并排**

找到 level 行末尾（约 line 99）：
```tsx
<div className="ml-auto"><ExportMenu /></div>
```

改为：
```tsx
<div className="ml-auto flex items-center gap-2">
  <SavedFiltersMenu />
  <ExportMenu />
</div>
```

- [ ] **Step 3：build + 测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3 && npm test 2>&1 | tail -5
```

Expected: build 通过 + FilterBar.test 仍通过（仅样式/位置变化，role/text 不变）。

- [ ] **Step 4：commit**

```bash
git add src/components/FilterBar.tsx
git commit -m "feat(fe): mount SavedFiltersMenu next to ExportMenu in FilterBar"
```

---

## Phase 6：收尾

### Task 6.1：全测试 + 手动验收

- [ ] **Step 1：全测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | grep "test result" | head -10
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm test 2>&1 | tail -3
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

Expected: 所有 cargo test 全绿（含新增 5 个 SavedFilter store 测试）；vitest 全绿；build 干净。

- [ ] **Step 2：手动验收（用户跑 `npm run tauri dev`）**

清单：
- [ ] FilterBar 第一行右侧出现 `📌 筛选器 ▾` 按钮，紧贴 ExportMenu 左侧
- [ ] 点击 `📌 筛选器 ▾` 展开下拉
- [ ] 当前文件无 saved 时显示 "(无)"
- [ ] 调整 level（如只勾 ERROR） + scope（如 `auth.*`）+ 关键词 → "+ 保存当前筛选..." → 填名字 "test1" → 回车 → 列表里出现
- [ ] 点击 "test1" 应用：spec 三项被恢复；time_range 不变；scope_in 不变
- [ ] 当前 spec 完全匹配 "test1" 时左侧显示 ✓ 蓝色高亮
- [ ] "⚙ 管理..." 进入管理模式：✎ 重命名 / ✕ 删除（带 confirm）
- [ ] 打开另一个文件 → 下拉变空（按路径隔离）
- [ ] 退出应用重开 → "test1" 仍在

---

### Task 6.2：README 更新

**Files:** Modify `README.md`

- [ ] **Step 1：在"核心能力"列表里加一条 + "未实现"里删掉对应行**

打开 `README.md`，在核心能力列表（约 line 8-19）末尾追加：

```markdown
- **保存筛选器**：按文件路径命名保存常用 level/scope/keyword 组合，FilterBar 右侧 📌 菜单一键调出 / 重命名 / 删除
```

在"未实现"段（约 line 46-50），把 `- 保存/复用筛选器` 那行删掉。

- [ ] **Step 2：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add README.md
git commit -m "docs: README — saved filters shipped"
```

---

## 完成判定

- [ ] `cargo test` 全绿（含 5 个新 prefs 测试）
- [ ] `npm test` 全绿
- [ ] `npm run build` 干净
- [ ] 手动验收清单全过
- [ ] 提交按 task 分散

预估：12 个 task / 2-2.5 小时。
