# Log Viewer — Plan 1（MVP 端到端走通）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 端到端跑通最小可用版本：用户能打开一个 JSON Lines 格式的日志文件、按 time/level/scope/keyword 筛选、看到虚拟滚动的列表与基础统计（总数 + level 分组 + scope Top10）。

**Architecture:** Tauri 2.x，Rust 后端（全内存 + rayon 并行过滤）+ React + TypeScript + Tailwind 前端。本 Plan 只覆盖单一解析模板（json-lines）+ 同步 UTF-8 加载，不含实时跟踪 / 自定义模板 / 时间桶图表 / 持久化（这些放 Plan 2 / 3）。

**Tech Stack:** Tauri 2 · Rust 1.78+ · React 18 · TypeScript 5 · Tailwind 3 · `react-window` · `zustand` · `vitest`

**Spec：** [2026-05-22-log-viewer-design.md](../specs/2026-05-22-log-viewer-design.md)

---

## 文件结构（本 Plan 涉及的文件）

```
src-tauri/
├── Cargo.toml
├── tauri.conf.json
├── src/
│   ├── main.rs              # 入口，调 lib::run()
│   ├── lib.rs               # Tauri 构建器、模块汇总（方便集成测试）
│   ├── commands.rs          # 4 个 Tauri command 包装
│   ├── error.rs             # AppError（thiserror）
│   ├── model.rs             # LogEntry / LogLevel / Stats / FileMetadata
│   ├── loader/
│   │   ├── mod.rs
│   │   └── reader.rs        # 同步读取整文件 → 行迭代器
│   ├── parser/
│   │   ├── mod.rs
│   │   ├── template.rs      # ParserTemplate trait + 模板注册表
│   │   ├── json_lines.rs    # JSON Lines 模板实现
│   │   └── level.rs         # 字符串 → LogLevel 归一化
│   ├── query/
│   │   ├── mod.rs
│   │   ├── spec.rs          # QuerySpec / ScopeFilter / MatchMode
│   │   └── filter.rs        # rayon 并行筛选 + 结果缓存
│   ├── stats/
│   │   ├── mod.rs
│   │   └── aggregator.rs    # 总数 / level / scope Top10
│   └── session/
│       ├── mod.rs
│       └── state.rs         # SessionState：Arc<Vec<LogEntry>> + 缓存
└── tests/
    └── fixtures/
        └── sample.jsonl     # 测试用样例文件

src/                         # 前端
├── main.tsx
├── App.tsx
├── index.css                # tailwind directives
├── components/
│   ├── OpenFileButton.tsx
│   ├── FilterBar.tsx
│   ├── LogList.tsx          # react-window 虚拟列表
│   └── StatsPanel.tsx
├── api/
│   └── commands.ts          # invoke 封装 + 错误处理
├── types/
│   └── log.ts               # 与 Rust 对齐的 TS 类型
└── state/
    └── session.ts           # zustand store
```

**单个模块边界**：每个 Rust 模块只暴露一个核心类型/函数；前端组件只读 props + zustand state，不互相依赖。

---

## Phase 0：项目脚手架

### Task 0.1：用 Tauri CLI 初始化项目

**Files:**
- Create: `src-tauri/...`, `src/...`, `package.json`, `tauri.conf.json` 等

- [ ] **Step 1：在仓库根目录运行脚手架**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
npm create tauri-app@latest -- --name log-viewer --template react-ts --manager npm --identifier dev.local.log-viewer
```

交互选项一律选默认（React + TypeScript + Vite）。

Expected: 当前目录下生成 `src/`、`src-tauri/`、`package.json`、`vite.config.ts`、`index.html` 等。

- [ ] **Step 2：安装运行时依赖**

Run:
```bash
npm install
npm install react-window zustand
npm install -D @types/react-window vitest @testing-library/react @testing-library/jest-dom jsdom tailwindcss postcss autoprefixer
```

- [ ] **Step 3：初始化 Tailwind**

Run:
```bash
npx tailwindcss init -p
```

修改 `tailwind.config.js`：
```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

新建/覆盖 `src/index.css`：
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

确保 `src/main.tsx` 中 `import './index.css';`。

- [ ] **Step 4：安装 Rust 依赖**

编辑 `src-tauri/Cargo.toml`，把 `[dependencies]` 段替换为：
```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = { version = "0.4", features = ["serde"] }
regex = "1"
rayon = "1.10"
parking_lot = "0.12"
thiserror = "1"
once_cell = "1"

[dev-dependencies]
tempfile = "3"
```

然后在 `src-tauri/src/lib.rs` 顶部加：
```rust
use tauri_plugin_dialog;
```
并在 `tauri::Builder::default()` 链中加 `.plugin(tauri_plugin_dialog::init())`。

- [ ] **Step 4b：给 dialog plugin 授权 capability**

Tauri 2.x 默认拒绝所有 plugin 命令，必须显式 allow。打开 `src-tauri/capabilities/default.json`，在 `permissions` 数组里加入：

```json
"dialog:allow-open",
"dialog:default"
```

修改后 `permissions` 大概长这样：
```json
"permissions": [
  "core:default",
  "dialog:default",
  "dialog:allow-open"
]
```

如果 `default.json` 文件不存在（脚手架未生成），新建之：
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities for the app",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:default",
    "dialog:allow-open"
  ]
}
```

- [ ] **Step 5：验证脚手架能跑**

Run:
```bash
npm run tauri dev
```

Expected: 弹出一个原生窗口显示默认 React 页面。Ctrl-C 关闭后继续。

- [ ] **Step 6：初始化 git + 首次提交**

Run:
```bash
git init
echo "node_modules/\ndist/\nsrc-tauri/target/" > .gitignore
git add .
git commit -m "chore: scaffold tauri + react + ts + tailwind project"
```

---

### Task 0.2：建立后端模块骨架

**Files:**
- Create: `src-tauri/src/lib.rs`、`src-tauri/src/main.rs`、`src-tauri/src/{error,model,commands}.rs`、各子模块 `mod.rs`
- Create: `src-tauri/tests/fixtures/sample.jsonl`

- [ ] **Step 1：建立模块目录与 mod.rs**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri/src"
mkdir -p loader parser query stats session
touch loader/mod.rs parser/mod.rs query/mod.rs stats/mod.rs session/mod.rs
```

- [ ] **Step 2：写 lib.rs 汇总模块**

新建/覆盖 `src-tauri/src/lib.rs`：
```rust
// 模块入口，公开给集成测试与 main.rs

pub mod commands;
pub mod error;
pub mod loader;
pub mod model;
pub mod parser;
pub mod query;
pub mod session;
pub mod stats;

use session::SessionState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionState::default())
        .invoke_handler(tauri::generate_handler![
            commands::cmd_open_file,
            commands::cmd_query,
            commands::cmd_get_metadata,
            commands::cmd_get_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3：精简 main.rs**

覆盖 `src-tauri/src/main.rs`：
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    log_viewer_lib::run();
}
```

注意：crate 名取决于 `Cargo.toml` 的 `[package].name`；脚手架默认是 `log-viewer`，对应 lib 名 `log_viewer_lib`。如不一致，按实际改 `main.rs`。

- [ ] **Step 4：建立空 mod.rs 让编译过**

每个子目录的 `mod.rs` 写入对应 placeholder：

`src-tauri/src/loader/mod.rs`:
```rust
pub mod reader;
```

`src-tauri/src/parser/mod.rs`:
```rust
pub mod template;
pub mod json_lines;
pub mod level;
```

`src-tauri/src/query/mod.rs`:
```rust
pub mod spec;
pub mod filter;
```

`src-tauri/src/stats/mod.rs`:
```rust
pub mod aggregator;
```

`src-tauri/src/session/mod.rs`:
```rust
pub mod state;

pub use state::SessionState;
```

然后为每个尚未实现的子文件创建空文件以便编译：
```bash
touch loader/reader.rs parser/template.rs parser/json_lines.rs parser/level.rs \
      query/spec.rs query/filter.rs stats/aggregator.rs session/state.rs \
      error.rs model.rs commands.rs
```

- [ ] **Step 5：让空文件能编译**

往以下文件各加最小占位（之后 Phase 替换）：

`error.rs`:
```rust
// 临时占位，Phase 1 替换
```

`model.rs`:
```rust
// 临时占位，Phase 1 替换
```

`commands.rs`:
```rust
// 占位，Phase 7 实现
#[tauri::command]
pub fn cmd_open_file(_path: String) -> Result<(), String> { Err("not implemented".into()) }
#[tauri::command]
pub fn cmd_query() -> Result<(), String> { Err("not implemented".into()) }
#[tauri::command]
pub fn cmd_get_metadata() -> Result<(), String> { Err("not implemented".into()) }
#[tauri::command]
pub fn cmd_get_page() -> Result<(), String> { Err("not implemented".into()) }
```

`session/state.rs`:
```rust
#[derive(Default)]
pub struct SessionState;
```

其他文件保持空即可。

- [ ] **Step 6：编译验证**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri"
cargo build
```

Expected: 编译成功（可能有未使用的 warning，忽略）。

- [ ] **Step 7：准备测试用 fixture**

Run:
```bash
mkdir -p tests/fixtures
```

新建 `src-tauri/tests/fixtures/sample.jsonl`：
```jsonl
{"time":"2026-05-22T09:00:00Z","level":"info","logger":"auth","msg":"user logged in","user_id":42}
{"time":"2026-05-22T09:00:05Z","level":"warn","logger":"db","msg":"slow query 1.2s","query":"SELECT *"}
{"time":"2026-05-22T09:00:10Z","level":"error","logger":"auth","msg":"token invalid","user_id":42}
{"time":"2026-05-22T09:00:15Z","level":"info","logger":"http","msg":"GET /api/users 200"}
{"time":"2026-05-22T09:00:20Z","level":"debug","logger":"db.pool","msg":"acquire conn"}
```

- [ ] **Step 8：commit**

Run:
```bash
git add src-tauri/src src-tauri/Cargo.toml src-tauri/tests/fixtures
git commit -m "chore(rust): scaffold backend modules and test fixture"
```

---

## Phase 1：核心数据模型与错误类型

### Task 1.1：实现 `AppError`

**Files:**
- Modify: `src-tauri/src/error.rs`

- [ ] **Step 1：写测试**

新建 `src-tauri/src/error.rs`：
```rust
// AppError：统一错误类型，便于在 Tauri command 中序列化返回前端

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("文件 IO 错误：{0}")]
    Io(String),

    #[error("文件未打开")]
    NoSession,

    #[error("解析错误：{0}")]
    Parse(String),

    #[error("内部错误：{0}")]
    Internal(String),
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_io_error_as_tagged_json() {
        let e = AppError::Io("nope".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#"{"kind":"Io","message":"nope"}"#);
    }

    #[test]
    fn from_std_io_error_maps_to_io_variant() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "x");
        let app_err: AppError = io_err.into();
        matches!(app_err, AppError::Io(_));
    }
}
```

- [ ] **Step 2：跑测试验证**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri"
cargo test --lib error::
```

Expected: 2 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/error.rs
git commit -m "feat(error): add AppError with serde-friendly serialization"
```

---

### Task 1.2：实现核心数据模型

**Files:**
- Modify: `src-tauri/src/model.rs`

- [ ] **Step 1：写测试**

新建 `src-tauri/src/model.rs`：
```rust
// 核心领域模型：日志条目、级别、文件元数据、统计结果

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub line_no: u32,
    pub timestamp: Option<DateTime<Utc>>,
    pub level: LogLevel,
    pub scope: Option<String>,
    pub message: String,
    pub fields: HashMap<String, String>,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileMetadata {
    pub path: String,
    pub total: u32,
    pub time_range: Option<(DateTime<Utc>, DateTime<Utc>)>,
    pub level_counts: HashMap<LogLevel, u32>,
    pub scopes: Vec<String>,
    pub template_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub total: u32,
    pub level_counts: HashMap<LogLevel, u32>,
    pub top_scopes: Vec<(String, u32)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_level_serializes_lowercase() {
        let j = serde_json::to_string(&LogLevel::Error).unwrap();
        assert_eq!(j, "\"error\"");
    }

    #[test]
    fn log_entry_roundtrips_through_serde() {
        let e = LogEntry {
            line_no: 1,
            timestamp: None,
            level: LogLevel::Info,
            scope: Some("auth".into()),
            message: "ok".into(),
            fields: HashMap::new(),
            raw: "raw".into(),
        };
        let j = serde_json::to_string(&e).unwrap();
        let back: LogEntry = serde_json::from_str(&j).unwrap();
        assert_eq!(back.line_no, 1);
        assert_eq!(back.scope.as_deref(), Some("auth"));
    }
}
```

- [ ] **Step 2：跑测试**

Run:
```bash
cargo test --lib model::
```

Expected: 2 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/model.rs
git commit -m "feat(model): define LogEntry, LogLevel, FileMetadata, Stats"
```

---

## Phase 2：Level 归一化与 JSON Lines 解析模板

### Task 2.1：Level 字符串归一化

**Files:**
- Modify: `src-tauri/src/parser/level.rs`

- [ ] **Step 1：写测试 + 实现**

新建 `src-tauri/src/parser/level.rs`：
```rust
// 把任意大小写的 level 字符串归一化到 LogLevel 枚举

use crate::model::LogLevel;

pub fn parse_level(s: &str) -> LogLevel {
    match s.trim().to_ascii_lowercase().as_str() {
        "trace" => LogLevel::Trace,
        "debug" => LogLevel::Debug,
        "info" | "information" => LogLevel::Info,
        "warn" | "warning" => LogLevel::Warn,
        "error" | "err" | "fatal" | "critical" => LogLevel::Error,
        _ => LogLevel::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;

    #[test]
    fn maps_common_aliases() {
        assert_eq!(parse_level("INFO"), LogLevel::Info);
        assert_eq!(parse_level("Information"), LogLevel::Info);
        assert_eq!(parse_level(" warn "), LogLevel::Warn);
        assert_eq!(parse_level("warning"), LogLevel::Warn);
        assert_eq!(parse_level("err"), LogLevel::Error);
        assert_eq!(parse_level("Fatal"), LogLevel::Error);
        assert_eq!(parse_level("Critical"), LogLevel::Error);
    }

    #[test]
    fn unknown_falls_back() {
        assert_eq!(parse_level("verbose"), LogLevel::Unknown);
        assert_eq!(parse_level(""), LogLevel::Unknown);
    }
}
```

- [ ] **Step 2：跑测试**

Run:
```bash
cargo test --lib parser::level::
```

Expected: 2 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/parser/level.rs
git commit -m "feat(parser): add level string normalization"
```

---

### Task 2.2：定义 ParserTemplate trait

**Files:**
- Modify: `src-tauri/src/parser/template.rs`

- [ ] **Step 1：写实现（trait 本身无需独立测试，由具体模板覆盖）**

新建 `src-tauri/src/parser/template.rs`：
```rust
// 解析模板抽象：所有内置 / 自定义模板都实现 ParserTemplate
// MVP 只实现 JsonLines；其余模板放 Plan 2

use crate::model::LogEntry;

pub trait ParserTemplate: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    /// 解析一行原始文本。返回 None 表示彻底无法解析；
    /// 上层会用兜底逻辑把它包成 level=Unknown 的 LogEntry。
    fn parse_line(&self, raw: &str) -> Option<PartialEntry>;
}

/// 模板只负责"从行里提取字段"；line_no、raw、兜底由 ParserEngine 统一填
pub struct PartialEntry {
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
    pub level: crate::model::LogLevel,
    pub scope: Option<String>,
    pub message: String,
    pub fields: std::collections::HashMap<String, String>,
}

/// 把 PartialEntry 装配成完整 LogEntry
pub fn finalize(line_no: u32, raw: &str, p: PartialEntry) -> LogEntry {
    LogEntry {
        line_no,
        timestamp: p.timestamp,
        level: p.level,
        scope: p.scope,
        message: p.message,
        fields: p.fields,
        raw: raw.to_string(),
    }
}

/// 解析失败兜底：保留行内容，level=Unknown
pub fn fallback(line_no: u32, raw: &str) -> LogEntry {
    LogEntry {
        line_no,
        timestamp: None,
        level: crate::model::LogLevel::Unknown,
        scope: None,
        message: raw.to_string(),
        fields: std::collections::HashMap::new(),
        raw: raw.to_string(),
    }
}
```

- [ ] **Step 2：编译验证**

Run:
```bash
cargo build
```

Expected: 编译成功。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/parser/template.rs
git commit -m "feat(parser): add ParserTemplate trait and entry assembly helpers"
```

---

### Task 2.3：实现 JSON Lines 模板

**Files:**
- Modify: `src-tauri/src/parser/json_lines.rs`

- [ ] **Step 1：写测试**

新建 `src-tauri/src/parser/json_lines.rs`：
```rust
// JSON Lines（每行一个 JSON 对象）解析模板

use crate::model::LogLevel;
use crate::parser::level::parse_level;
use crate::parser::template::{ParserTemplate, PartialEntry};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::HashMap;

pub struct JsonLinesTemplate;

const TIME_KEYS: &[&str] = &["time", "ts", "timestamp", "@timestamp"];
const LEVEL_KEYS: &[&str] = &["level", "lvl", "severity"];
const SCOPE_KEYS: &[&str] = &["scope", "logger", "module", "name"];
const MESSAGE_KEYS: &[&str] = &["msg", "message"];

impl ParserTemplate for JsonLinesTemplate {
    fn id(&self) -> &'static str { "json-lines" }
    fn name(&self) -> &'static str { "JSON Lines" }

    fn parse_line(&self, raw: &str) -> Option<PartialEntry> {
        let v: Value = serde_json::from_str(raw.trim()).ok()?;
        let obj = v.as_object()?;

        let timestamp = pick_str(obj, TIME_KEYS).and_then(|s| parse_time(&s));
        let level = pick_str(obj, LEVEL_KEYS)
            .map(|s| parse_level(&s))
            .unwrap_or(LogLevel::Unknown);
        let scope = pick_str(obj, SCOPE_KEYS);
        let message = pick_str(obj, MESSAGE_KEYS).unwrap_or_default();

        // 其余字段放进 fields（值统一字符串化，方便 ScopeFilter 通用匹配）
        let consumed: Vec<&str> = TIME_KEYS.iter()
            .chain(LEVEL_KEYS).chain(SCOPE_KEYS).chain(MESSAGE_KEYS)
            .copied().collect();
        let mut fields = HashMap::new();
        for (k, val) in obj {
            if consumed.contains(&k.as_str()) { continue; }
            fields.insert(k.clone(), stringify(val));
        }

        Some(PartialEntry { timestamp, level, scope, message, fields })
    }
}

fn pick_str(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(v) = obj.get(*k) {
            return Some(stringify(v));
        }
    }
    None
}

fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    // 优先 RFC3339；失败再试普通 datetime
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;

    fn p() -> JsonLinesTemplate { JsonLinesTemplate }

    #[test]
    fn parses_standard_line() {
        let raw = r#"{"time":"2026-05-22T09:00:00Z","level":"info","logger":"auth","msg":"hi","x":1}"#;
        let r = p().parse_line(raw).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("auth"));
        assert_eq!(r.message, "hi");
        assert!(r.timestamp.is_some());
        assert_eq!(r.fields.get("x").map(|s| s.as_str()), Some("1"));
    }

    #[test]
    fn supports_alternate_keys() {
        let raw = r#"{"ts":"2026-05-22T09:00:00Z","severity":"WARN","module":"db","message":"slow"}"#;
        let r = p().parse_line(raw).unwrap();
        assert_eq!(r.level, LogLevel::Warn);
        assert_eq!(r.scope.as_deref(), Some("db"));
        assert_eq!(r.message, "slow");
    }

    #[test]
    fn returns_none_on_garbage() {
        assert!(p().parse_line("this is not json").is_none());
        assert!(p().parse_line("").is_none());
    }

    #[test]
    fn missing_level_yields_unknown() {
        let raw = r#"{"msg":"hi"}"#;
        let r = p().parse_line(raw).unwrap();
        assert_eq!(r.level, LogLevel::Unknown);
    }
}
```

- [ ] **Step 2：跑测试**

Run:
```bash
cargo test --lib parser::json_lines::
```

Expected: 4 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/parser/json_lines.rs
git commit -m "feat(parser): implement JSON Lines template"
```

---

## Phase 3：FileLoader（同步读取）

### Task 3.1：实现 reader

**Files:**
- Modify: `src-tauri/src/loader/reader.rs`

- [ ] **Step 1：写测试 + 实现**

新建 `src-tauri/src/loader/reader.rs`：
```rust
// FileLoader：MVP 只做 UTF-8 同步读取，按行返回
// （字符集探测、watcher、增量读放 Plan 2）

use crate::error::AppError;
use std::fs;
use std::path::Path;

pub fn read_all_lines(path: &Path) -> Result<Vec<String>, AppError> {
    let bytes = fs::read(path)?;
    // BOM 去除：UTF-8 BOM = EF BB BF
    let start = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
    let text = String::from_utf8_lossy(&bytes[start..]).into_owned();
    // 保留空行（行号要连续），但去掉行尾 \r
    let lines = text.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(content: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content).unwrap();
        f
    }

    #[test]
    fn reads_unix_lines() {
        let f = write_temp(b"a\nb\nc\n");
        let lines = read_all_lines(f.path()).unwrap();
        // split('\n') 在尾部 '\n' 后会产生一个空字符串，保留以确保行号一致
        assert_eq!(lines, vec!["a", "b", "c", ""]);
    }

    #[test]
    fn strips_crlf() {
        let f = write_temp(b"a\r\nb\r\n");
        let lines = read_all_lines(f.path()).unwrap();
        assert_eq!(lines, vec!["a", "b", ""]);
    }

    #[test]
    fn strips_utf8_bom() {
        let mut content = vec![0xEFu8, 0xBB, 0xBF];
        content.extend_from_slice(b"hello\n");
        let f = write_temp(&content);
        let lines = read_all_lines(f.path()).unwrap();
        assert_eq!(lines[0], "hello");
    }

    #[test]
    fn missing_file_returns_io_error() {
        let r = read_all_lines(Path::new("/nonexistent/path/xyz"));
        assert!(matches!(r, Err(AppError::Io(_))));
    }
}
```

- [ ] **Step 2：跑测试**

Run:
```bash
cargo test --lib loader::
```

Expected: 4 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/loader/reader.rs
git commit -m "feat(loader): add UTF-8 line reader with BOM/CRLF handling"
```

---

## Phase 4：Session State

### Task 4.1：实现 SessionState 容器

**Files:**
- Modify: `src-tauri/src/session/state.rs`

- [ ] **Step 1：写测试 + 实现**

覆盖 `src-tauri/src/session/state.rs`：
```rust
// SessionState：进程级单例（通过 Tauri State 注入）
// 保存当前打开文件的所有 LogEntry + 元数据 + 查询缓存

use crate::error::AppError;
use crate::model::{FileMetadata, LogEntry};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Default)]
pub struct SessionState(RwLock<Option<SessionInner>>);

pub struct SessionInner {
    pub metadata: FileMetadata,
    pub entries: Arc<Vec<LogEntry>>,
    pub cache: HashMap<u64, Arc<Vec<u32>>>, // QuerySpec hash → matched line indices
}

impl SessionState {
    pub fn load(&self, metadata: FileMetadata, entries: Vec<LogEntry>) {
        let mut w = self.0.write();
        *w = Some(SessionInner {
            metadata,
            entries: Arc::new(entries),
            cache: HashMap::new(),
        });
    }

    pub fn with_entries<F, R>(&self, f: F) -> Result<R, AppError>
    where F: FnOnce(&Arc<Vec<LogEntry>>) -> R {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        Ok(f(&inner.entries))
    }

    pub fn metadata(&self) -> Result<FileMetadata, AppError> {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        Ok(inner.metadata.clone())
    }

    /// 查询缓存：命中返回索引数组；未命中调用 compute 算并写回
    pub fn cached_or_compute<F>(&self, key: u64, compute: F) -> Result<Arc<Vec<u32>>, AppError>
    where F: FnOnce(&Arc<Vec<LogEntry>>) -> Vec<u32> {
        // 读：命中直接返回
        {
            let r = self.0.read();
            let inner = r.as_ref().ok_or(AppError::NoSession)?;
            if let Some(hit) = inner.cache.get(&key) {
                return Ok(hit.clone());
            }
        }
        // 未命中：写锁下计算
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        if let Some(hit) = inner.cache.get(&key) {
            return Ok(hit.clone()); // double-check
        }
        let result = Arc::new(compute(&inner.entries));
        inner.cache.insert(key, result.clone());
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LogEntry, LogLevel};
    use std::collections::HashMap;

    fn dummy_entry(line: u32) -> LogEntry {
        LogEntry {
            line_no: line,
            timestamp: None,
            level: LogLevel::Info,
            scope: None,
            message: String::new(),
            fields: HashMap::new(),
            raw: String::new(),
        }
    }

    fn dummy_meta() -> FileMetadata {
        FileMetadata {
            path: "/x".into(),
            total: 0,
            time_range: None,
            level_counts: HashMap::new(),
            scopes: vec![],
            template_id: "json-lines".into(),
        }
    }

    #[test]
    fn returns_no_session_before_load() {
        let s = SessionState::default();
        assert!(matches!(s.metadata(), Err(AppError::NoSession)));
    }

    #[test]
    fn caches_compute_result() {
        let s = SessionState::default();
        s.load(dummy_meta(), vec![dummy_entry(1), dummy_entry(2)]);
        let mut hits = 0;
        let _ = s.cached_or_compute(99, |_| { hits += 1; vec![0] }).unwrap();
        let _ = s.cached_or_compute(99, |_| { hits += 1; vec![0] }).unwrap();
        assert_eq!(hits, 1, "第二次应该命中缓存");
    }
}
```

- [ ] **Step 2：跑测试**

Run:
```bash
cargo test --lib session::
```

Expected: 2 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/session/state.rs
git commit -m "feat(session): add SessionState with entries + query cache"
```

---

## Phase 5：QueryEngine

### Task 5.1：定义 QuerySpec / ScopeFilter / MatchMode

**Files:**
- Modify: `src-tauri/src/query/spec.rs`

- [ ] **Step 1：写实现 + 测试**

覆盖 `src-tauri/src/query/spec.rs`：
```rust
// 查询规范：前后端契约的核心结构

use crate::model::LogLevel;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::hash::{Hash, Hasher};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QuerySpec {
    pub time_range: Option<(DateTime<Utc>, DateTime<Utc>)>,
    pub levels: Option<HashSet<LogLevel>>,
    pub scope_filter: Option<ScopeFilter>,
    pub text_search: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopeFilter {
    pub field_name: String, // "scope" → LogEntry.scope；其他 → LogEntry.fields[field_name]
    pub pattern: String,
    pub mode: MatchMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchMode {
    Exact,
    Glob,
    Regex,
}

impl QuerySpec {
    /// 用 JSON 序列化结果做哈希 —— 简单、稳定、对 MVP 够用
    pub fn cache_key(&self) -> u64 {
        let s = serde_json::to_string(self).unwrap_or_default();
        let mut h = std::collections::hash_map::DefaultHasher::new();
        s.hash(&mut h);
        h.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_stable_across_equal_specs() {
        let a = QuerySpec {
            text_search: Some("hi".into()),
            ..Default::default()
        };
        let b = QuerySpec {
            text_search: Some("hi".into()),
            ..Default::default()
        };
        assert_eq!(a.cache_key(), b.cache_key());
    }

    #[test]
    fn cache_key_differs_for_different_specs() {
        let a = QuerySpec { text_search: Some("hi".into()), ..Default::default() };
        let b = QuerySpec { text_search: Some("yo".into()), ..Default::default() };
        assert_ne!(a.cache_key(), b.cache_key());
    }
}
```

- [ ] **Step 2：跑测试**

Run:
```bash
cargo test --lib query::spec::
```

Expected: 2 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/query/spec.rs
git commit -m "feat(query): define QuerySpec, ScopeFilter, MatchMode with cache key"
```

---

### Task 5.2：实现过滤函数

**Files:**
- Modify: `src-tauri/src/query/filter.rs`

- [ ] **Step 1：写测试 + 实现**

覆盖 `src-tauri/src/query/filter.rs`：
```rust
// 过滤算法：单条 Entry 对一个 QuerySpec 的匹配判断；
// 调用方负责并行（rayon）+ 缓存（SessionState）

use crate::model::LogEntry;
use crate::query::spec::{MatchMode, QuerySpec, ScopeFilter};
use once_cell::sync::OnceCell;
use regex::Regex;
use std::sync::Mutex;

pub fn matches(entry: &LogEntry, spec: &QuerySpec, scope_re: &Option<Regex>) -> bool {
    // 时间区间
    if let Some((from, to)) = &spec.time_range {
        let Some(t) = entry.timestamp else { return false; };
        if t < *from || t > *to { return false; }
    }
    // Level
    if let Some(levels) = &spec.levels {
        if !levels.contains(&entry.level) { return false; }
    }
    // Scope
    if let Some(sf) = &spec.scope_filter {
        if !scope_matches(entry, sf, scope_re) { return false; }
    }
    // 全文关键词（大小写不敏感，先在 message 后在 raw）
    if let Some(kw) = &spec.text_search {
        if !kw.is_empty() {
            let needle = kw.to_lowercase();
            let hay_msg = entry.message.to_lowercase();
            let hay_raw = entry.raw.to_lowercase();
            if !hay_msg.contains(&needle) && !hay_raw.contains(&needle) {
                return false;
            }
        }
    }
    true
}

fn scope_matches(entry: &LogEntry, sf: &ScopeFilter, re: &Option<Regex>) -> bool {
    let value: Option<&str> = if sf.field_name == "scope" {
        entry.scope.as_deref()
    } else {
        entry.fields.get(&sf.field_name).map(|s| s.as_str())
    };
    let Some(v) = value else { return false; };
    match sf.mode {
        MatchMode::Exact => v == sf.pattern,
        MatchMode::Glob  => glob_match(&sf.pattern, v),
        MatchMode::Regex => re.as_ref().map(|r| r.is_match(v)).unwrap_or(false),
    }
}

/// 简化 glob：支持 * 和 ?；不支持字符类（YAGNI）
pub fn glob_match(pattern: &str, text: &str) -> bool {
    // 转译为正则并缓存
    static CACHE: OnceCell<Mutex<std::collections::HashMap<String, Regex>>> = OnceCell::new();
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let mut map = cache.lock().unwrap();
    let re = map.entry(pattern.to_string()).or_insert_with(|| {
        let mut r = String::from("^");
        for c in pattern.chars() {
            match c {
                '*' => r.push_str(".*"),
                '?' => r.push('.'),
                _   => r.push_str(&regex::escape(&c.to_string())),
            }
        }
        r.push('$');
        Regex::new(&r).unwrap_or_else(|_| Regex::new("^$").unwrap())
    });
    re.is_match(text)
}

pub fn compile_scope_regex(spec: &QuerySpec) -> Option<Regex> {
    let sf = spec.scope_filter.as_ref()?;
    if !matches!(sf.mode, MatchMode::Regex) { return None; }
    Regex::new(&sf.pattern).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LogEntry, LogLevel};
    use crate::query::spec::{MatchMode, QuerySpec, ScopeFilter};
    use std::collections::HashMap;
    use std::collections::HashSet;

    fn entry(level: LogLevel, scope: Option<&str>, msg: &str) -> LogEntry {
        LogEntry {
            line_no: 1,
            timestamp: None,
            level,
            scope: scope.map(String::from),
            message: msg.into(),
            fields: HashMap::new(),
            raw: msg.into(),
        }
    }

    #[test]
    fn empty_spec_matches_everything() {
        let e = entry(LogLevel::Info, None, "anything");
        assert!(matches(&e, &QuerySpec::default(), &None));
    }

    #[test]
    fn level_filter_works() {
        let e = entry(LogLevel::Warn, None, "x");
        let mut levels = HashSet::new();
        levels.insert(LogLevel::Error);
        let spec = QuerySpec { levels: Some(levels), ..Default::default() };
        assert!(!matches(&e, &spec, &None));
    }

    #[test]
    fn scope_exact_match() {
        let e = entry(LogLevel::Info, Some("auth"), "x");
        let spec = QuerySpec {
            scope_filter: Some(ScopeFilter {
                field_name: "scope".into(), pattern: "auth".into(), mode: MatchMode::Exact,
            }),
            ..Default::default()
        };
        assert!(matches(&e, &spec, &None));
    }

    #[test]
    fn scope_glob_match() {
        let e = entry(LogLevel::Info, Some("db.pool"), "x");
        let spec = QuerySpec {
            scope_filter: Some(ScopeFilter {
                field_name: "scope".into(), pattern: "db.*".into(), mode: MatchMode::Glob,
            }),
            ..Default::default()
        };
        assert!(matches(&e, &spec, &None));
    }

    #[test]
    fn scope_regex_match() {
        let e = entry(LogLevel::Info, Some("auth.user"), "x");
        let spec = QuerySpec {
            scope_filter: Some(ScopeFilter {
                field_name: "scope".into(), pattern: r"^auth\..+".into(), mode: MatchMode::Regex,
            }),
            ..Default::default()
        };
        let re = compile_scope_regex(&spec);
        assert!(matches(&e, &spec, &re));
    }

    #[test]
    fn scope_uses_fields_when_field_name_not_scope() {
        let mut fields = HashMap::new();
        fields.insert("request_id".into(), "req-abc".into());
        let e = LogEntry {
            line_no: 1, timestamp: None, level: LogLevel::Info, scope: None,
            message: "x".into(), fields, raw: String::new(),
        };
        let spec = QuerySpec {
            scope_filter: Some(ScopeFilter {
                field_name: "request_id".into(), pattern: "req-abc".into(), mode: MatchMode::Exact,
            }),
            ..Default::default()
        };
        assert!(matches(&e, &spec, &None));
    }

    #[test]
    fn text_search_case_insensitive() {
        let e = entry(LogLevel::Info, None, "Login Failed");
        let spec = QuerySpec { text_search: Some("login".into()), ..Default::default() };
        assert!(matches(&e, &spec, &None));
    }
}
```

- [ ] **Step 2：跑测试**

Run:
```bash
cargo test --lib query::filter::
```

Expected: 7 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/query/filter.rs
git commit -m "feat(query): implement filter with time/level/scope/text predicates"
```

---

### Task 5.3：实现 QueryEngine 调度（并行 + 缓存）

**Files:**
- Modify: `src-tauri/src/query/mod.rs`

- [ ] **Step 1：写实现**

覆盖 `src-tauri/src/query/mod.rs`：
```rust
pub mod spec;
pub mod filter;

pub use spec::{MatchMode, QuerySpec, ScopeFilter};

use crate::error::AppError;
use crate::model::LogEntry;
use crate::session::SessionState;
use rayon::prelude::*;
use std::sync::Arc;

/// 在 SessionState 上跑 query，返回匹配的行号数组（u32 = LogEntry.line_no 的索引，
/// 这里直接用 Vec 索引 = entries 中的位置）
pub fn run_query(session: &SessionState, spec: &QuerySpec) -> Result<Arc<Vec<u32>>, AppError> {
    let key = spec.cache_key();
    let scope_re = filter::compile_scope_regex(spec);
    session.cached_or_compute(key, |entries: &Arc<Vec<LogEntry>>| {
        entries.par_iter()
            .enumerate()
            .filter(|(_, e)| filter::matches(e, spec, &scope_re))
            .map(|(i, _)| i as u32)
            .collect()
    })
}
```

- [ ] **Step 2：跑测试（已被 filter::tests 覆盖单条；这里做集成性 smoke）**

新建 `src-tauri/src/query/mod.rs` 末尾的 tests：
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FileMetadata, LogEntry, LogLevel};
    use std::collections::{HashMap, HashSet};

    fn e(level: LogLevel, scope: Option<&str>, msg: &str) -> LogEntry {
        LogEntry {
            line_no: 0, timestamp: None, level, scope: scope.map(String::from),
            message: msg.into(), fields: HashMap::new(), raw: msg.into(),
        }
    }

    #[test]
    fn returns_indices_of_matching_entries() {
        let s = SessionState::default();
        let meta = FileMetadata {
            path: "/x".into(), total: 3, time_range: None,
            level_counts: HashMap::new(), scopes: vec![], template_id: "json-lines".into(),
        };
        s.load(meta, vec![
            e(LogLevel::Info, None, "a"),
            e(LogLevel::Error, None, "b"),
            e(LogLevel::Info, None, "c"),
        ]);
        let mut levels = HashSet::new();
        levels.insert(LogLevel::Error);
        let spec = QuerySpec { levels: Some(levels), ..Default::default() };
        let r = run_query(&s, &spec).unwrap();
        assert_eq!(*r, vec![1u32]);
    }
}
```

Run:
```bash
cargo test --lib query::tests::
```

Expected: 1 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/query/mod.rs
git commit -m "feat(query): add run_query orchestrator with rayon + cache"
```

---

## Phase 6：StatsEngine

### Task 6.1：聚合函数

**Files:**
- Modify: `src-tauri/src/stats/aggregator.rs`、`src-tauri/src/stats/mod.rs`

- [ ] **Step 1：写测试 + 实现**

覆盖 `src-tauri/src/stats/aggregator.rs`：
```rust
// 统计聚合：在已匹配的索引集合上算总数 + level 分组 + scope Top10
// 时间桶趋势放 Plan 2

use crate::model::{LogEntry, LogLevel, Stats};
use std::collections::HashMap;

pub fn aggregate(entries: &[LogEntry], matched: &[u32]) -> Stats {
    let mut level_counts: HashMap<LogLevel, u32> = HashMap::new();
    let mut scope_counts: HashMap<String, u32> = HashMap::new();

    for &idx in matched {
        let Some(e) = entries.get(idx as usize) else { continue; };
        *level_counts.entry(e.level).or_insert(0) += 1;
        if let Some(s) = &e.scope {
            *scope_counts.entry(s.clone()).or_insert(0) += 1;
        }
    }

    let mut top: Vec<(String, u32)> = scope_counts.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    top.truncate(10);

    Stats { total: matched.len() as u32, level_counts, top_scopes: top }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn e(level: LogLevel, scope: Option<&str>) -> LogEntry {
        LogEntry {
            line_no: 0, timestamp: None, level, scope: scope.map(String::from),
            message: String::new(), fields: HashMap::new(), raw: String::new(),
        }
    }

    #[test]
    fn aggregates_total_and_level_counts() {
        let entries = vec![
            e(LogLevel::Info, Some("a")),
            e(LogLevel::Error, Some("a")),
            e(LogLevel::Info, Some("b")),
        ];
        let matched = vec![0u32, 1, 2];
        let s = aggregate(&entries, &matched);
        assert_eq!(s.total, 3);
        assert_eq!(s.level_counts.get(&LogLevel::Info), Some(&2));
        assert_eq!(s.level_counts.get(&LogLevel::Error), Some(&1));
    }

    #[test]
    fn top_scopes_sorted_by_count_desc_then_name() {
        let entries = vec![
            e(LogLevel::Info, Some("b")),
            e(LogLevel::Info, Some("a")),
            e(LogLevel::Info, Some("a")),
            e(LogLevel::Info, Some("c")),
        ];
        let s = aggregate(&entries, &[0u32, 1, 2, 3]);
        assert_eq!(s.top_scopes[0], ("a".to_string(), 2));
        // b 和 c 同为 1，按名字升序
        assert_eq!(s.top_scopes[1].0, "b");
        assert_eq!(s.top_scopes[2].0, "c");
    }

    #[test]
    fn ignores_entries_without_scope_in_top() {
        let entries = vec![ e(LogLevel::Info, None), e(LogLevel::Info, Some("a")) ];
        let s = aggregate(&entries, &[0u32, 1]);
        assert_eq!(s.top_scopes.len(), 1);
    }
}
```

覆盖 `src-tauri/src/stats/mod.rs`：
```rust
pub mod aggregator;
pub use aggregator::aggregate;
```

- [ ] **Step 2：跑测试**

Run:
```bash
cargo test --lib stats::
```

Expected: 3 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/stats
git commit -m "feat(stats): aggregate total + level counts + scope top 10"
```

---

## Phase 7：ParserEngine 装配 + FileMetadata 计算

### Task 7.1：parser/mod.rs 装配

**Files:**
- Modify: `src-tauri/src/parser/mod.rs`

- [ ] **Step 1：写测试 + 实现**

覆盖 `src-tauri/src/parser/mod.rs`：
```rust
pub mod template;
pub mod json_lines;
pub mod level;

use crate::model::{FileMetadata, LogEntry, LogLevel};
use json_lines::JsonLinesTemplate;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use template::{fallback, finalize, ParserTemplate};

/// MVP：直接用 JSON Lines 模板。Plan 2 会替换为"嗅探 → 选模板"
pub fn parse_lines(lines: &[String]) -> Vec<LogEntry> {
    let tpl = JsonLinesTemplate;
    lines.par_iter()
        .enumerate()
        .map(|(i, line)| {
            let line_no = (i + 1) as u32;
            if line.trim().is_empty() {
                return fallback(line_no, line);
            }
            match tpl.parse_line(line) {
                Some(p) => finalize(line_no, line, p),
                None => fallback(line_no, line),
            }
        })
        .collect()
}

pub fn compute_metadata(path: &str, entries: &[LogEntry]) -> FileMetadata {
    let mut level_counts: HashMap<LogLevel, u32> = HashMap::new();
    let mut scopes: HashSet<String> = HashSet::new();
    let mut min_t = None;
    let mut max_t = None;
    for e in entries {
        *level_counts.entry(e.level).or_insert(0) += 1;
        if let Some(s) = &e.scope { scopes.insert(s.clone()); }
        if let Some(t) = e.timestamp {
            min_t = Some(min_t.map(|m: chrono::DateTime<chrono::Utc>| m.min(t)).unwrap_or(t));
            max_t = Some(max_t.map(|m: chrono::DateTime<chrono::Utc>| m.max(t)).unwrap_or(t));
        }
    }
    let time_range = match (min_t, max_t) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    };
    let mut scope_list: Vec<String> = scopes.into_iter().collect();
    scope_list.sort();
    FileMetadata {
        path: path.to_string(),
        total: entries.len() as u32,
        time_range,
        level_counts,
        scopes: scope_list,
        template_id: "json-lines".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mixed_lines_with_fallback() {
        let lines = vec![
            r#"{"level":"info","msg":"hi"}"#.to_string(),
            "garbage line".to_string(),
            "".to_string(),
        ];
        let r = parse_lines(&lines);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].level, LogLevel::Info);
        assert_eq!(r[1].level, LogLevel::Unknown);
        assert_eq!(r[1].raw, "garbage line");
        assert_eq!(r[2].level, LogLevel::Unknown); // 空行也兜底，保持行号连续
    }

    #[test]
    fn metadata_collects_scopes_and_time_range() {
        let lines = vec![
            r#"{"time":"2026-05-22T09:00:00Z","level":"info","logger":"a","msg":"x"}"#.to_string(),
            r#"{"time":"2026-05-22T10:00:00Z","level":"warn","logger":"b","msg":"y"}"#.to_string(),
        ];
        let entries = parse_lines(&lines);
        let m = compute_metadata("/tmp/x.jsonl", &entries);
        assert_eq!(m.total, 2);
        assert_eq!(m.scopes, vec!["a".to_string(), "b".to_string()]);
        assert!(m.time_range.is_some());
    }
}
```

- [ ] **Step 2：跑测试**

Run:
```bash
cargo test --lib parser::tests::
```

Expected: 2 个测试通过。

- [ ] **Step 3：commit**

Run:
```bash
git add src-tauri/src/parser/mod.rs
git commit -m "feat(parser): assemble parse_lines + compute_metadata"
```

---

## Phase 8：Tauri Commands

### Task 8.1：实现 4 个 command

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1：写实现**

覆盖 `src-tauri/src/commands.rs`：
```rust
// Tauri command 层：薄壳，仅协调 loader / parser / query / stats / session

use crate::error::AppError;
use crate::loader::reader;
use crate::model::{FileMetadata, LogEntry, Stats};
use crate::parser;
use crate::query::{self, QuerySpec};
use crate::session::SessionState;
use crate::stats;
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Serialize)]
pub struct QueryResponse {
    pub total_matched: u32,
    pub page_entries: Vec<LogEntry>,
    pub stats: Stats,
}

#[tauri::command]
pub fn cmd_open_file(
    path: String,
    state: State<'_, SessionState>,
) -> Result<FileMetadata, AppError> {
    let lines = reader::read_all_lines(Path::new(&path))?;
    let entries = parser::parse_lines(&lines);
    let metadata = parser::compute_metadata(&path, &entries);
    state.load(metadata.clone(), entries);
    Ok(metadata)
}

#[tauri::command]
pub fn cmd_get_metadata(state: State<'_, SessionState>) -> Result<FileMetadata, AppError> {
    state.metadata()
}

#[tauri::command]
pub fn cmd_query(
    spec: QuerySpec,
    page: u32,
    page_size: u32,
    state: State<'_, SessionState>,
) -> Result<QueryResponse, AppError> {
    let matched = query::run_query(&state, &spec)?;
    let stats = state.with_entries(|entries| stats::aggregate(entries, &matched))?;
    let page_entries = state.with_entries(|entries| {
        let start = (page * page_size) as usize;
        let end = ((page + 1) * page_size) as usize;
        matched
            .iter()
            .skip(start).take(end - start)
            .filter_map(|&i| entries.get(i as usize).cloned())
            .collect::<Vec<LogEntry>>()
    })?;
    Ok(QueryResponse { total_matched: matched.len() as u32, page_entries, stats })
}

/// 单独翻页：相同 spec 下高频调用，复用缓存
#[tauri::command]
pub fn cmd_get_page(
    spec: QuerySpec,
    page: u32,
    page_size: u32,
    state: State<'_, SessionState>,
) -> Result<Vec<LogEntry>, AppError> {
    let matched = query::run_query(&state, &spec)?;
    state.with_entries(|entries| {
        let start = (page * page_size) as usize;
        let end = ((page + 1) * page_size) as usize;
        matched.iter().skip(start).take(end - start)
            .filter_map(|&i| entries.get(i as usize).cloned())
            .collect()
    })
}
```

- [ ] **Step 2：编译验证**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri"
cargo build
```

Expected: 编译成功。

- [ ] **Step 3：写端到端集成测试**

新建 `src-tauri/tests/integration.rs`：
```rust
// 通过 lib 直接调用 command 的内部函数，验证完整链路

use log_viewer_lib::loader::reader;
use log_viewer_lib::model::LogLevel;
use log_viewer_lib::parser;
use log_viewer_lib::query::{self, QuerySpec};
use log_viewer_lib::session::SessionState;
use log_viewer_lib::stats;
use std::collections::HashSet;
use std::path::Path;

#[test]
fn end_to_end_open_filter_aggregate() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/sample.jsonl")).unwrap();
    let entries = parser::parse_lines(&lines);
    let meta = parser::compute_metadata("tests/fixtures/sample.jsonl", &entries);

    let s = SessionState::default();
    s.load(meta, entries);

    // 筛选 error
    let mut levels = HashSet::new();
    levels.insert(LogLevel::Error);
    let spec = QuerySpec { levels: Some(levels), ..Default::default() };

    let matched = query::run_query(&s, &spec).unwrap();
    let agg = s.with_entries(|e| stats::aggregate(e, &matched)).unwrap();

    assert_eq!(matched.len(), 1); // sample.jsonl 里只有 1 条 error
    assert_eq!(agg.total, 1);
    assert_eq!(agg.level_counts.get(&LogLevel::Error), Some(&1));
}
```

- [ ] **Step 4：跑集成测试**

Run:
```bash
cargo test --test integration
```

Expected: 1 个测试通过。

- [ ] **Step 5：commit**

Run:
```bash
git add src-tauri/src/commands.rs src-tauri/tests/integration.rs
git commit -m "feat(commands): wire open_file/query/get_page/get_metadata + end-to-end test"
```

---

## Phase 9：前端类型与 API 封装

### Task 9.1：TS 类型与 API 客户端

**Files:**
- Create: `src/types/log.ts`、`src/api/commands.ts`

- [ ] **Step 1：定义类型**

新建 `src/types/log.ts`：
```ts
// 与 Rust 端结构对齐；任何字段变更必须同步两边

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'unknown';

export type MatchMode = 'exact' | 'glob' | 'regex';

export interface ScopeFilter {
  field_name: string;
  pattern: string;
  mode: MatchMode;
}

export interface QuerySpec {
  time_range?: [string, string] | null;   // RFC3339 字符串
  levels?: LogLevel[] | null;
  scope_filter?: ScopeFilter | null;
  text_search?: string | null;
}

export interface LogEntry {
  line_no: number;
  timestamp: string | null;
  level: LogLevel;
  scope: string | null;
  message: string;
  fields: Record<string, string>;
  raw: string;
}

export interface FileMetadata {
  path: string;
  total: number;
  time_range: [string, string] | null;
  level_counts: Partial<Record<LogLevel, number>>;
  scopes: string[];
  template_id: string;
}

export interface Stats {
  total: number;
  level_counts: Partial<Record<LogLevel, number>>;
  top_scopes: [string, number][];
}

export interface QueryResponse {
  total_matched: number;
  page_entries: LogEntry[];
  stats: Stats;
}

export interface AppErrorShape {
  kind: 'Io' | 'NoSession' | 'Parse' | 'Internal';
  message: string;
}
```

- [ ] **Step 2：封装 invoke**

新建 `src/api/commands.ts`：
```ts
// 统一的 Tauri command 调用层
// Rust 端 levels 是 HashSet，serde 会序列化为数组；TS 端用数组传入

import { invoke } from '@tauri-apps/api/core';
import type { FileMetadata, QueryResponse, QuerySpec, LogEntry } from '../types/log';

/** 序列化 QuerySpec 时 levels 由数组转为后端可接受形态 */
function serializeSpec(spec: QuerySpec): unknown {
  return {
    time_range: spec.time_range ?? null,
    levels: spec.levels ?? null,
    scope_filter: spec.scope_filter ?? null,
    text_search: spec.text_search ?? null,
  };
}

export async function openFile(path: string): Promise<FileMetadata> {
  return invoke<FileMetadata>('cmd_open_file', { path });
}

export async function getMetadata(): Promise<FileMetadata> {
  return invoke<FileMetadata>('cmd_get_metadata');
}

export async function query(spec: QuerySpec, page: number, pageSize: number): Promise<QueryResponse> {
  return invoke<QueryResponse>('cmd_query', { spec: serializeSpec(spec), page, pageSize });
}

export async function getPage(spec: QuerySpec, page: number, pageSize: number): Promise<LogEntry[]> {
  return invoke<LogEntry[]>('cmd_get_page', { spec: serializeSpec(spec), page, pageSize });
}
```

- [ ] **Step 3：安装 tauri-plugin-dialog js 端 + tauri api**

Run:
```bash
npm install @tauri-apps/api @tauri-apps/plugin-dialog
```

- [ ] **Step 4：commit**

Run:
```bash
git add src/types src/api package.json package-lock.json
git commit -m "feat(fe): add log types and tauri command client"
```

---

## Phase 10：前端状态与布局骨架

### Task 10.1：zustand store

**Files:**
- Create: `src/state/session.ts`

- [ ] **Step 1：实现**

新建 `src/state/session.ts`：
```ts
// 全局状态：当前文件元数据 + 当前 QuerySpec + 最新查询结果

import { create } from 'zustand';
import type { FileMetadata, QuerySpec, QueryResponse, LogLevel } from '../types/log';

const ALL_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'unknown'];

interface SessionStore {
  metadata: FileMetadata | null;
  spec: QuerySpec;
  result: QueryResponse | null;
  loading: boolean;
  error: string | null;
  setMetadata: (m: FileMetadata | null) => void;
  setSpec: (s: QuerySpec) => void;
  patchSpec: (p: Partial<QuerySpec>) => void;
  setResult: (r: QueryResponse | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
}

export const useSession = create<SessionStore>((set) => ({
  metadata: null,
  spec: { levels: ALL_LEVELS },
  result: null,
  loading: false,
  error: null,
  setMetadata: (m) => set({ metadata: m }),
  setSpec: (spec) => set({ spec }),
  patchSpec: (p) => set((s) => ({ spec: { ...s.spec, ...p } })),
  setResult: (result) => set({ result }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
```

- [ ] **Step 2：commit**

Run:
```bash
git add src/state
git commit -m "feat(fe): add zustand session store"
```

---

### Task 10.2：主布局 + OpenFileButton

**Files:**
- Modify: `src/App.tsx`、`src/main.tsx`、`src/index.css`
- Create: `src/components/OpenFileButton.tsx`

- [ ] **Step 1：写 OpenFileButton**

新建 `src/components/OpenFileButton.tsx`：
```tsx
// 打开文件按钮：调 tauri dialog 选文件 → 调 openFile command → 写入 store

import { open } from '@tauri-apps/plugin-dialog';
import { openFile } from '../api/commands';
import { useSession } from '../state/session';

export function OpenFileButton() {
  const { setMetadata, setError, setLoading, setResult } = useSession();

  const handle = async () => {
    setError(null);
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Log', extensions: ['log', 'jsonl', 'txt'] }],
    });
    if (typeof selected !== 'string') return;
    try {
      setLoading(true);
      setResult(null);
      const md = await openFile(selected);
      setMetadata(md);
    } catch (e) {
      const msg = typeof e === 'string' ? e : JSON.stringify(e);
      setError(`打开失败：${msg}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handle}
      className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
    >
      打开日志文件
    </button>
  );
}
```

- [ ] **Step 2：写 App.tsx 骨架**

覆盖 `src/App.tsx`：
```tsx
import { OpenFileButton } from './components/OpenFileButton';
import { useSession } from './state/session';

export default function App() {
  const { metadata, loading, error } = useSession();
  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 px-4 py-2 border-b bg-white">
        <h1 className="text-base font-semibold">Log Viewer</h1>
        <OpenFileButton />
        <div className="ml-auto text-xs text-slate-500">
          {metadata ? `${metadata.path} · ${metadata.total} 行 · 模板 ${metadata.template_id}` : '未打开文件'}
        </div>
      </header>
      {error && (
        <div className="px-4 py-2 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
      )}
      {loading && (
        <div className="px-4 py-2 text-sm text-slate-600">加载中…</div>
      )}
      <main className="flex-1 overflow-hidden">
        {!metadata && !loading && (
          <div className="h-full flex items-center justify-center text-slate-400">
            点击"打开日志文件"开始
          </div>
        )}
        {/* FilterBar / StatsPanel / LogList 在后续 Phase 加入 */}
      </main>
    </div>
  );
}
```

- [ ] **Step 3：手动验证**

Run:
```bash
npm run tauri dev
```

Expected: 窗口显示标题栏 + "打开日志文件"按钮；点击能弹出文件选择对话框；选中 `src-tauri/tests/fixtures/sample.jsonl` 后顶部显示 "...sample.jsonl · 5 行 · 模板 json-lines"。Ctrl-C 关闭。

- [ ] **Step 4：commit**

Run:
```bash
git add src/App.tsx src/components/OpenFileButton.tsx
git commit -m "feat(fe): app shell with file open flow"
```

---

## Phase 11：FilterBar

### Task 11.1：实现筛选栏组件

**Files:**
- Create: `src/components/FilterBar.tsx`

- [ ] **Step 1：实现**

新建 `src/components/FilterBar.tsx`：
```tsx
// 筛选栏：level toggle + scope（字段+模式+模式选择） + 关键词 + 时间区间
// 输入有 150ms debounce，对外通过 useSession 的 patchSpec 暴露

import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../state/session';
import type { LogLevel, MatchMode } from '../types/log';

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'unknown'];
const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: 'bg-slate-200 text-slate-700',
  debug: 'bg-cyan-200 text-cyan-800',
  info: 'bg-blue-200 text-blue-800',
  warn: 'bg-amber-200 text-amber-800',
  error: 'bg-red-200 text-red-800',
  unknown: 'bg-slate-100 text-slate-500',
};

export function FilterBar() {
  const { spec, patchSpec, metadata } = useSession();

  // 本地输入态（debounce 后再写 store）
  const [keyword, setKeyword] = useState(spec.text_search ?? '');
  const [scopeField, setScopeField] = useState(spec.scope_filter?.field_name ?? 'scope');
  const [scopePattern, setScopePattern] = useState(spec.scope_filter?.pattern ?? '');
  const [scopeMode, setScopeMode] = useState<MatchMode>(spec.scope_filter?.mode ?? 'glob');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // debounce 关键词
  useEffect(() => {
    const t = setTimeout(() => patchSpec({ text_search: keyword || null }), 150);
    return () => clearTimeout(t);
  }, [keyword, patchSpec]);

  // debounce scope 三联
  useEffect(() => {
    const t = setTimeout(() => {
      patchSpec({
        scope_filter: scopePattern
          ? { field_name: scopeField, pattern: scopePattern, mode: scopeMode }
          : null,
      });
    }, 150);
    return () => clearTimeout(t);
  }, [scopeField, scopePattern, scopeMode, patchSpec]);

  // debounce 时间
  useEffect(() => {
    const t = setTimeout(() => {
      const tr: [string, string] | null = from && to ? [from, to] : null;
      patchSpec({ time_range: tr });
    }, 150);
    return () => clearTimeout(t);
  }, [from, to, patchSpec]);

  const fieldOptions = useMemo(() => {
    // "scope" + 当前文件出现过的 fields 名（MVP 简化：只列 "scope"）
    return ['scope'];
  }, [metadata]);

  const toggleLevel = (lv: LogLevel) => {
    const current = new Set(spec.levels ?? LEVELS);
    if (current.has(lv)) current.delete(lv); else current.add(lv);
    patchSpec({ levels: Array.from(current) });
  };

  const activeLevels = new Set(spec.levels ?? LEVELS);

  return (
    <div className="p-3 border-b bg-white space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-500">级别：</span>
        {LEVELS.map((lv) => (
          <button
            key={lv}
            onClick={() => toggleLevel(lv)}
            className={[
              'px-2 py-0.5 rounded text-xs uppercase tracking-wide',
              activeLevels.has(lv) ? LEVEL_COLOR[lv] : 'bg-slate-50 text-slate-400 line-through',
            ].join(' ')}
          >
            {lv}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-500">Scope：</span>
        <select
          value={scopeField}
          onChange={(e) => setScopeField(e.target.value)}
          className="border rounded px-1 py-0.5 text-xs"
        >
          {fieldOptions.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <input
          value={scopePattern}
          onChange={(e) => setScopePattern(e.target.value)}
          placeholder="模式（如 auth.* 或 user-service）"
          className="border rounded px-2 py-0.5 text-xs flex-1 max-w-xs"
        />
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
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-500">关键词：</span>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="在 message / 原始行中搜索"
          className="border rounded px-2 py-0.5 text-xs flex-1 max-w-md"
        />
        <span className="text-slate-500 ml-2">时间：</span>
        <input
          type="datetime-local"
          value={from}
          onChange={(e) => setFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
          className="border rounded px-1 py-0.5 text-xs"
        />
        <span className="text-slate-400">~</span>
        <input
          type="datetime-local"
          value={to}
          onChange={(e) => setTo(e.target.value ? new Date(e.target.value).toISOString() : '')}
          className="border rounded px-1 py-0.5 text-xs"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2：commit**

Run:
```bash
git add src/components/FilterBar.tsx
git commit -m "feat(fe): add FilterBar with level/scope/keyword/time filters"
```

---

## Phase 12：自动查询 hook + StatsPanel

### Task 12.1：useAutoQuery hook

**Files:**
- Create: `src/hooks/useAutoQuery.ts`

- [ ] **Step 1：实现**

新建 `src/hooks/useAutoQuery.ts`：
```ts
// QuerySpec / metadata 变化时自动调 cmd_query；
// 用 ref + 计数器丢弃过期回包，避免回包错位

import { useEffect, useRef } from 'react';
import { query } from '../api/commands';
import { useSession } from '../state/session';

const PAGE_SIZE = 200;

export function useAutoQuery() {
  const { metadata, spec, setResult, setLoading, setError } = useSession();
  const reqId = useRef(0);

  useEffect(() => {
    if (!metadata) { setResult(null); return; }
    const my = ++reqId.current;
    setLoading(true);
    query(spec, 0, PAGE_SIZE)
      .then((r) => {
        if (my !== reqId.current) return;
        setResult(r);
        setError(null);
      })
      .catch((e) => {
        if (my !== reqId.current) return;
        setError(typeof e === 'string' ? e : JSON.stringify(e));
      })
      .finally(() => {
        if (my === reqId.current) setLoading(false);
      });
  }, [metadata, spec, setResult, setLoading, setError]);
}
```

- [ ] **Step 2：commit**

Run:
```bash
git add src/hooks
git commit -m "feat(fe): add useAutoQuery hook with stale-response guard"
```

---

### Task 12.2：StatsPanel

**Files:**
- Create: `src/components/StatsPanel.tsx`

- [ ] **Step 1：实现**

新建 `src/components/StatsPanel.tsx`：
```tsx
// 统计面板：总数 + 每级数量 + Top scopes（点击应用为筛选）

import { useSession } from '../state/session';
import type { LogLevel } from '../types/log';

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
      <div className="flex items-center gap-4 flex-wrap">
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

- [ ] **Step 2：commit**

Run:
```bash
git add src/components/StatsPanel.tsx
git commit -m "feat(fe): add StatsPanel with totals and clickable top scopes"
```

---

## Phase 13：LogList（虚拟列表）

### Task 13.1：实现虚拟列表

**Files:**
- Create: `src/components/LogList.tsx`

- [ ] **Step 1：实现**

新建 `src/components/LogList.tsx`：
```tsx
// 虚拟列表：滚动到第 N 页边界时按需 fetch 下一页
// MVP 简化：仅显示已 fetch 的条目；用 FixedSizeList 表达"占位高度 = total_matched"

import { useEffect, useRef, useState } from 'react';
import { FixedSizeList as List, ListChildComponentProps } from 'react-window';
import { getPage } from '../api/commands';
import { useSession } from '../state/session';
import type { LogEntry, LogLevel } from '../types/log';

const PAGE_SIZE = 200;
const ROW_HEIGHT = 28;

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-700',
  warn: 'text-amber-700',
  info: 'text-blue-700',
  debug: 'text-cyan-700',
  trace: 'text-slate-500',
  unknown: 'text-slate-400',
};

export function LogList() {
  const { spec, result } = useSession();
  // 全局条目缓冲：index → entry；空槽未加载
  const [entries, setEntries] = useState<(LogEntry | undefined)[]>([]);
  const pendingPages = useRef<Set<number>>(new Set());
  const seq = useRef(0);

  // spec 或文件变化时重置 + 注入首页
  useEffect(() => {
    seq.current++;
    pendingPages.current.clear();
    if (!result) { setEntries([]); return; }
    const arr = new Array<LogEntry | undefined>(result.total_matched);
    result.page_entries.forEach((e, i) => { arr[i] = e; });
    setEntries(arr);
  }, [result, spec]);

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

  const Row = ({ index, style }: ListChildComponentProps) => {
    const e = entries[index];
    if (!e) {
      const pageIdx = Math.floor(index / PAGE_SIZE);
      fetchPage(pageIdx);
      return <div style={style} className="px-2 text-slate-300 text-xs flex items-center">…</div>;
    }
    return (
      <div style={style} className="px-2 text-xs flex items-center gap-3 font-mono border-b border-slate-100">
        <span className="text-slate-400 w-12 text-right">#{e.line_no}</span>
        <span className="text-slate-500 w-40 truncate">{e.timestamp ?? '-'}</span>
        <span className={['w-12 uppercase', LEVEL_COLOR[e.level]].join(' ')}>{e.level}</span>
        <span className="text-slate-600 w-32 truncate">[{e.scope ?? '-'}]</span>
        <span className="flex-1 truncate">{e.message || e.raw}</span>
      </div>
    );
  };

  if (!result) return null;
  return (
    <div className="flex-1 overflow-hidden">
      <List
        height={Math.max(0, window.innerHeight - 220)}
        itemCount={result.total_matched}
        itemSize={ROW_HEIGHT}
        width="100%"
      >
        {Row}
      </List>
      <div className="px-3 py-1 text-xs text-slate-500 border-t bg-slate-50">
        匹配 {result.total_matched.toLocaleString()} 条
      </div>
    </div>
  );
}
```

- [ ] **Step 2：commit**

Run:
```bash
git add src/components/LogList.tsx
git commit -m "feat(fe): add virtualized LogList with on-demand paging"
```

---

### Task 13.2：装配进 App 并验证端到端

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1：装配组件 + 启用 useAutoQuery**

覆盖 `src/App.tsx`：
```tsx
import { OpenFileButton } from './components/OpenFileButton';
import { FilterBar } from './components/FilterBar';
import { StatsPanel } from './components/StatsPanel';
import { LogList } from './components/LogList';
import { useSession } from './state/session';
import { useAutoQuery } from './hooks/useAutoQuery';

export default function App() {
  const { metadata, loading, error } = useSession();
  useAutoQuery();

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 px-4 py-2 border-b bg-white">
        <h1 className="text-base font-semibold">Log Viewer</h1>
        <OpenFileButton />
        <div className="ml-auto text-xs text-slate-500">
          {metadata ? `${metadata.path} · ${metadata.total} 行 · 模板 ${metadata.template_id}` : '未打开文件'}
        </div>
      </header>
      {error && (
        <div className="px-4 py-2 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
      )}
      {metadata && <FilterBar />}
      {metadata && <StatsPanel />}
      {metadata ? <LogList /> : (
        <main className="flex-1 flex items-center justify-center text-slate-400">
          {loading ? '加载中…' : '点击"打开日志文件"开始'}
        </main>
      )}
    </div>
  );
}
```

- [ ] **Step 2：手动端到端验证**

Run:
```bash
npm run tauri dev
```

按以下清单验证：

- [ ] 点击"打开日志文件" → 选 `src-tauri/tests/fixtures/sample.jsonl`
- [ ] 顶部条显示路径、行数、模板
- [ ] 列表显示 5 条
- [ ] StatsPanel 显示 "总数 5  ERROR 1  WARN 1  INFO 2  DEBUG 1"
- [ ] 点击 level toggle "INFO" → 列表更新为 3 条（5 - 2）；统计同步刷新
- [ ] 关键词输入 "login" → 列表只剩 1 条；停手 150ms 内触发
- [ ] scope 输入 "auth" + mode "exact" → 列表显示 2 条 auth 条目
- [ ] 切换 scope mode 到 "glob" 并输入 "db.*" → 列表显示 2 条（db 和 db.pool）
- [ ] Top scope 中点击 "auth" → 自动应用为 scope 筛选

如任何步骤失败：停下来修，不要继续后续 Task。

- [ ] **Step 3：commit**

Run:
```bash
git add src/App.tsx
git commit -m "feat(fe): wire up MVP end-to-end flow"
```

---

## Phase 14：前端测试

### Task 14.1：vitest 配置 + 基础测试

**Files:**
- Modify: `package.json`、`vite.config.ts`
- Create: `vitest.setup.ts`、`src/__tests__/FilterBar.test.tsx`

- [ ] **Step 1：配置 vitest**

修改 `vite.config.ts`，在 `defineConfig` 内加 `test`：
```ts
// vite.config.ts 完整示例（脚手架版本）
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
});
```

新建 `vitest.setup.ts`：
```ts
import '@testing-library/jest-dom';
```

修改 `package.json` 的 `scripts`，加入：
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2：写一个 FilterBar 渲染测试**

新建 `src/__tests__/FilterBar.test.tsx`：
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { FilterBar } from '../components/FilterBar';
import { useSession } from '../state/session';

describe('FilterBar', () => {
  it('toggles level on click', () => {
    // 准备：先注入一个虚假 metadata 让 FilterBar 显示
    useSession.setState({
      metadata: {
        path: '/x', total: 0, time_range: null, level_counts: {},
        scopes: [], template_id: 'json-lines',
      },
      spec: { levels: ['info', 'warn'] },
    });

    render(<FilterBar />);
    const infoBtn = screen.getByRole('button', { name: /info/i });
    fireEvent.click(infoBtn);

    // INFO 被取消，预期 spec.levels 只剩 ['warn']
    const { spec } = useSession.getState();
    expect(spec.levels?.includes('info')).toBe(false);
    expect(spec.levels?.includes('warn')).toBe(true);
  });
});
```

- [ ] **Step 3：跑测试**

Run:
```bash
npm test
```

Expected: 1 个测试通过。

- [ ] **Step 4：commit**

Run:
```bash
git add vite.config.ts vitest.setup.ts package.json src/__tests__
git commit -m "test(fe): wire vitest and add FilterBar smoke test"
```

---

## Phase 15：MVP 收尾

### Task 15.1：跑全部测试 + 构建

- [ ] **Step 1：Rust 全测试**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri"
cargo test
```

Expected: 所有单测 + 集成测试通过，无 fail。

- [ ] **Step 2：前端测试**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
npm test
```

Expected: 通过。

- [ ] **Step 3：发布构建 smoke test（可选，耗时）**

Run:
```bash
npm run tauri build
```

Expected: 构建成功；产物在 `src-tauri/target/release/bundle/`。如不想等可跳过。

- [ ] **Step 4：补一个 README.md**

新建 `README.md`：
```markdown
# Log Viewer

桌面 GUI 日志查看与分析工具（Tauri + React + TypeScript）。

## 当前状态：Plan 1 MVP

已实现：
- 打开 JSON Lines 格式日志文件
- 按级别 / scope（exact/glob/regex）/ 时间区间 / 关键词筛选
- 虚拟滚动列表（按需分页）
- 总数 + level 分组 + Top scope 统计

未实现（见 Plan 2 / 3）：
- 其他解析模板（logfmt、python、bracket、nginx）
- 自动嗅探 + 自定义模板
- 实时跟踪（tail -f）
- 时间桶趋势图
- 详情抽屉、Sidebar、保存的筛选器、最近打开文件、导出、键盘快捷键

## 开发

```bash
npm install
npm run tauri dev
```

## 测试

```bash
# Rust
cd src-tauri && cargo test

# 前端
npm test
```
```

- [ ] **Step 5：commit**

Run:
```bash
git add README.md
git commit -m "docs: add README for MVP"
```

---

## 完成判定

Plan 1 完成的硬性条件（全部满足才算 done）：

- [ ] `cargo test`（含集成测试）全绿
- [ ] `npm test` 全绿
- [ ] `npm run tauri dev` 启动后，按 Task 13.2 的 9 项手动验证清单全部通过
- [ ] Git 历史按 phase / task 分散提交（不要一坨大 commit）

完成后可以告诉 Claude："Plan 1 完成，开始写 Plan 2"。Plan 2 会引入实时跟踪、其余解析模板、自动嗅探、自定义模板 UI、详情抽屉、时间桶趋势图。
