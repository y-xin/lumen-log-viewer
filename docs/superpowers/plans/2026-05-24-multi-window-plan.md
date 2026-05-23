# Multi-Window v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Lumen 从"1 进程 1 文件"升级为"1 进程 N 窗口 N 文件"，窗口间会话状态隔离 / UI 偏好跨窗实时同步 / 同路径自动聚焦。

**Architecture:** 后端引入 `SessionStore`（`DashMap<window_label, Arc<SessionState>>` + `path_to_label` 反向索引），10 个 session-scoped cmd 加 `tauri::Window` 参数，4 个新 cmd（`open_in_new_window` / `open_blank_window` / `get_ui_prefs` / `save_ui_prefs`）。Prefs.json 加 `ui_prefs` 字段（从 localStorage 迁出）；写 prefs 后 `emit_to_all("lv:prefs-changed", PrefsKind)`，前端 `usePrefsSync` 订阅。macOS 上 `RunEvent::ExitRequested` → `prevent_exit` 留 dock，加原生 menu bar Quit 项走 `app.exit(0)`。

**Tech Stack:** 已有 — Rust（Tauri 2.x + serde + parking_lot）+ React + zustand + Tauri invoke / event API。新增 `dashmap = "6"`（per-session 并发锁）。

**Spec：** [2026-05-24-multi-window-design.md](../specs/2026-05-24-multi-window-design.md)

**Spec → Plan 偏差说明：**

1. spec §4.1 写 `SessionStore::with<F, R>(label, f)` 闭包加锁模式；实现简化为 `get(label) -> Arc<SessionState>`，因为现有 `SessionState` 内部已用 `parking_lot::RwLock` 保护，Arc 共享即可，cmd 写法更直接。
2. spec §5.3 定义了 `enum PrefsKind { Ui, Templates, ... }`；实现简化为 `app.emit("lv:prefs-changed", "ui")` 直接 emit snake_case string 字面量，等价于 enum 的 serde serialize 结果。少一处 enum 维护。前端 `type PrefsKind = 'ui' | 'templates' | ...` 联合类型保持类型安全。

---

## 文件结构

```
src-tauri/
├── Cargo.toml                        (修改：加 dashmap = "6")
├── src/
│   ├── session_store.rs              (新：DashMap<label, Arc<SessionState>> + path 反向索引 + 5 单元测试)
│   ├── session/mod.rs                (修改：导出 SessionStore)
│   ├── prefs/store.rs                (修改：Prefs 加 ui_prefs + UiPrefs + 2 测试)
│   ├── prefs/mod.rs                  (修改：导出 UiPrefs)
│   ├── commands.rs                   (修改：10 cmd 加 Window 参数 / 4 个新 cmd / 6 处 emit 广播)
│   └── lib.rs                        (修改：manage(SessionStore) / RunEvent / WindowEvent / macOS Menu)
└── tests/
    └── multi_window.rs               (新：3 个集成测试)

src/
├── api/
│   ├── window.ts                     (新：openInNewWindow / openBlankWindow invoke 封装)
│   └── commands.ts                   (修改：加 getUiPrefs / saveUiPrefs invoke 封装)
├── hooks/
│   ├── usePrefsSync.ts               (新：监听 lv:prefs-changed 触发 refetch)
│   ├── useFileDrop.ts                (修改：拖拽走 openInNewWindow)
│   └── useGlobalShortcuts.ts         (修改：加 ⌘N / ⌘O 走 openInNewWindow)
├── lib/uiPrefs.ts                    (修改：load/save 改 invoke + 加 migrate fn)
├── components/
│   ├── OpenFileMenu.tsx              (修改：打开 / 最近文件走 openInNewWindow)
│   └── ShortcutsHelp.tsx             (修改：加 ⌘N 项)
└── App.tsx                           (修改：usePrefsSync + URL ?path= + localStorage migration)

README.md                             (修改：加多窗口章节 + ⌘N)
```

---

## Phase 1：后端基础（SessionStore + Prefs.ui_prefs）

### Task 1.1：加 dashmap 依赖

**Files:** Modify `src-tauri/Cargo.toml`

- [ ] **Step 1: 加 dashmap 到 dependencies**

在 `[dependencies]` 节末尾加：

```toml
dashmap = "6"
```

- [ ] **Step 2: 编译验证依赖拉取成功**

```bash
cd src-tauri && cargo build 2>&1 | tail -5
```

期望：`Compiling dashmap v6.x.x` 出现后无报错；现有 lib 仍能 build。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build(deps): add dashmap 6 for per-window session storage"
```

---

### Task 1.2：SessionStore 模块 + 单元测试

**Files:**
- Create: `src-tauri/src/session_store.rs`
- Modify: `src-tauri/src/session/mod.rs`
- Modify: `src-tauri/src/lib.rs`（加 `pub mod session_store;`）

- [ ] **Step 1: 写失败测试**

新建 `src-tauri/src/session_store.rs`，先写 5 个测试和模块骨架：

```rust
// SessionStore：per-window 的 SessionState 容器 + path 反向索引
// 用 DashMap 让不同窗口的操作互不阻塞（不像单一全局 Mutex 会串行）

use crate::session::SessionState;
use dashmap::DashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Default)]
pub struct SessionStore {
    sessions: DashMap<String, Arc<SessionState>>,
    path_to_label: DashMap<PathBuf, String>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取或新建该 label 的 session（不存在就 default）
    pub fn get_or_create(&self, label: &str) -> Arc<SessionState> {
        self.sessions
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(SessionState::default()))
            .clone()
    }

    /// 取已存在的 session；不存在返回 None
    pub fn get(&self, label: &str) -> Option<Arc<SessionState>> {
        self.sessions.get(label).map(|r| r.clone())
    }

    /// 关闭窗口：drop session（watcher 自动释放）+ 清反向索引
    pub fn close(&self, label: &str) {
        if let Some((_, _session)) = self.sessions.remove(label) {
            self.path_to_label.retain(|_, v| v != label);
        }
    }

    /// 给 path 登记一个 label（cmd_open_file 成功后调）
    pub fn register_path(&self, path: PathBuf, label: String) {
        self.path_to_label.insert(path, label);
    }

    /// 反查：哪个 label 在看这个 path
    pub fn lookup_by_path(&self, path: &Path) -> Option<String> {
        self.path_to_label.get(path).map(|r| r.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_then_lookup_hits() {
        let store = SessionStore::new();
        let _s = store.get_or_create("win-1");
        store.register_path(PathBuf::from("/var/log/a.log"), "win-1".into());
        assert_eq!(store.lookup_by_path(Path::new("/var/log/a.log")), Some("win-1".into()));
    }

    #[test]
    fn lookup_unknown_returns_none() {
        let store = SessionStore::new();
        assert_eq!(store.lookup_by_path(Path::new("/var/log/nope.log")), None);
    }

    #[test]
    fn close_drops_session_and_path_index() {
        let store = SessionStore::new();
        let _s = store.get_or_create("win-1");
        store.register_path(PathBuf::from("/var/log/a.log"), "win-1".into());
        store.close("win-1");
        assert!(store.get("win-1").is_none());
        assert_eq!(store.lookup_by_path(Path::new("/var/log/a.log")), None);
    }

    #[test]
    fn get_after_close_returns_none() {
        let store = SessionStore::new();
        let _s = store.get_or_create("win-1");
        store.close("win-1");
        assert!(store.get("win-1").is_none());
    }

    #[test]
    fn concurrent_get_different_labels_does_not_block() {
        use std::sync::Arc;
        use std::thread;
        use std::time::{Duration, Instant};

        let store = Arc::new(SessionStore::new());
        let _a = store.get_or_create("win-a");
        let _b = store.get_or_create("win-b");

        // 线程 A 拿 win-a 的 SessionState 锁 100ms
        let store_a = store.clone();
        let h1 = thread::spawn(move || {
            let session = store_a.get("win-a").unwrap();
            let _meta = session.metadata(); // 触发内部 RwLock read，立刻释放
            thread::sleep(Duration::from_millis(100));
        });

        // 线程 B 操作 win-b — 应该立即完成（< 50ms）
        thread::sleep(Duration::from_millis(10));
        let started = Instant::now();
        let session_b = store.get("win-b").unwrap();
        let _ = session_b.metadata();
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_millis(50),
            "win-b operation blocked: {:?}", elapsed);

        h1.join().unwrap();
    }
}
```

- [ ] **Step 2: 注册模块**

`src-tauri/src/lib.rs` 在现有 `pub mod` 列表加：

```rust
pub mod session_store;
```

- [ ] **Step 3: 跑测试验证失败**

```bash
cd src-tauri && cargo test --lib session_store:: 2>&1 | tail -20
```

期望：5 个测试都 PASS（实现已写）。如果有失败，按错误修。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/session_store.rs src-tauri/src/lib.rs
git commit -m "feat(backend): add SessionStore (per-window session + path index)"
```

---

### Task 1.3：Prefs 加 ui_prefs 字段 + 测试

**Files:** Modify `src-tauri/src/prefs/store.rs`, `src-tauri/src/prefs/mod.rs`

- [ ] **Step 1: 加 UiPrefs struct**

`src-tauri/src/prefs/store.rs` 找到 `pub struct Prefs { ... }` 定义处，新增 UiPrefs struct（放在 Prefs 定义上方）：

```rust
/// UI 视觉偏好（从前端 localStorage 迁出，跨窗实时同步）
/// 空字符串表示"未设置" — 前端会 fallback 到 DEFAULT
#[derive(Default, Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UiPrefs {
    #[serde(default)]
    pub theme: String,      // "" | "light" | "dark"
    #[serde(default)]
    pub accent: String,     // "" | "blue" | "violet" | "teal" | "rose"
    #[serde(default)]
    pub highlight: String,  // "" | "yellow" | "emerald" | "pink" | "sky"
}
```

在 Prefs 定义里加字段：

```rust
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct Prefs {
    // ... 现有字段 ...
    #[serde(default)]
    pub ui_prefs: UiPrefs,
}
```

- [ ] **Step 2: 加 PrefsStore 两个方法**

在 `impl PrefsStore` 块内加：

```rust
pub fn get_ui_prefs(&self) -> UiPrefs {
    self.load().ui_prefs
}

pub fn save_ui_prefs(&self, ui_prefs: UiPrefs) -> Result<(), AppError> {
    let mut prefs = self.load();
    prefs.ui_prefs = ui_prefs;
    self.save(&prefs)
}
```

- [ ] **Step 3: 加 2 个单元测试**

在 `src-tauri/src/prefs/store.rs` 末尾 `#[cfg(test)] mod tests` 内追加：

```rust
#[test]
fn ui_prefs_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let store = PrefsStore::new_at(tmp.path().to_path_buf());
    let p = UiPrefs {
        theme: "dark".into(),
        accent: "violet".into(),
        highlight: "emerald".into(),
    };
    store.save_ui_prefs(p.clone()).unwrap();
    assert_eq!(store.get_ui_prefs(), p);
}

#[test]
fn legacy_prefs_without_ui_prefs_deserializes_to_default() {
    // 模拟旧版 prefs.json（无 ui_prefs 字段）
    let tmp = tempfile::tempdir().unwrap();
    let legacy_json = r#"{"version":1,"custom_templates":[],"recent_files":[]}"#;
    std::fs::write(tmp.path().join("prefs.json"), legacy_json).unwrap();
    let store = PrefsStore::new_at(tmp.path().to_path_buf());
    assert_eq!(store.get_ui_prefs(), UiPrefs::default());
}
```

注：构造 PrefsStore 的写法以现有测试为准。先跑：

```bash
grep -n "PrefsStore" src-tauri/src/prefs/store.rs | head -20
```

定位现有 `#[test]` 块里 PrefsStore 的实例化代码（可能是 `PrefsStore::new_at(path)` 也可能是直接构造 struct），照搬到上面两个新测试。

- [ ] **Step 4: `prefs/mod.rs` 导出 UiPrefs**

```rust
pub use store::{CustomTemplate, Prefs, PrefsStore, SavedFilter, UiPrefs};
```

（看现有 mod.rs 用 re-export 模式照搬；列出已有的 + 加 UiPrefs）

- [ ] **Step 5: 跑测试**

```bash
cd src-tauri && cargo test --lib prefs:: 2>&1 | tail -20
```

期望：新增 2 个测试 PASS，现有测试全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/prefs/store.rs src-tauri/src/prefs/mod.rs
git commit -m "feat(prefs): add ui_prefs field (theme/accent/highlight) + get/save"
```

---

## Phase 2：Tauri cmd 迁移到 per-window

### Task 2.1：lib.rs `manage(SessionStore)` 取代单 SessionState

**Files:** Modify `src-tauri/src/lib.rs`

- [ ] **Step 1: 改 manage 调用**

在 `tauri::Builder::default()` 链上：

```rust
// 删
.manage(SessionState::default())
// 加
.manage(session_store::SessionStore::new())
```

并把顶部 `use session::SessionState;` 删掉（如不再用），加：

```rust
use session_store::SessionStore;
```

- [ ] **Step 2: 编译验证（会失败 — cmd 还在用 SessionState）**

```bash
cd src-tauri && cargo build 2>&1 | tail -30
```

期望：大量 "no method named ... on State<'_, SessionState>" 错误。**这是 Task 2.2 要修的**。**不 commit**，先做下一个 task。

---

### Task 2.2：10 个 session-scoped cmd 加 Window 参数

**Files:** Modify `src-tauri/src/commands.rs`

机械改造每个 session-scoped cmd：签名加 `window: tauri::Window`、`state: State<'_, SessionState>` 改为 `store: State<'_, SessionStore>`、内部 `state.xxx()` 改为 `store.get(window.label()).ok_or(AppError::NoSession)?.xxx()`。

Cmd 清单（10 个）：
`cmd_open_file` / `cmd_query` / `cmd_get_metadata` / `cmd_get_page` / `cmd_reparse_with_template` / `cmd_start_follow` / `cmd_stop_follow` / `cmd_export` / `cmd_get_neighbor` / `cmd_get_position`

- [ ] **Step 1: 改造 cmd_get_metadata（最简单的 — 模板）**

`src-tauri/src/commands.rs` 找到：

```rust
#[tauri::command]
pub fn cmd_get_metadata(state: State<'_, SessionState>) -> Result<FileMetadata, AppError> {
    state.metadata()
}
```

改为：

```rust
#[tauri::command]
pub fn cmd_get_metadata(
    window: tauri::Window,
    store: State<'_, SessionStore>,
) -> Result<FileMetadata, AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    session.metadata()
}
```

`use` 段加：

```rust
use crate::session_store::SessionStore;
```

（保留 `use crate::session::SessionState;` — cmd_open_file 仍要构造 SessionState）

- [ ] **Step 2: 改造 cmd_open_file（创建 session + 注册 path）**

找到 `cmd_open_file`，改为：

```rust
#[tauri::command]
pub fn cmd_open_file(
    window: tauri::Window,
    path: String,
    store: State<'_, SessionStore>,
    registry: State<'_, Registry>,
    prefs_store: State<'_, PrefsStore>,
    app: tauri::AppHandle,
) -> Result<FileMetadata, AppError> {
    let lines = reader::read_all_lines(Path::new(&path))?;
    let (entries, template_id, sniff_kind) = parser::parse_with_sniff(&registry, &lines);
    let mut metadata = parser::compute_metadata(&path, &entries, &template_id);
    metadata.sniff_kind = Some(sniff_kind);

    let session = store.get_or_create(window.label());
    session.load_with_lines(metadata.clone(), entries, lines);

    // 注册路径反向索引（用 canonical 路径，便于 lookup_by_path 命中）
    if let Ok(canonical) = std::fs::canonicalize(&path) {
        store.register_path(canonical, window.label().to_string());
    }

    // 设置窗口标题
    let title = Path::new(&path).file_name()
        .map(|n| format!("{} — Lumen", n.to_string_lossy()))
        .unwrap_or_else(|| "Lumen".to_string());
    let _ = window.set_title(&title);

    // 成功后记录到最近文件（失败不阻塞）+ 广播
    let _ = prefs_store.record_recent(&path);
    let _ = app.emit("lv:prefs-changed", "recent_files");

    Ok(metadata)
}
```

注：`emit` 在 Tauri 2 是 `app.emit(event, payload)`（全局广播，等价于旧版 `emit_all`）。引入：

```rust
use tauri::Emitter;
```

- [ ] **Step 3: 改造剩 8 个 cmd**

对照 spec §5.1 列表，按 Step 1 的模板批量改：

```
cmd_query / cmd_get_page / cmd_reparse_with_template
cmd_start_follow / cmd_stop_follow / cmd_export
cmd_get_neighbor / cmd_get_position
```

每个 cmd：
1. 签名首位加 `window: tauri::Window`
2. `state: State<'_, SessionState>` → `store: State<'_, SessionStore>`
3. 函数体首行：`let session = store.get(window.label()).ok_or(AppError::NoSession)?;`
4. 把所有 `state.xxx()` / `&state` 全文替换成 `session.xxx()` / `&session`

例：`cmd_query` 原 `state.with_entries(|entries| ...)` → `session.with_entries(|entries| ...)`

- [ ] **Step 4: 编译验证全部通过**

```bash
cd src-tauri && cargo build 2>&1 | tail -10
```

期望：无错误。如果某个 cmd 漏改 `state.` → `session.`，根据错误修。

- [ ] **Step 5: 跑全部测试**

```bash
cd src-tauri && cargo test 2>&1 | tail -20
```

期望：现有 lib 测试 + Task 1 新增测试全 PASS。若 commands.rs 内有依赖单例 SessionState 的测试，按需改造或先标记 `#[ignore]`（记下来 Phase 8 集成测试时回头处理）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "refactor(backend): session-scoped cmds take Window + route via SessionStore"
```

---

### Task 2.3：4 个新 cmd（open_in_new_window / open_blank_window / get_ui_prefs / save_ui_prefs）

**Files:** Modify `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: 加 cmd_get_ui_prefs / cmd_save_ui_prefs**

`src-tauri/src/commands.rs` 找到 `cmd_get_font_size` 附近（其他视觉 prefs cmd），追加：

```rust
#[tauri::command]
pub fn cmd_get_ui_prefs(prefs_store: State<'_, PrefsStore>) -> UiPrefs {
    prefs_store.get_ui_prefs()
}

#[tauri::command]
pub fn cmd_save_ui_prefs(
    prefs_store: State<'_, PrefsStore>,
    app: tauri::AppHandle,
    ui_prefs: UiPrefs,
) -> Result<(), AppError> {
    prefs_store.save_ui_prefs(ui_prefs)?;
    let _ = app.emit("lv:prefs-changed", "ui");
    Ok(())
}
```

`use` 段加 `UiPrefs`：

```rust
use crate::prefs::{CustomTemplate, PrefsStore, SavedFilter, UiPrefs};
```

（按现有 use 行模式补 UiPrefs）

- [ ] **Step 2: 加 cmd_open_in_new_window**

`commands.rs` 末尾追加：

```rust
/// 统一"打开文件"入口：同路径聚焦已有窗口，否则创建新窗口
#[tauri::command]
pub async fn cmd_open_in_new_window(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    path: String,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder, Manager};

    // 规范化路径（解析软链 / 去 ..）
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("路径无效: {}", e))?;

    // 查反向索引：已打开就聚焦
    if let Some(existing_label) = store.lookup_by_path(&canonical) {
        if let Some(w) = app.get_webview_window(&existing_label) {
            let _ = w.set_focus();
            return Ok(());
        }
        // label 在反向索引里但窗口已销毁 — 清理后走 fallthrough 开新窗
        store.close(&existing_label);
    }

    // 创建新窗口
    let label = format!("win-{}", uuid::Uuid::new_v4().simple());
    let encoded_path = urlencoding::encode(&canonical.to_string_lossy());
    let url = format!("/?path={}", encoded_path);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Lumen")
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;

    Ok(())
}
```

依赖：在 `Cargo.toml` 加 `uuid = { version = "1", features = ["v4"] }` 和 `urlencoding = "2"`。

- [ ] **Step 3: 加 cmd_open_blank_window**

```rust
/// 弹空白窗口（⌘N / macOS dock reopen）
#[tauri::command]
pub async fn cmd_open_blank_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let label = format!("win-{}", uuid::Uuid::new_v4().simple());
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("/".into()))
        .title("Lumen")
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;
    Ok(())
}
```

- [ ] **Step 4: lib.rs 注册 4 个新 cmd + uuid/urlencoding 引入**

`src-tauri/Cargo.toml` `[dependencies]`：

```toml
uuid = { version = "1", features = ["v4"] }
urlencoding = "2"
```

`src-tauri/src/lib.rs` `invoke_handler` 末尾加：

```rust
commands::cmd_get_ui_prefs,
commands::cmd_save_ui_prefs,
commands::cmd_open_in_new_window,
commands::cmd_open_blank_window,
```

- [ ] **Step 5: 编译验证**

```bash
cd src-tauri && cargo build 2>&1 | tail -10
```

期望：编译过。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(backend): add open_in_new_window / open_blank_window / ui_prefs cmds"
```

---

### Task 2.4：WindowEvent::CloseRequested → SessionStore::close

**Files:** Modify `src-tauri/src/lib.rs`

- [ ] **Step 1: 加 on_window_event 监听**

`tauri::Builder::default()` 链上 `.invoke_handler(...)` 之前加：

```rust
.on_window_event(|window, event| {
    use tauri::WindowEvent;
    use tauri::Manager;
    if let WindowEvent::CloseRequested { .. } = event {
        let store: tauri::State<session_store::SessionStore> = window.state();
        store.close(window.label());
    }
})
```

- [ ] **Step 2: 编译验证**

```bash
cd src-tauri && cargo build 2>&1 | tail -10
```

期望：编译通过（Manager trait 提供 .state() 方法）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(backend): release session on window close"
```

---

## Phase 3：写入侧广播（其他 save_* cmd）

### Task 3.1：剩余 save_* cmd 加 emit 广播

**Files:** Modify `src-tauri/src/commands.rs`

按 spec §5.3 表格，给以下 cmd 加 emit。每个 cmd 在写 prefs 成功后、return 之前加：

```rust
let _ = app.emit("lv:prefs-changed", "<kind>");
```

签名要加 `app: tauri::AppHandle`。

- [ ] **Step 1: cmd_save_custom_template / cmd_delete_custom_template → "templates"**

例（save_custom_template，按现有签名追加 app 参数）：

```rust
#[tauri::command]
pub fn cmd_save_custom_template(
    app: tauri::AppHandle,
    prefs_store: State<'_, PrefsStore>,
    registry: State<'_, Registry>,
    tpl: CustomTemplate,
) -> Result<(), AppError> {
    // ... 原有逻辑 ...
    let _ = app.emit("lv:prefs-changed", "templates");
    Ok(())
}
```

同样对 `cmd_delete_custom_template` 处理。

- [ ] **Step 2: cmd_save_filter / cmd_delete_saved_filter / cmd_rename_saved_filter → "saved_filters"**

每个加 `app: tauri::AppHandle` 参数；成功后 `let _ = app.emit("lv:prefs-changed", "saved_filters");`

- [ ] **Step 3: cmd_save_column_widths / cmd_save_column_visibility → "column_prefs"**

同上模式。

- [ ] **Step 4: cmd_save_font_size → "font_size"**

同上。

- [ ] **Step 5: cmd_clear_recent_files → "recent_files"**

同上（cmd_open_file 在 Task 2.2 已加过 recent_files 广播）。

- [ ] **Step 6: 编译验证 + 跑测试**

```bash
cd src-tauri && cargo build 2>&1 | tail -5 && cargo test --lib 2>&1 | tail -5
```

期望：编译过、测试 PASS。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(backend): emit lv:prefs-changed on all save_* cmds"
```

---

## Phase 4：macOS 生命周期

### Task 4.1：macOS RunEvent::ExitRequested → prevent_exit + Reopen → 弹空白窗

**Files:** Modify `src-tauri/src/lib.rs`

- [ ] **Step 1: 把 .run 拆为 .build + run_iteration 模式**

当前末尾：

```rust
.run(tauri::generate_context!())
.expect("error while running tauri application");
```

改为：

```rust
.build(tauri::generate_context!())
.expect("error while building tauri application")
.run(|app_handle, event| {
    #[cfg(target_os = "macos")]
    {
        use tauri::RunEvent;
        match event {
            RunEvent::ExitRequested { api, .. } => {
                // 关到 0 窗口时 Tauri 触发 ExitRequested — 一律拦下来留 dock
                // 用户主动退出走 menu bar 的 Quit 项（Task 4.2 注册）
                api.prevent_exit();
            }
            RunEvent::Reopen { has_visible_windows: false, .. } => {
                // dock 点击 + 无可见窗口 → 弹空白窗
                let app = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = commands::cmd_open_blank_window(app).await;
                });
            }
            _ => {}
        }
        let _ = app_handle;  // 静默 unused warning（非 macOS）
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app_handle, event);
    }
});
```

- [ ] **Step 2: 编译验证**

```bash
cd src-tauri && cargo build 2>&1 | tail -10
```

期望：编译过。若 `RunEvent::Reopen` 解构字段名变了（Tauri 2 版本差异），查 `cargo doc --open` 或 `tauri::RunEvent` 文档对齐。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(backend): macOS keep-dock on last-window-close + reopen blank"
```

---

### Task 4.2：macOS 原生 Quit menu bar

**Files:** Modify `src-tauri/src/lib.rs`

- [ ] **Step 1: 加 menu builder**

`tauri::Builder::default()` 链上 `.on_window_event(...)` 之前加：

```rust
.menu(|app_handle| {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder};
        let quit = MenuItemBuilder::with_id("quit", "Quit Lumen")
            .accelerator("CmdOrCtrl+Q")
            .build(app_handle)?;
        let app_menu = SubmenuBuilder::new(app_handle, "Lumen")
            .item(&quit)
            .build()?;
        let menu = MenuBuilder::new(app_handle).items(&[&app_menu]).build()?;
        return Ok(menu);
    }
    #[cfg(not(target_os = "macos"))]
    {
        // 非 macOS 走 Tauri 默认菜单（或空）
        tauri::menu::MenuBuilder::new(app_handle).build()
    }
})
.on_menu_event(|app, event| {
    if event.id().as_ref() == "quit" {
        app.exit(0);
    }
})
```

- [ ] **Step 2: 编译验证**

```bash
cd src-tauri && cargo build 2>&1 | tail -10
```

期望：编译过。若 `tauri::menu::*` 命名空间在当前版本不同，搜 `tauri::menu::MenuBuilder` 文档对齐。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(backend): macOS native Quit menu (bypass prevent_exit)"
```

---

## Phase 5：前端 — UI 偏好迁移 + 跨窗同步

### Task 5.1：uiPrefs.ts 从 localStorage 切到 invoke

**Files:** Modify `src/lib/uiPrefs.ts`, `src/api/commands.ts`

- [ ] **Step 1: api/commands.ts 加 getUiPrefs / saveUiPrefs**

找到现有 invoke 封装区域（如 `getFontSize` 附近），追加：

```ts
import { invoke } from '@tauri-apps/api/core';

export interface RawUiPrefs {
  theme: string;      // "" | "light" | "dark"
  accent: string;     // "" | "blue" | "violet" | "teal" | "rose"
  highlight: string;  // "" | "yellow" | "emerald" | "pink" | "sky"
}

export async function getUiPrefs(): Promise<RawUiPrefs> {
  return invoke<RawUiPrefs>('cmd_get_ui_prefs');
}

export async function saveUiPrefs(uiPrefs: RawUiPrefs): Promise<void> {
  await invoke('cmd_save_ui_prefs', { uiPrefs });
}
```

- [ ] **Step 2: 改写 uiPrefs.ts**

替换整个文件内容（保留原有 ACCENT_PALETTE / HIGHLIGHT_PALETTE / applyUiPrefs，仅改 load/save）：

```ts
// 视觉偏好（主题 / 强调色 / 高亮色）的本地持久化
// v2：从 localStorage 迁到 prefs.json（多窗口跨窗同步）
// 启动序列：同步立即 apply DEFAULT → 异步拉真实值 reapply

import { getUiPrefs as apiGetUi, saveUiPrefs as apiSaveUi } from '../api/commands';

export type Theme = 'light' | 'dark';
export type AccentName = 'blue' | 'violet' | 'teal' | 'rose';
export type HighlightName = 'yellow' | 'emerald' | 'pink' | 'sky';

export interface UiPrefs {
  theme: Theme;
  accent: AccentName;
  highlight: HighlightName;
}

const LEGACY_KEY = 'lv:ui-prefs';
export const DEFAULT: UiPrefs = { theme: 'light', accent: 'blue', highlight: 'yellow' };

export const ACCENT_PALETTE: Record<AccentName, { name: string; main: string; hover: string; bg: string; bgDark: string }> = {
  blue:   { name: '蓝',    main: '#2563eb', hover: '#1d4ed8', bg: '#eff6ff', bgDark: 'rgba(37,99,235,0.22)' },
  violet: { name: '紫',    main: '#7c3aed', hover: '#6d28d9', bg: '#f5f3ff', bgDark: 'rgba(124,58,237,0.22)' },
  teal:   { name: '青',    main: '#0d9488', hover: '#0f766e', bg: '#f0fdfa', bgDark: 'rgba(13,148,136,0.24)' },
  rose:   { name: '玫红',  main: '#e11d48', hover: '#be123c', bg: '#fff1f2', bgDark: 'rgba(225,29,72,0.22)' },
};

export const HIGHLIGHT_PALETTE: Record<HighlightName, { name: string; bg: string; text: string }> = {
  yellow:  { name: '黄',    bg: '#fef08a', text: '#0f172a' },
  emerald: { name: '绿',    bg: '#a7f3d0', text: '#064e3b' },
  pink:    { name: '粉',    bg: '#fbcfe8', text: '#831843' },
  sky:     { name: '天蓝',  bg: '#bae6fd', text: '#0c4a6e' },
};

function normalize(raw: { theme: string; accent: string; highlight: string }): UiPrefs {
  return {
    theme:     raw.theme === 'dark' ? 'dark' : 'light',
    accent:    (raw.accent in ACCENT_PALETTE)       ? raw.accent as AccentName    : DEFAULT.accent,
    highlight: (raw.highlight in HIGHLIGHT_PALETTE) ? raw.highlight as HighlightName : DEFAULT.highlight,
  };
}

/** 从后端拉 — async，启动时和 prefs-changed 时调 */
export async function loadUiPrefs(): Promise<UiPrefs> {
  try {
    const raw = await apiGetUi();
    return normalize(raw);
  } catch {
    return DEFAULT;
  }
}

/** 写入后端（成功后后端会 emit_to_all 广播触发各窗 reapply） */
export async function saveUiPrefs(p: UiPrefs): Promise<void> {
  await apiSaveUi({ theme: p.theme, accent: p.accent, highlight: p.highlight });
}

/** 把当前 prefs 应用到 :root —— 设 data-theme + 注入 CSS var */
export function applyUiPrefs(p: UiPrefs): void {
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  const a = ACCENT_PALETTE[p.accent];
  const h = HIGHLIGHT_PALETTE[p.highlight];
  root.style.setProperty('--accent',       a.main);
  root.style.setProperty('--accent-hover', a.hover);
  root.style.setProperty('--accent-bg',    p.theme === 'dark' ? a.bgDark : a.bg);
  root.style.setProperty('--hl-bg',        h.bg);
  root.style.setProperty('--hl-text',      h.text);
}

/** 一次性 localStorage → 后端 迁移；首次启动新版本时跑一次 */
export async function migrateLegacyLocalStorage(): Promise<void> {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const cur = await apiGetUi();
    // 后端已有非空值时不覆盖（用户已经在新版本里手动设过）
    if (cur.theme || cur.accent || cur.highlight) {
      localStorage.removeItem(LEGACY_KEY);
      return;
    }
    await apiSaveUi({
      theme:     parsed.theme || '',
      accent:    parsed.accent || '',
      highlight: parsed.highlight || '',
    });
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* 迁移失败静默；下次保存会覆盖 */ }
}
```

- [ ] **Step 3: SettingsDialog 适配 async saveUiPrefs**

`src/components/SettingsDialog.tsx` 找到 `updateUi`：

```ts
// 旧
const updateUi = (patch: Partial<UiPrefs>) => {
  const next = { ...ui, ...patch };
  setUi(next);
  saveUiPrefs(next);
  applyUiPrefs(next);
};
```

改为：

```ts
const updateUi = (patch: Partial<UiPrefs>) => {
  const next = { ...ui, ...patch };
  setUi(next);
  // 不主动 applyUiPrefs — 等后端 emit "ui" 回来由 usePrefsSync 触发
  saveUiPrefs(next).catch(() => { /* 写盘失败静默 */ });
};
```

并把组件初始化从同步 `loadUiPrefs()` 改为异步：

```ts
// 旧
const [ui, setUi] = useState<UiPrefs>(() => loadUiPrefs());
// 新
const [ui, setUi] = useState<UiPrefs>(DEFAULT);
useEffect(() => {
  loadUiPrefs().then(setUi);
}, []);
```

import 加 `DEFAULT`、`useEffect`。

- [ ] **Step 4: 编译验证**

```bash
npx tsc --noEmit && npm run build 2>&1 | tail -5
```

期望：tsc 无错；vite build 成功。

- [ ] **Step 5: Commit**

```bash
git add src/lib/uiPrefs.ts src/api/commands.ts src/components/SettingsDialog.tsx
git commit -m "feat(fe): migrate UI prefs from localStorage to prefs.json"
```

---

### Task 5.2：App.tsx 启动序列 + 迁移

**Files:** Modify `src/App.tsx`

- [ ] **Step 1: 加 migration + 异步 reapply 调用**

`src/App.tsx` 顶部已有 `applyUiPrefs(loadUiPrefs());`。但现在 loadUiPrefs 是 async — 这行要变。改造方案：

文件顶部保留即时同步的 DEFAULT apply（避免 flash）：

```ts
import { loadUiPrefs, applyUiPrefs, DEFAULT as UI_DEFAULT, migrateLegacyLocalStorage } from './lib/uiPrefs';

// 启动同步：先用 DEFAULT 立即 apply（光速去 flash），后续 useEffect 拉真实值 reapply
applyUiPrefs(UI_DEFAULT);
```

组件内顶部加 effect：

```ts
useEffectInit(() => {
  (async () => {
    await migrateLegacyLocalStorage();  // 一次性迁移（含无值 fast-path）
    const p = await loadUiPrefs();
    applyUiPrefs(p);
  })();
}, []);
```

- [ ] **Step 2: 编译验证**

```bash
npx tsc --noEmit 2>&1 | tail -5
```

期望：无错。

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(fe): App boot — DEFAULT apply + async reapply + legacy migration"
```

---

### Task 5.3：usePrefsSync hook + 单元测试

**Files:** Create `src/hooks/usePrefsSync.ts`, Create `src/hooks/usePrefsSync.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `src/hooks/usePrefsSync.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// mock @tauri-apps/api/event
const listeners: Array<(evt: { payload: string }) => void> = [];
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_name: string, cb: (evt: { payload: string }) => void) => {
    listeners.push(cb);
    return Promise.resolve(() => {
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    });
  }),
}));

// mock uiPrefs / commands
const applyUiPrefs = vi.fn();
const loadUiPrefs = vi.fn(async () => ({ theme: 'dark', accent: 'blue', highlight: 'yellow' }));
vi.mock('../lib/uiPrefs', () => ({ applyUiPrefs, loadUiPrefs }));

const getFontSize = vi.fn(async () => 14);
vi.mock('../api/commands', () => ({ getFontSize }));

// mock zustand store
const setFontSize = vi.fn();
const refetchTemplates = vi.fn();
vi.mock('../state/session', () => ({
  useSession: {
    getState: () => ({ setFontSize, refetchTemplates }),
  },
}));

import { usePrefsSync } from './usePrefsSync';

describe('usePrefsSync', () => {
  beforeEach(() => {
    listeners.length = 0;
    applyUiPrefs.mockClear();
    loadUiPrefs.mockClear();
    getFontSize.mockClear();
    setFontSize.mockClear();
    refetchTemplates.mockClear();
  });

  it('payload=ui triggers loadUiPrefs + applyUiPrefs', async () => {
    renderHook(() => usePrefsSync());
    await Promise.resolve(); // let listen() promise resolve
    expect(listeners.length).toBe(1);
    listeners[0]({ payload: 'ui' });
    await Promise.resolve();
    expect(loadUiPrefs).toHaveBeenCalled();
    await Promise.resolve();
    expect(applyUiPrefs).toHaveBeenCalledWith({ theme: 'dark', accent: 'blue', highlight: 'yellow' });
  });

  it('payload=font_size refetches and updates store', async () => {
    renderHook(() => usePrefsSync());
    await Promise.resolve();
    listeners[0]({ payload: 'font_size' });
    await Promise.resolve();
    expect(getFontSize).toHaveBeenCalled();
    await Promise.resolve();
    expect(setFontSize).toHaveBeenCalledWith(14);
  });

  it('payload=saved_filters / recent_files / column_prefs are ignored', async () => {
    renderHook(() => usePrefsSync());
    await Promise.resolve();
    listeners[0]({ payload: 'saved_filters' });
    listeners[0]({ payload: 'recent_files' });
    listeners[0]({ payload: 'column_prefs' });
    await Promise.resolve();
    expect(loadUiPrefs).not.toHaveBeenCalled();
    expect(getFontSize).not.toHaveBeenCalled();
    expect(refetchTemplates).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npx vitest run src/hooks/usePrefsSync.test.ts 2>&1 | tail -15
```

期望：FAIL 因为 `usePrefsSync` 不存在。

- [ ] **Step 3: 实现 hook**

新建 `src/hooks/usePrefsSync.ts`：

```ts
// 监听后端 lv:prefs-changed 事件 → 按 payload kind 触发对应 refetch
// 只订阅 zustand-cached 状态（ui / templates / font_size）
// saved_filters / recent_files / column_prefs 走 menu lazy-load，不订阅

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { loadUiPrefs, applyUiPrefs } from '../lib/uiPrefs';
import { getFontSize } from '../api/commands';
import { useSession } from '../state/session';

type PrefsKind = 'ui' | 'templates' | 'saved_filters' | 'recent_files' | 'column_prefs' | 'font_size';

export function usePrefsSync(): void {
  useEffect(() => {
    const unlistenP = listen<PrefsKind>('lv:prefs-changed', ({ payload }) => {
      switch (payload) {
        case 'ui':
          loadUiPrefs().then(applyUiPrefs);
          break;
        case 'templates':
          useSession.getState().refetchTemplates?.();
          break;
        case 'font_size':
          getFontSize().then((n) => { if (typeof n === 'number') useSession.getState().setFontSize(n); });
          break;
        // saved_filters / recent_files / column_prefs: lazy-load 模式
        default:
          break;
      }
    });
    return () => { unlistenP.then((f) => f()).catch(() => {}); };
  }, []);
}
```

注：若 `useSession` 当前没有 `refetchTemplates` action，先在 `src/state/session.ts` 加一个：

```ts
// state/session.ts 加入 actions
refetchTemplates: async () => {
  const templates = await invoke<TemplateInfo[]>('cmd_list_templates');
  set({ templates });
},
```

（按现有 session.ts 的 zustand 模式追加；invoke 和类型从现有 import 模式拿）

- [ ] **Step 4: 跑测试通过**

```bash
npx vitest run src/hooks/usePrefsSync.test.ts 2>&1 | tail -10
```

期望：3/3 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePrefsSync.ts src/hooks/usePrefsSync.test.ts src/state/session.ts
git commit -m "feat(fe): usePrefsSync hook — listen lv:prefs-changed, refetch cached"
```

---

### Task 5.4：App.tsx 调用 usePrefsSync

**Files:** Modify `src/App.tsx`

- [ ] **Step 1: 在已有 hook 列表里加**

`App.tsx` 找到 `useGlobalShortcuts();` 行，下一行加：

```ts
import { usePrefsSync } from './hooks/usePrefsSync';
// ...
usePrefsSync();
```

- [ ] **Step 2: 编译验证**

```bash
npx tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(fe): wire usePrefsSync in App"
```

---

## Phase 6：前端 — 多窗口入口统一

### Task 6.1：api/window.ts 封装

**Files:** Create `src/api/window.ts`

- [ ] **Step 1: 写封装**

新建 `src/api/window.ts`：

```ts
// 多窗口 API 封装：openInNewWindow / openBlankWindow
// 所有"打开文件"入口（菜单 / 拖拽 / 最近文件 / ⌘O）统一走这里

import { invoke } from '@tauri-apps/api/core';

/** 打开文件到新窗口（同路径自动聚焦已有窗口） */
export async function openInNewWindow(path: string): Promise<void> {
  await invoke('cmd_open_in_new_window', { path });
}

/** 弹空白窗口（⌘N / dock reopen） */
export async function openBlankWindow(): Promise<void> {
  await invoke('cmd_open_blank_window');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api/window.ts
git commit -m "feat(fe): add window.ts (openInNewWindow / openBlankWindow)"
```

---

### Task 6.2：OpenFileMenu 走 openInNewWindow

**Files:** Modify `src/components/OpenFileMenu.tsx`

- [ ] **Step 1: 改打开 / 最近文件点击逻辑**

先精确定位 OpenFileMenu 里所有"打开文件"调用：

```bash
grep -n "openFile\|cmd_open_file\|invoke.*open" src/components/OpenFileMenu.tsx
```

把每一处"打开文件"路径（主"打开文件…"按钮的 file picker 回调 / 最近文件下拉项 click）的实现替换成调 `openInNewWindow(path)`。

替换示例（伪代码模板，按实际代码改）：

```ts
import { openInNewWindow } from '../api/window';

const handlePickFile = async () => {
  const path = await openDialog(); // 现有 file picker
  if (path) await openInNewWindow(path);
};

const handleRecentClick = (path: string) => {
  openInNewWindow(path);
  setMenuOpen(false);
};
```

注：当前窗口里点击 "打开文件" 时，**不应**清掉当前窗口的会话（spec §3.1 第 5 条 — 新窗口加载，当前窗口不动）。删掉任何"先 reset 当前 session"的代码。

- [ ] **Step 2: 编译验证**

```bash
npx tsc --noEmit && npm run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add src/components/OpenFileMenu.tsx
git commit -m "feat(fe): OpenFileMenu opens files in new windows"
```

---

### Task 6.3：useFileDrop 走 openInNewWindow

**Files:** Modify `src/hooks/useFileDrop.ts`

- [ ] **Step 1: 改 drop 回调**

`useFileDrop.ts` 找到 drop handler 内调 `openFile` 的地方，替换成 `openInNewWindow`。同样删掉 "先 reset 当前 session" 的逻辑。

```ts
import { openInNewWindow } from '../api/window';

// 在 drop event 处理里：
if (paths.length > 0) {
  await openInNewWindow(paths[0]);
}
```

- [ ] **Step 2: 编译验证**

```bash
npx tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useFileDrop.ts
git commit -m "feat(fe): file drop opens in new window"
```

---

### Task 6.4：useGlobalShortcuts 加 ⌘N + ⌘O 走 openInNewWindow

**Files:** Modify `src/hooks/useGlobalShortcuts.ts`

- [ ] **Step 1: 加 ⌘N**

`useGlobalShortcuts.ts` 找到现有 ⌘O 等 keyboard handler 块，追加：

```ts
import { openBlankWindow } from '../api/window';

// 在 keydown handler 内：
if ((e.metaKey || e.ctrlKey) && e.key === 'n' && !e.shiftKey) {
  e.preventDefault();
  openBlankWindow().catch(() => {});
  return;
}
```

- [ ] **Step 2: 改 ⌘O**

找到现有 ⌘O 触发文件选择器的代码（很可能 dispatch CustomEvent `lv:open-file` 或类似）。检查整条链路：键 → 事件 → OpenFileMenu 处理 → openFile。

若 OpenFileMenu 已在 Task 6.2 改成 openInNewWindow，⌘O 不需要改（事件链复用）。**仅当**⌘O 是直接调 invoke('cmd_open_file') 才要改。

- [ ] **Step 3: 编译验证**

```bash
npx tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useGlobalShortcuts.ts
git commit -m "feat(fe): ⌘N opens blank window"
```

---

### Task 6.5：App.tsx 读 URL ?path= 初始加载

**Files:** Modify `src/App.tsx`

- [ ] **Step 1: 加 URL query 解析 effect**

`App.tsx` 在现有的 hook 列表附近加：

```ts
useEffectInit(() => {
  const params = new URLSearchParams(window.location.search);
  const initialPath = params.get('path');
  if (initialPath) {
    useSession.getState().openFile(decodeURIComponent(initialPath));
  }
}, []);
```

注：`openFile` 是 zustand session store 已有的 action — 它内部应该调 `invoke('cmd_open_file', ...)`。如果 openFile 不存在，等价于直接 `invoke('cmd_open_file', { path: ... })` 加 metadata 写入 store。按现有代码模式照搬。

- [ ] **Step 2: 编译验证**

```bash
npx tsc --noEmit 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(fe): App reads ?path= from URL on mount to load initial file"
```

---

### Task 6.6：ShortcutsHelp 加 ⌘N 项

**Files:** Modify `src/components/ShortcutsHelp.tsx`

- [ ] **Step 1: 加项**

`ShortcutsHelp.tsx` 找到 `ITEMS: Item[]` 数组，在 `${M} O` 之后插入：

```ts
{ keys: `${M} N`, desc: '新建空白窗口' },
```

- [ ] **Step 2: SettingsDialog 同步**

`src/components/SettingsDialog.tsx` 找到 `SHORTCUT_ROWS`，同样插入：

```ts
{ keys: `${M} N`, desc: '新建空白窗口' },
```

- [ ] **Step 3: Commit**

```bash
git add src/components/ShortcutsHelp.tsx src/components/SettingsDialog.tsx
git commit -m "docs(fe): list ⌘N in shortcut help + settings"
```

---

## Phase 7：集成测试 + 验收 + README

### Task 7.1：Rust 集成测试 multi_window.rs

**Files:** Create `src-tauri/tests/multi_window.rs`

- [ ] **Step 1: 写 3 个测试**

新建 `src-tauri/tests/multi_window.rs`：

```rust
// 多窗口集成测试 — 验证 SessionStore 在 cmd 层面的语义
// 不依赖真实 Tauri Window；构造 SessionStore + 调 session API 直接验证

use log_viewer::session_store::SessionStore;
use log_viewer::model::FileMetadata;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn make_dummy_metadata(path: &str) -> FileMetadata {
    FileMetadata {
        path: path.into(),
        size_bytes: 0,
        line_count: 0,
        template_id: "json-lines".into(),
        sniff_kind: None,
        time_range: None,
    }
}

#[test]
fn two_windows_have_independent_sessions() {
    let store = SessionStore::new();
    let a = store.get_or_create("win-a");
    let b = store.get_or_create("win-b");
    a.load(make_dummy_metadata("/a.log"), vec![]);
    b.load(make_dummy_metadata("/b.log"), vec![]);
    assert_eq!(a.metadata().unwrap().path, "/a.log");
    assert_eq!(b.metadata().unwrap().path, "/b.log");
}

#[test]
fn closing_one_window_leaves_other_alive() {
    let store = SessionStore::new();
    let _a = store.get_or_create("win-a");
    let b = store.get_or_create("win-b");
    b.load(make_dummy_metadata("/b.log"), vec![]);
    store.close("win-a");
    assert!(store.get("win-a").is_none());
    let b_again = store.get("win-b").unwrap();
    assert_eq!(b_again.metadata().unwrap().path, "/b.log");
}

#[test]
fn lookup_by_path_returns_existing_label() {
    let store = SessionStore::new();
    let _a = store.get_or_create("win-a");
    store.register_path(PathBuf::from("/tmp/a.log"), "win-a".into());
    assert_eq!(store.lookup_by_path(&PathBuf::from("/tmp/a.log")), Some("win-a".into()));
    // 不同路径
    assert_eq!(store.lookup_by_path(&PathBuf::from("/tmp/b.log")), None);
    // close 后清理
    store.close("win-a");
    assert_eq!(store.lookup_by_path(&PathBuf::from("/tmp/a.log")), None);
}
```

注：若 `FileMetadata` 字段名 / 必填项与上面不同，先 `cargo check` 看错误对齐。

- [ ] **Step 2: 跑测试**

```bash
cd src-tauri && cargo test --test multi_window 2>&1 | tail -15
```

期望：3/3 PASS。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tests/multi_window.rs
git commit -m "test(backend): multi-window integration — isolated sessions + path lookup"
```

---

### Task 7.2：全测试通过

**Files:** N/A（测试运行）

- [ ] **Step 1: Rust 全测试**

```bash
cd src-tauri && cargo test 2>&1 | tail -10
```

期望：所有 lib + integration test 全 PASS。

- [ ] **Step 2: 前端 vitest**

```bash
npm test -- run 2>&1 | tail -10
```

期望：全 PASS（含 Task 5.3 新增的 usePrefsSync 测试）。

- [ ] **Step 3: 前端 build**

```bash
npm run build 2>&1 | tail -5
```

期望：成功，无 TS 错误。

如有失败：按错误定位、修、再跑。**不要往下走**。

---

### Task 7.3：README 更新

**Files:** Modify `README.md`

- [ ] **Step 1: 加多窗口章节**

在"核心能力"列表里加一项（建议放在"拖拽打开"附近）：

```markdown
- **多窗口**：每次"打开文件"都是新窗口，同路径自动聚焦已有窗口；⌘N 新建空白；macOS 关到 0 留 dock，⌘Q 通过菜单真退；视觉偏好（主题/字号/accent）跨窗实时同步
```

并在"键盘快捷键"那一项的列表里追加 `⌘N`：

```markdown
- **键盘快捷键**：⌘O 打开 / ⌘N 新窗口 / ⌘R 刷新 / ⌘F 聚焦搜索 / ⌘K 清空筛选 / ...
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): document multi-window behavior + ⌘N"
```

---

### Task 7.4：手动验收

**Files:** N/A（手动测试）

按 spec §7.4 清单跑 `npm run tauri dev` 手动验证：

- [ ] 启动后开 2 个窗口分别加载 A.log / B.log，各自 filter 互不影响
- [ ] 窗口 A 改字号（⌘= 或设置）→ 窗口 B 立即跟变
- [ ] 窗口 A 改主题为 dark → 窗口 B 立即变 dark
- [ ] 窗口 A 改 accent 为紫 → 窗口 B 选中态变紫
- [ ] 窗口 A 保存一个 saved filter → 窗口 B 打开 SavedFiltersMenu 能看到
- [ ] 窗口 A follow A.log → B follow B.log，新行各自落到各自窗口
- [ ] 关闭窗口 A → 窗口 B 仍正常 follow（A 的 watcher 已释放，观察 macOS Activity Monitor 内存稳定）
- [ ] 同一路径再次"打开" → 已有窗口 set_focus，无新窗口
- [ ] macOS 关到 0 窗口 → app 留在 dock → dock 点 icon → 弹空白窗
- [ ] ⌘N → 弹空白窗
- [ ] ⌘Q → menu Quit 触发 app 真退
- [ ] 拖拽 .log 到任意窗口 → 开新窗口加载（除非同路径）

任一项失败：记录失败现象 → 回头定位 task → 修 → 再走全清单。

- [ ] **Step 1: 所有项通过后 commit 一份验收记录**

```bash
git commit --allow-empty -m "chore: multi-window manual acceptance PASS"
```

---

## 收尾

所有 task 完成后：

- 7 phase / 24 task 全 commit
- Rust + vitest 全绿
- 手动验收清单全勾
- README 同步

下一步：调 superpowers:finishing-a-development-branch 决定如何整合（直接留 main，还是开 PR）。
