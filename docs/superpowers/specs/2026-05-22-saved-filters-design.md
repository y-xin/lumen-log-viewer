# Saved Filters v1 设计文档

- **日期**：2026-05-22
- **状态**：设计已认可，待生成实现计划
- **前置**：当前 UI/后端已实现 Style v3 + Export + Plan 2b
- **作用范围**：按文件路径独立的命名筛选器

## 1. 目标

用户能给当前文件保存常用的 `level + scope_filter + text_search` 组合，命名后从 FilterBar 下拉一键调出。降低反复手工配置筛选的成本。

## 2. 非目标

- 全局共享 / 跨文件复用筛选器
- 按解析模板关联筛选器
- 自动应用（如 "default filter"）
- 拖动排序 / 收藏置顶
- 导出 / 导入筛选器 JSON
- "同名检测 / spec hash 重复警告"
- 保存 `time_range`（每次手动调整）
- 保存 `scope_in`（multi-select tags，跟"瞬时探索"语义更近）

## 3. 数据模型

### 3.1 后端 `prefs/store.rs` 新增

```rust
use std::collections::HashMap;

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct Prefs {
    pub version: u32,
    pub custom_templates: Vec<CustomTemplate>,
    #[serde(default)]
    pub recent_files: Vec<String>,
    /// key = 文件绝对路径；value = 该文件下的筛选器列表
    #[serde(default)]
    pub saved_filters: HashMap<String, Vec<SavedFilter>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedFilter {
    /// 用 UUID v4（不依赖时间，避免快速保存碰撞）
    pub id: String,
    pub name: String,
    /// ISO 8601 UTC，用于排序 / 显示
    pub created_at: String,
    pub levels: Option<Vec<String>>,
    pub scope_filter: Option<ScopeFilter>,
    pub text_search: Option<String>,
}
```

`ScopeFilter` 直接复用 `query::ScopeFilter`（已有）。

### 3.2 持久化文件结构示例

```json
{
  "version": 1,
  "custom_templates": [...],
  "recent_files": [...],
  "saved_filters": {
    "/Users/me/logs/renderer.log": [
      {
        "id": "ab12...",
        "name": "只看 auth ERROR",
        "created_at": "2026-05-22T08:30:00Z",
        "levels": ["error"],
        "scope_filter": {"field_name": "scope", "pattern": "auth.*", "mode": "glob"},
        "text_search": null
      }
    ]
  }
}
```

### 3.3 前端 `types/log.ts` 同步

```ts
export interface SavedFilter {
  id: string;
  name: string;
  created_at: string;            // ISO
  levels: LogLevel[] | null;
  scope_filter: ScopeFilter | null;
  text_search: string | null;
}
```

## 4. 后端 API

### 4.1 `prefs/store.rs` 新增方法

```rust
impl PrefsStore {
    pub fn list_filters(&self, file_path: &str) -> Vec<SavedFilter>;
    pub fn save_filter(&self, file_path: &str, filter: SavedFilter) -> Result<Vec<SavedFilter>, AppError>;
    pub fn delete_filter(&self, file_path: &str, id: &str) -> Result<Vec<SavedFilter>, AppError>;
    pub fn rename_filter(&self, file_path: &str, id: &str, new_name: &str) -> Result<Vec<SavedFilter>, AppError>;
}
```

行为细节：
- `list_filters`：路径不存在返回空 Vec；返回顺序按 `created_at` 倒序（最新在前）
- `save_filter`：把 filter 追加到对应 path 的 Vec 末尾；返回更新后的完整列表（已按 created_at 倒序）
- `delete_filter`：按 id 移除；返回更新后列表；找不到 id 不报错（幂等）
- `rename_filter`：按 id 修改 name；返回更新后列表；找不到 id 返回 `AppError::Internal`

### 4.2 Tauri 命令 `commands.rs`

```rust
#[tauri::command]
fn cmd_list_saved_filters(state: State<AppState>, file_path: String) -> Vec<SavedFilter>;

#[tauri::command]
fn cmd_save_filter(state: State<AppState>, file_path: String, filter: SavedFilter) -> Result<Vec<SavedFilter>, AppError>;

#[tauri::command]
fn cmd_delete_saved_filter(state: State<AppState>, file_path: String, id: String) -> Result<Vec<SavedFilter>, AppError>;

#[tauri::command]
fn cmd_rename_saved_filter(state: State<AppState>, file_path: String, id: String, new_name: String) -> Result<Vec<SavedFilter>, AppError>;
```

注：UUID 在**前端生成**（用 `crypto.randomUUID()`），后端不分配 id。

## 5. 前端

### 5.1 `api/commands.ts`

四个 invoke 封装：

```ts
export function listSavedFilters(filePath: string): Promise<SavedFilter[]>;
export function saveFilter(filePath: string, filter: SavedFilter): Promise<SavedFilter[]>;
export function deleteSavedFilter(filePath: string, id: string): Promise<SavedFilter[]>;
export function renameSavedFilter(filePath: string, id: string, newName: string): Promise<SavedFilter[]>;
```

### 5.2 新组件 `components/SavedFiltersMenu.tsx`

UI 结构：

```
[📌 筛选器 ▾]          ← .ctl 按钮
─────────────────
当前文件的筛选器（按 created_at 倒序）
  ✓ 只看 auth ERROR    [×]   ← ✓ 表示当前 spec 匹配该 saved
    无 scope · 关键词
  Top scope spike      [×]
─────────────────
+ 保存当前筛选...        ← 弹 inline 输入框，回车确认
⚙ 管理...               ← 进入子对话框（重命名 / 删除）
```

**应用 filter 时**：调用 `patchSpec({ levels, scope_filter, text_search })`。**不动** `time_range` 和 `scope_in`（保留用户当前的探索状态）。

**保存当前筛选**：从 `spec` 取 `levels / scope_filter / text_search`，前端生成 UUID，调 `saveFilter`。如果当前三项都为空（即"无筛选"），保存按钮 disabled。

**✓ 高亮当前应用**：用三元组 `(levels, scope_filter, text_search)` 比较；匹配则在 saved 旁显示 ✓ 标记。比较时把 `null` / 空数组归一化。

### 5.3 管理对话框 `SavedFilterManagerDialog.tsx`（可在 SavedFiltersMenu 内嵌实现，避免新文件爆炸）

弹窗列出所有 saved，每一条提供：
- 重命名（inline edit + 保存按钮）
- 删除（带 confirm）

为了减少代码量和文件数，**这个管理界面直接嵌在 SavedFiltersMenu 内**，作为下拉的"管理模式"，点 "⚙ 管理..." 切换到管理视图，再点关闭回到普通视图。**不**新建独立 Dialog 组件。

### 5.4 嵌入 `FilterBar.tsx`

在 level toggle 行，ExportMenu **左边**插入 `<SavedFiltersMenu />`：

```tsx
<div className="ml-auto flex items-center gap-2">
  <SavedFiltersMenu />
  <ExportMenu />
</div>
```

仅 `metadata` 存在时整组显示（已有的 metadata 守卫覆盖）。

## 6. 边界与异常

- **重名**：允许同名保存（id 是唯一 key，不依赖 name）。UI 不主动警告。
- **文件路径变化（rename / move）**：旧 key 下的 filter 留在 prefs.json 里"孤儿数据"。MVP 不做 GC；用户可在管理界面手工删除。
- **prefs.json 损坏**：沿用现有逻辑（备份为 `prefs.json.bak.{ts}` + 重置默认）。`saved_filters` 一并清空。
- **删除/重命名后竞态**：所有写操作都 `load -> mutate -> save`，多次写不会丢；前端拿到的列表是 server-side truth。
- **UUID 冲突**：忽略；`crypto.randomUUID()` v4 碰撞概率可忽略。

## 7. 测试

### 7.1 Rust 单元测试（`prefs/store.rs`）

- `save_filter` + `list_filters` round-trip
- `save_filter` 两次同 path → 列表长度 = 2
- `delete_filter` 不存在 id → 不报错且列表不变
- `rename_filter` 不存在 id → 返回 Err
- 不同 path 的 filter 互不影响

### 7.2 集成测试（`tests/`，可选）

- 复用现有的 `Prefs` 序列化 round-trip 测试，验证含 `saved_filters` 时仍可读旧版（向后兼容）

### 7.3 前端 vitest

不强制。`SavedFiltersMenu` 的核心逻辑是 invoke 透传 + spec 比较 helper；可加一个 spec 匹配 helper 的单测。

## 8. 文件清单

```
src-tauri/src/
├── prefs/store.rs                       (修改：加 SavedFilter + 4 方法 + 4 测试)
├── commands.rs                          (修改：4 个 tauri cmd + 注册到 invoke_handler)

src/
├── types/log.ts                         (修改：加 SavedFilter)
├── api/commands.ts                      (修改：加 4 个 invoke 封装)
├── components/
│   ├── SavedFiltersMenu.tsx             (新：按钮 + 下拉 + 内嵌管理视图)
│   └── FilterBar.tsx                    (修改：嵌入 SavedFiltersMenu，与 ExportMenu 共享 ml-auto 容器)
```

## 9. 验收清单

- [ ] `cargo test` 全绿（含新增 4 个 SavedFilter 测试）
- [ ] `npm test` + `npm run build` 全绿
- [ ] 手动跑 `npm run tauri dev`：
  - [ ] 顶部 FilterBar 右侧出现 `📌 筛选器 ▾` 按钮
  - [ ] 点击展开下拉；当前文件下无 saved 时显示 "(无)"
  - [ ] 调整 level / scope / 关键词 → 点击 "保存当前筛选..." → 填名字 → 列表里出现
  - [ ] 点击某条 saved → spec 三项被应用（level/scope/keyword）；time_range/scope_in 保持不变
  - [ ] 当前 spec 完全匹配某条 saved 时，显示 ✓ 标记
  - [ ] 管理模式：能重命名、能删除
  - [ ] 切换不同文件时下拉内容也变（按文件路径隔离）
  - [ ] 关闭重开应用：saved 仍在

## 10. 估算

- 后端：~4 task（store 加方法 / cmd / 测试 / 注册）
- 前端：~5 task（types / api / component / 嵌入 / 验收）
- 合计 ~9 task / 1.5-2 小时
