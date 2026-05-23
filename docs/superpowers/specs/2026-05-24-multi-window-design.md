# Multi-Window v1 设计文档

- **日期**：2026-05-24
- **状态**：设计已认可，待生成实现计划
- **前置**：当前已实现 Plan 2b + Export + Style v3 + Saved Filters + Shortcuts + Detail Nav + Overnight，单 SessionState 单例架构
- **作用范围**：把"1 进程 1 文件"扩展为"1 进程 N 窗口 N 文件"，窗口间状态隔离、偏好同步

## 1. 目标

- 用户能同时打开多个日志文件做对比，每个文件占一个独立窗口
- 各窗口的筛选 / 滚动位置 / follow / notify 等会话状态完全隔离，互不影响
- 视觉偏好（主题 / 字号 / accent / highlight）跨窗实时同步（一处修改，所有窗口生效）
- 持久化资产（自定义模板 / saved filters / 最近文件 / 列宽列显隐）共享同一份 prefs.json，跨窗一致
- 同一文件路径被重复"打开"时聚焦到已存在窗口，不开第二份

## 2. 非目标

- 单窗口内多 tab / split-pane（"多窗口为主"已定，未来想加 tab 再单独开 spec）
- 跨窗口同步会话状态（筛选 spec / 选中行 / 滚动位置 — 这些就是要隔离的）
- 跨设备 / 跨实例同步（仍然是单机本地）
- "上次关闭时打开过的所有窗口"启动时自动恢复（v2 再考虑）
- macOS 之外的"留 dock"特殊行为（Win/Linux 关到 0 直接退出）
- 窗口排布管理（平铺 / 层叠 / saved layout — 交给系统窗口管理器）

## 3. 行为规约

### 3.1 打开文件

**所有"打开文件"入口统一走 `open_in_new_window(path)`**，包括：

- OpenFileMenu 的"打开文件…"按钮
- 拖拽落到任何窗口
- 最近文件下拉点击
- ⌘O 快捷键

**行为**：

1. `canonicalize(path)` 规范化绝对路径
2. 查 `SessionStore::path_to_label` 反向索引
3. 命中 → `window.set_focus()`，不创建新窗口
4. 未命中 → `WebviewWindowBuilder` 创建新窗口，label = `win-{uuid v4}`，URL = `/?path={urlencoded path}`
5. 新窗口前端 mounted 后从 URL query 读 path → 调 `cmd_open_file` 加载

### 3.2 第一个空白窗口

App 启动时由 `tauri.conf.json` 声明的默认窗口（label = `main`）出现，显示现有的"未打开文件"占位文案。它和后续手动 spawn 的窗口地位相同 —— 可以关掉，也可以留着当"快速开新文件"入口。

**不做特殊处理**：从空白窗口"打开文件"也走 `open_in_new_window`，检测到不重复就开新窗口，空白窗口仍保留。规则越简单越好（"始终开新窗口"零特例）。

### 3.3 关闭窗口

- 任意窗口 close → `WindowEvent::CloseRequested` → `SessionStore::close(label)` 释放 watcher / entries 内存 / path 索引
- 关到 0 窗口：
  - macOS：app 留在 dock；监听 `RunEvent::Reopen { has_visible_windows: false }` → 调 `open_blank_window` 弹空白窗
  - Win/Linux：直接 `app.exit(0)`

### 3.4 新建空白窗口

- 全局快捷键 ⌘N（macOS）/ Ctrl+N（Win/Linux）→ `open_blank_window`
- macOS dock 点 app icon（无可见窗口时）→ `open_blank_window`

### 3.5 窗口标题

- 有文件：`{filename} — Lumen`（macOS Window menu / Mission Control 可区分）
- 空白：`Lumen`
- 后端在 `cmd_open_file` 完成后调 `window.set_title(...)`

### 3.6 状态分类与同步策略

| 类别 | 例子 | 存储 | 跨窗策略 |
|---|---|---|---|
| 视觉偏好 | theme / fontSize / accent / highlight | prefs.json | **实时同步**：save 后 emit_to_all → 各窗 reapply |
| 持久化资产 | 自定义模板 / saved filters / 最近文件 / 列宽 / 列显隐 | prefs.json | **实时同步**：同上 |
| 会话状态 | 当前文件 metadata / entries / filter spec / 滚动位置 / 选中行 / follow / notify / dialog open | 内存 + zustand | **隔离**：每窗口独立，不广播 |

## 4. 数据模型

### 4.1 `SessionStore`（新增模块 `src-tauri/src/session_store.rs`）

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use dashmap::DashMap;

pub struct SessionStore {
    /// window label → 该窗口持有的 session（每个 session 独立 Mutex，互不阻塞）
    sessions: DashMap<String, Arc<Mutex<SessionState>>>,
    /// canonical path → window label，用于"同路径聚焦"查询
    path_to_label: DashMap<PathBuf, String>,
}

impl SessionStore {
    pub fn new() -> Self;

    /// 打开新 session：插入 sessions + path_to_label
    pub fn open(&self, label: String, state: SessionState);

    /// 关闭 session：drop watcher、释放 entries、清两张表
    pub fn close(&self, label: &str);

    /// 对指定 label 的 session 执行闭包（自动加锁）
    pub fn with<F, R>(&self, label: &str, f: F) -> Result<R>
        where F: FnOnce(&mut SessionState) -> Result<R>;

    /// 查 canonical path 对应的 window label
    pub fn lookup_by_path(&self, path: &Path) -> Option<String>;
}
```

`SessionState` 本身结构不变 —— 只是从"单例 Option"变成"DashMap value"。

### 4.2 `Prefs` 扩展

```rust
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct Prefs {
    pub version: u32,
    pub custom_templates: Vec<CustomTemplate>,
    #[serde(default)] pub recent_files: Vec<String>,
    #[serde(default)] pub saved_filters: HashMap<String, Vec<SavedFilter>>,
    #[serde(default)] pub column_widths: HashMap<String, Vec<u32>>,
    #[serde(default)] pub column_visibility: HashMap<String, Vec<String>>,
    #[serde(default)] pub font_size: Option<u32>,
    /// 新增：UI 偏好（从 localStorage 迁出）
    #[serde(default)] pub ui_prefs: UiPrefs,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct UiPrefs {
    pub theme: String,      // "light" | "dark"
    pub accent: String,     // "blue" | "violet" | "teal" | "rose"
    pub highlight: String,  // "yellow" | "emerald" | "pink" | "sky"
}
```

向后兼容：旧 prefs.json 无 `ui_prefs` 字段 → serde `#[serde(default)]` 给空 UiPrefs（值为 ""），前端读到空字符串时 fallback 到 DEFAULT。

## 5. 后端 cmd 改造

### 5.1 Session-scoped cmd（10 个，签名加 `window: tauri::Window`）

```
cmd_open_file
cmd_query
cmd_get_metadata
cmd_get_page
cmd_reparse_with_template
cmd_start_follow
cmd_stop_follow
cmd_export
cmd_get_neighbor
cmd_get_position
```

改造模式（机械替换）：

```rust
// Before
#[tauri::command]
pub async fn cmd_query(
    state: State<'_, AppState>,
    spec: QuerySpec,
) -> Result<QueryResult, String> {
    let mut s = state.session.lock().unwrap();
    let session = s.as_mut().ok_or("no session")?;
    session.query(spec).map_err(|e| e.to_string())
}

// After
#[tauri::command]
pub async fn cmd_query(
    window: tauri::Window,
    store: State<'_, SessionStore>,
    spec: QuerySpec,
) -> Result<QueryResult, String> {
    store.with(window.label(), |s| s.query(spec)).map_err(|e| e.to_string())
}
```

业务逻辑不变；TS 前端的 `invoke()` 调用不变（Tauri 自动注入 Window）。

### 5.2 新增 cmd

```rust
/// 打开文件（统一入口）：聚焦已有窗口 or 创建新窗口
#[tauri::command]
pub async fn cmd_open_in_new_window(
    app: AppHandle,
    store: State<'_, SessionStore>,
    path: String,
) -> Result<(), String>;

/// 弹空白窗口（⌘N / dock reopen）
#[tauri::command]
pub async fn cmd_open_blank_window(app: AppHandle) -> Result<(), String>;

/// UI 偏好 get/save
#[tauri::command]
pub async fn cmd_get_ui_prefs(prefs: State<'_, PrefsStore>) -> Result<UiPrefs, String>;

#[tauri::command]
pub async fn cmd_save_ui_prefs(
    app: AppHandle,
    prefs: State<'_, PrefsStore>,
    ui_prefs: UiPrefs,
) -> Result<(), String>;
```

### 5.3 Prefs-scoped 写入侧广播

所有写 prefs.json 的 cmd 写完后调用 `app.emit_to_all("lv:prefs-changed", kind)`：

| cmd | 触发 PrefsKind |
|---|---|
| `cmd_save_ui_prefs` | `Ui` |
| `cmd_save_custom_template` / `cmd_delete_custom_template` | `Templates` |
| `cmd_save_filter` / `cmd_delete_saved_filter` / `cmd_rename_saved_filter` | `SavedFilters` |
| `cmd_save_column_widths` / `cmd_save_column_visibility` | `ColumnPrefs` |
| `cmd_save_font_size` | `FontSize` |
| `cmd_open_file`（副作用：追加路径到 recent_files）| `RecentFiles` |

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum PrefsKind {
    Ui,
    Templates,
    SavedFilters,
    RecentFiles,
    ColumnPrefs,
    FontSize,
}
```

### 5.4 主进程生命周期

`lib.rs` 主 Builder 改动：

```rust
tauri::Builder::default()
    .manage(SessionStore::new())
    .manage(PrefsStore::new(...))
    .on_window_event(|window, event| {
        if let WindowEvent::CloseRequested { .. } = event {
            let store: State<SessionStore> = window.state();
            store.close(window.label());
        }
    })
    .invoke_handler(tauri::generate_handler![ /* 加 4 个新 cmd */ ])
    .build(...)?
    .run(|app, event| {
        match event {
            // macOS：关到 0 窗口时 Tauri 会发 ExitRequested → 一律 prevent_exit 留 app 在 dock
            #[cfg(target_os = "macos")]
            RunEvent::ExitRequested { api, .. } => {
                api.prevent_exit();
            }
            // macOS dock 点击（无可见窗口时触发）→ 弹空白窗
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows: false, .. } => {
                let app_handle = app.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_blank_window(app_handle).await;
                });
            }
            _ => {}
        }
    });
```

**macOS Cmd+Q 的处理**：因为统一 `prevent_exit`，原生 ⌘Q 也会被拦下来 → app 不退。为给用户保留真退出路径，在 macOS 上注册原生 menu bar：

- `Lumen` 菜单 → `Quit Lumen (⌘Q)` 菜单项 → 显式调 `app.exit(0)`

这是 Tauri 2 `tauri::menu::MenuBuilder` 标准用法，与 prevent_exit 并存：用户用菜单/Cmd+Q 走 menu handler 真退；非显式触发的 ExitRequested（关最后一个窗口）走 prevent_exit 留 dock。Win/Linux 不需要这套菜单，关到 0 就直接 exit。

## 6. 前端改造

### 6.1 `uiPrefs.ts` 改后端为唯一源

```ts
// 从 invoke 拉，不再 localStorage
export async function loadUiPrefs(): Promise<UiPrefs> {
    const raw = await invoke<UiPrefs>('cmd_get_ui_prefs');
    return {
        theme:     raw.theme || DEFAULT.theme,
        accent:    raw.accent in ACCENT_PALETTE ? raw.accent : DEFAULT.accent,
        highlight: raw.highlight in HIGHLIGHT_PALETTE ? raw.highlight : DEFAULT.highlight,
    };
}
export async function saveUiPrefs(p: UiPrefs): Promise<void> {
    await invoke('cmd_save_ui_prefs', { uiPrefs: p });
    // 不需要主动 applyUiPrefs — emit 广播会回来触发 reapply
}
```

启动序列（`App.tsx`）改成：

1. **同步立即** apply DEFAULT（避免 flash）—— 用硬编码值，0ms
2. **异步** `loadUiPrefs().then(applyUiPrefs)` —— 完成后 reapply 实际值
3. **一次性迁移**：检测到 `localStorage["lv:ui-prefs"]` 且后端值为空 → 把 localStorage 值 saveUiPrefs() → `localStorage.removeItem("lv:ui-prefs")`

### 6.2 `usePrefsSync()` hook（新增）

**只有 zustand-cached 的状态需要主动 refetch**。lazy-load 模式的菜单（SavedFiltersMenu / OpenFileMenu / column-prefs 隐藏菜单）每次打开瞬间都重读 prefs.json，无需订阅。

| PrefsKind | 处理 | 理由 |
|---|---|---|
| `Ui` | `loadUiPrefs().then(applyUiPrefs)` | theme/accent/highlight 是 CSS var，需主动重 inject |
| `Templates` | `useSession.refetchTemplates()` | templates 在 zustand store，需重赋值 |
| `FontSize` | `getFontSize().then(setFontSize)` | fontSize 在 zustand store，需重赋值 |
| `SavedFilters` | 忽略（菜单 lazy-load） | menu 打开时调 `cmd_list_saved_filters` 拉新值 |
| `RecentFiles` | 忽略（菜单 lazy-load） | OpenFileMenu 打开时拉 |
| `ColumnPrefs` | 忽略（按文件路径 keyed） | 跨窗影响同一路径概率低；新窗加载新文件时本来就拉 |

```ts
// src/hooks/usePrefsSync.ts
export function usePrefsSync() {
  useEffect(() => {
    const unlistenP = listen<PrefsKind>('lv:prefs-changed', ({ payload }) => {
      switch (payload) {
        case 'ui':        loadUiPrefs().then(applyUiPrefs); break;
        case 'templates': useSession.getState().refetchTemplates(); break;
        case 'font_size': getFontSize().then(n => useSession.getState().setFontSize(n)); break;
        // SavedFilters / RecentFiles / ColumnPrefs: lazy-load 模式，无需订阅
        default: break;
      }
    });
    return () => { unlistenP.then(f => f()); };
  }, []);
}
```

`App.tsx` 调用：`usePrefsSync();`

### 6.3 URL query 读取初始 path

```tsx
// App.tsx mount 时
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const initialPath = params.get('path');
  if (initialPath) {
    useSession.getState().openFile(initialPath);
  }
}, []);
```

### 6.4 全局 ⌘N / Ctrl+N

`useGlobalShortcuts` 新增：

```ts
if ((e.metaKey || e.ctrlKey) && e.key === 'n' && !e.shiftKey) {
  e.preventDefault();
  invoke('cmd_open_blank_window');
}
```

## 7. 测试

### 7.1 Rust 单元测试

`session_store.rs` (5 个):
- `open` 后 `lookup_by_path` 命中
- `close` 后 `with` 返回错误
- 并发 `with` 不同 label 不阻塞（生成两个 thread，一个持锁 100ms，另一个秒回）
- `lookup_by_path` 对未知路径返回 None
- `close` 清除 `path_to_label` 反向索引

`prefs/store.rs` (2 个新增):
- `get_ui_prefs` / `save_ui_prefs` round-trip
- 旧 prefs.json 无 `ui_prefs` 字段 → 读取后是 Default UiPrefs

### 7.2 Rust 集成测试

`tests/multi_window.rs` (3 个):
- 两个 mock window label 各自 `open_file` 后互相独立 query
- 关闭 window A 不影响 window B 的 follow watcher
- `cmd_open_in_new_window` 对已存在路径返回已有 label（不创建新 session）

### 7.3 前端 vitest

`hooks/usePrefsSync.test.ts`:
- mock `@tauri-apps/api/event::listen` → 触发 payload="ui" → 验证 applyUiPrefs 被调
- mock payload="font_size" → 验证 setFontSize 被调

### 7.4 手动验收清单

- [ ] 启动后开 2 个窗口分别加载 A.log / B.log，各自 filter 互不影响
- [ ] 窗口 A 改字号（⌘= 或设置）→ 窗口 B 立即跟变
- [ ] 窗口 A 改主题为 dark → 窗口 B 立即变 dark
- [ ] 窗口 A 改 accent 为紫 → 窗口 B 选中态 / 蓝条变紫
- [ ] 窗口 A 保存一个 saved filter → 窗口 B 打开 SavedFiltersMenu 能看到（要求 menu 打开时 lazy 重读）
- [ ] 窗口 A follow A.log → B follow B.log，新行各自落到各自窗口
- [ ] 关闭窗口 A → 窗口 B 仍正常 follow（A 的 watcher 已释放）
- [ ] 同一路径再次"打开" → 已有窗口 set_focus，无新窗口
- [ ] macOS 关到 0 窗口 → app 留在 dock → dock 点 icon → 弹空白窗
- [ ] ⌘N → 弹空白窗
- [ ] 拖拽 .log 到任意窗口 → 开新窗口加载（除非同路径）

## 8. 风险与取舍

| 风险 | 评估 | 处理 |
|---|---|---|
| 每窗口 1 个 notify watcher，inode 监听数累计 | 1-3 窗口下无压力；macOS 上限 256 | YAGNI 不限上限 |
| 每窗口一份 entries（内存翻倍） | 用户责任，UI 不阻止；LogList 虚拟滚动让渲染开销可控 | 不做主动限制 |
| 后端 10 个 cmd 集体加 `Window` 参数 | 机械改造一次性 PR | 用 `with(window.label(), \|s\| ...)` 统一模式 |
| 启动时 UI 偏好异步加载导致 flash | DEFAULT 立即 apply + 拉到后 reapply | 用户感知 < 50ms，可接受 |
| localStorage → prefs.json 一次性迁移失败 | 失败时用户感知 = 偏好回到默认 | catch 后静默；下次保存覆盖 |
| Tauri RunEvent::Reopen 在不同平台差异 | macOS 才有；Win/Linux 不触发 | `#[cfg(target_os = "macos")]` 隔离 |
| `WebviewWindowBuilder` URL 拼接 path 含特殊字符 | 走 `encodeURIComponent` 编 / 解 | 前后端都用 URL 标准 API |

## 9. 文档改动

`README.md` 新增"多窗口"章节：

- 每次打开文件都是新窗口
- 同路径文件再打开 → 自动聚焦已有窗口
- ⌘N 新建空白窗口
- 关到 0 窗口 macOS 保留 dock，Win/Linux 退出
- 视觉偏好实时跨窗同步、模板 / saved filters 共享

更新"键盘快捷键"章节列表加 ⌘N。
