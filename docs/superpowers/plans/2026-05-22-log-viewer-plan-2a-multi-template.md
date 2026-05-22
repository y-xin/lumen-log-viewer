# Log Viewer — Plan 2a（多模板解析 + 嗅探 + 模板管理）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任意一种主流格式的日志文件（json-lines / bracket-electron / bracket-common / logfmt / python / nginx）打开后能被自动识别并正确解析；支持多行 entry 合并；提供模板管理 UI 与自定义正则模板。

**Architecture:** Plan 1 的 `ParserTemplate` trait 升级（加 `is_record_start`、`parse_record(lines)`），用统一的 `RegexTemplate` 实现 4 个内置模板，logfmt 独立专用解析器；新增 `sniff` 模块按命中率 + 字段完整度自动选模板；新增 `prefs` 模块持久化自定义模板到 `~/Library/Application Support/log-viewer/prefs.json`；前端加 `TemplateMenu` 顶部下拉 + `TemplateManagerDialog` 模态对话框。

**Tech Stack:** 复用 Plan 1（Tauri 2 · Rust · React · zustand）；Rust 新增 `json5` `directories`；前端无新增 npm 依赖。

**Spec：** [2026-05-22-log-viewer-plan2-design.md](../specs/2026-05-22-log-viewer-plan2-design.md)

---

## 文件结构（本 Plan 涉及的文件）

```
src-tauri/src/
├── model.rs                            (修改：LogEntry 加 line_count)
├── parser/
│   ├── mod.rs                          (修改：替换硬编码 JsonLines 为注册表 + sniff)
│   ├── template.rs                     (修改：trait 加 is_record_start, parse_record 签名变)
│   ├── json_lines.rs                   (修改：实现 is_record_start + 新签名)
│   ├── regex_template.rs               (新)
│   ├── tail_parser.rs                  (新)
│   ├── sniff.rs                        (新)
│   ├── registry.rs                     (新：全局模板注册表)
│   └── builtin/
│       ├── mod.rs                      (新)
│       ├── bracket_electron.rs         (新)
│       ├── bracket_common.rs           (新)
│       ├── python_default.rs           (新)
│       ├── nginx_combined.rs           (新)
│       └── logfmt.rs                   (新：独立专用解析器)
├── prefs/                              (新模块)
│   ├── mod.rs
│   └── store.rs
├── commands.rs                         (修改：+5 个模板管理 commands)
├── session/state.rs                    (修改：缓存 raw lines 以支持 reparse_with_template)
└── lib.rs                              (修改：注册新 commands + 启动时加载 prefs)

src-tauri/tests/
└── fixtures/
    ├── electron-multiline.log          (新)
    ├── bracket-common.log              (新)
    ├── python.log                      (新)
    ├── nginx-access.log                (新)
    ├── logfmt.log                      (新)
    └── mixed-noise.log                 (新)

src/
├── types/log.ts                        (修改：LogEntry.line_count + Template 类型)
├── api/commands.ts                     (修改：+5 个 invoke 封装)
├── components/
│   ├── TemplateMenu.tsx                (新：顶部下拉)
│   ├── TemplateManagerDialog.tsx       (新：管理模态)
│   └── LogList.tsx                     (修改：行号显示 #N-M)
├── state/session.ts                    (修改：+templates state + currentTemplateId)
└── App.tsx                             (修改：装 TemplateMenu + Dialog)
```

---

## Phase 0：数据模型迁移（line_count）

数据模型升级必须最先做，因为后续多行合并依赖此字段，所有现有测试构造 LogEntry 的地方都要补一个字段。

### Task 0.1：LogEntry 加 line_count 字段

**Files:**
- Modify: `src-tauri/src/model.rs`
- Modify: `src-tauri/src/parser/json_lines.rs`（PartialEntry 不变，但调整 finalize 默认逻辑）
- Modify: `src-tauri/src/parser/template.rs`（finalize 函数签名加 line_count）
- Modify: `src-tauri/src/parser/mod.rs`（parse_lines 每条赋 line_count=1）
- Modify: `src-tauri/src/session/state.rs`（dummy_entry 加 line_count）
- Modify: `src-tauri/src/query/filter.rs`（entry helper 加）
- Modify: `src-tauri/src/query/mod.rs`（e helper 加）
- Modify: `src-tauri/src/stats/aggregator.rs`（e helper 加）

- [ ] **Step 1：改 model.rs 加字段**

在 `src-tauri/src/model.rs` 的 `LogEntry` 结构体里，把：
```rust
pub struct LogEntry {
    pub line_no: u32,
    pub timestamp: Option<DateTime<Utc>>,
    pub level: LogLevel,
    pub scope: Option<String>,
    pub message: String,
    pub fields: HashMap<String, String>,
    pub raw: String,
}
```
改为：
```rust
pub struct LogEntry {
    pub line_no: u32,
    pub line_count: u32,    // NEW：占用的原始行数（单行 = 1，多行 ≥ 2）
    pub timestamp: Option<DateTime<Utc>>,
    pub level: LogLevel,
    pub scope: Option<String>,
    pub message: String,
    pub fields: HashMap<String, String>,
    pub raw: String,
}
```

并修改 `model.rs` 里的测试 `log_entry_roundtrips_through_serde` —— 在构造 LogEntry 时把 `line_no: 1,` 后加 `line_count: 1,`。

- [ ] **Step 2：改 parser/template.rs 的 finalize 签名**

把：
```rust
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
```
改为：
```rust
pub fn finalize(line_no: u32, line_count: u32, raw: &str, p: PartialEntry) -> LogEntry {
    LogEntry {
        line_no,
        line_count,
        timestamp: p.timestamp,
        level: p.level,
        scope: p.scope,
        message: p.message,
        fields: p.fields,
        raw: raw.to_string(),
    }
}
```

把 `fallback` 改为：
```rust
pub fn fallback(line_no: u32, line_count: u32, raw: &str) -> LogEntry {
    LogEntry {
        line_no,
        line_count,
        timestamp: None,
        level: crate::model::LogLevel::Unknown,
        scope: None,
        message: raw.to_string(),
        fields: std::collections::HashMap::new(),
        raw: raw.to_string(),
    }
}
```

- [ ] **Step 3：改 parser/mod.rs 调用 finalize/fallback 处加 1**

把 `parse_lines` 函数的 closure 里：
```rust
match tpl.parse_line(line) {
    Some(p) => finalize(line_no, line, p),
    None => fallback(line_no, line),
}
```
改为：
```rust
match tpl.parse_line(line) {
    Some(p) => finalize(line_no, 1, line, p),
    None => fallback(line_no, 1, line),
}
```
还有最上面：
```rust
if line.trim().is_empty() {
    return fallback(line_no, line);
}
```
改为：
```rust
if line.trim().is_empty() {
    return fallback(line_no, 1, line);
}
```

- [ ] **Step 4：改 session/state.rs 的 dummy_entry 加 line_count**

在 `src-tauri/src/session/state.rs` 的 tests 模块里，把：
```rust
fn dummy_entry(line: u32) -> LogEntry {
    LogEntry {
        line_no: line,
        timestamp: None,
        ...
```
在 `line_no: line,` 后插入一行 `line_count: 1,`。

- [ ] **Step 5：改 query/filter.rs 的 entry helper**

在 `src-tauri/src/query/filter.rs` 的 tests 模块里，`entry` 函数里把：
```rust
LogEntry {
    line_no: 1,
    timestamp: None,
    ...
```
在 `line_no: 1,` 后插入 `line_count: 1,`。

同一个文件里另一处 `LogEntry { line_no: 1, timestamp: None, ... }` 在 `scope_uses_fields_when_field_name_not_scope` 测试里，同样位置插入 `line_count: 1,`。

- [ ] **Step 6：改 query/mod.rs 的 e helper**

在 `src-tauri/src/query/mod.rs` 的 tests 模块里，`e` 函数里：
```rust
LogEntry {
    line_no: 0, timestamp: None, level, scope: scope.map(String::from),
    message: msg.into(), fields: HashMap::new(), raw: msg.into(),
}
```
改为：
```rust
LogEntry {
    line_no: 0, line_count: 1, timestamp: None, level, scope: scope.map(String::from),
    message: msg.into(), fields: HashMap::new(), raw: msg.into(),
}
```

- [ ] **Step 7：改 stats/aggregator.rs 的 e helper**

同样地，把：
```rust
LogEntry {
    line_no: 0, timestamp: None, level, scope: scope.map(String::from),
    message: String::new(), fields: HashMap::new(), raw: String::new(),
}
```
改为：
```rust
LogEntry {
    line_no: 0, line_count: 1, timestamp: None, level, scope: scope.map(String::from),
    message: String::new(), fields: HashMap::new(), raw: String::new(),
}
```

- [ ] **Step 8：跑全部测试验证迁移**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test
```

Expected: 31 lib + 1 integration tests 全部通过（数量不变，只是字段多了）。

- [ ] **Step 9：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{model.rs,parser,session,query,stats}
git commit -m "refactor(model): add line_count field to LogEntry (Plan 2a foundation)"
```

---

### Task 0.2：前端 TS 类型同步 + LogList 行号显示

**Files:**
- Modify: `src/types/log.ts`
- Modify: `src/components/LogList.tsx`

- [ ] **Step 1：TS 加字段**

在 `src/types/log.ts` 里 `LogEntry` 接口加 `line_count: number;`：
```ts
export interface LogEntry {
  line_no: number;
  line_count: number;           // NEW
  timestamp: string | null;
  level: LogLevel;
  scope: string | null;
  message: string;
  fields: Record<string, string>;
  raw: string;
}
```

- [ ] **Step 2：LogList 显示范围行号**

在 `src/components/LogList.tsx` 的 `Row` 组件里，把：
```tsx
<span className="text-slate-400 w-12 text-right">#{e.line_no}</span>
```
改为：
```tsx
<span className="text-slate-400 w-16 text-right">
  {e.line_count > 1 ? `#${e.line_no}-${e.line_no + e.line_count - 1}` : `#${e.line_no}`}
</span>
```

宽度从 `w-12` 调到 `w-16` 以容纳 `#1234-1236` 这种格式。

- [ ] **Step 3：验证前端构建**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -8
```

Expected: tsc + vite 全绿。

- [ ] **Step 4：commit**

```bash
git add src/types/log.ts src/components/LogList.tsx
git commit -m "feat(fe): expose line_count and display range line numbers"
```

---

## Phase 1：解析器架构升级（trait + 多行合并）

### Task 1.1：ParserTemplate trait 加 is_record_start，改 parse_record 签名

**Files:**
- Modify: `src-tauri/src/parser/template.rs`
- Modify: `src-tauri/src/parser/json_lines.rs`

- [ ] **Step 1：升级 trait**

把 `src-tauri/src/parser/template.rs` 里的 trait 改为：

```rust
// 解析模板抽象：所有内置 / 自定义模板都实现 ParserTemplate

use crate::model::LogEntry;

pub trait ParserTemplate: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    /// 判断一行是否是一条新日志的"起始行"。续行（不匹配的行）追加到前一条 entry 的 raw 里。
    fn is_record_start(&self, line: &str) -> bool;
    /// 在合并后的 N 行上解析（lines[0] 是起始行，lines[1..] 是续行）。
    /// 返回 None 表示无法解析，上层会用 fallback 兜底。
    fn parse_record(&self, lines: &[String]) -> Option<PartialEntry>;
}

pub struct PartialEntry {
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
    pub level: crate::model::LogLevel,
    pub scope: Option<String>,
    pub message: String,
    pub fields: std::collections::HashMap<String, String>,
}

pub fn finalize(line_no: u32, line_count: u32, raw: &str, p: PartialEntry) -> LogEntry {
    LogEntry {
        line_no,
        line_count,
        timestamp: p.timestamp,
        level: p.level,
        scope: p.scope,
        message: p.message,
        fields: p.fields,
        raw: raw.to_string(),
    }
}

pub fn fallback(line_no: u32, line_count: u32, raw: &str) -> LogEntry {
    LogEntry {
        line_no,
        line_count,
        timestamp: None,
        level: crate::model::LogLevel::Unknown,
        scope: None,
        message: raw.to_string(),
        fields: std::collections::HashMap::new(),
        raw: raw.to_string(),
    }
}
```

注意：旧的 `parse_line(&self, raw: &str)` 方法被 `parse_record(&self, lines: &[String])` 取代。trait 上的 `id` 和 `name` 由 `&'static str` 改为 `&str`（为自定义模板能用 `String` 字段，要求引用即可）。

- [ ] **Step 2：让 JsonLinesTemplate 实现新 trait**

覆盖 `src-tauri/src/parser/json_lines.rs`：

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
    fn id(&self) -> &str { "json-lines" }
    fn name(&self) -> &str { "JSON Lines" }

    fn is_record_start(&self, line: &str) -> bool {
        let t = line.trim();
        if !t.starts_with('{') { return false; }
        // 用一次 quick parse 判断是否是完整 JSON object（JSON Lines 不跨行）
        serde_json::from_str::<Value>(t).map(|v| v.is_object()).unwrap_or(false)
    }

    fn parse_record(&self, lines: &[String]) -> Option<PartialEntry> {
        // JSON Lines 不跨行：只看 lines[0]
        let raw = lines.first()?;
        let v: Value = serde_json::from_str(raw.trim()).ok()?;
        let obj = v.as_object()?;

        let timestamp = pick_str(obj, TIME_KEYS).and_then(|s| parse_time(&s));
        let level = pick_str(obj, LEVEL_KEYS)
            .map(|s| parse_level(&s))
            .unwrap_or(LogLevel::Unknown);
        let scope = pick_str(obj, SCOPE_KEYS);
        let message = pick_str(obj, MESSAGE_KEYS).unwrap_or_default();

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
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;

    fn p() -> JsonLinesTemplate { JsonLinesTemplate }
    fn lines(s: &str) -> Vec<String> { vec![s.to_string()] }

    #[test]
    fn parses_standard_line() {
        let raw = r#"{"time":"2026-05-22T09:00:00Z","level":"info","logger":"auth","msg":"hi","x":1}"#;
        let r = p().parse_record(&lines(raw)).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("auth"));
        assert_eq!(r.message, "hi");
        assert!(r.timestamp.is_some());
        assert_eq!(r.fields.get("x").map(|s| s.as_str()), Some("1"));
    }

    #[test]
    fn supports_alternate_keys() {
        let raw = r#"{"ts":"2026-05-22T09:00:00Z","severity":"WARN","module":"db","message":"slow"}"#;
        let r = p().parse_record(&lines(raw)).unwrap();
        assert_eq!(r.level, LogLevel::Warn);
        assert_eq!(r.scope.as_deref(), Some("db"));
        assert_eq!(r.message, "slow");
    }

    #[test]
    fn returns_none_on_garbage() {
        assert!(p().parse_record(&lines("this is not json")).is_none());
        assert!(p().parse_record(&lines("")).is_none());
    }

    #[test]
    fn missing_level_yields_unknown() {
        let raw = r#"{"msg":"hi"}"#;
        let r = p().parse_record(&lines(raw)).unwrap();
        assert_eq!(r.level, LogLevel::Unknown);
    }

    #[test]
    fn is_record_start_detects_json_object() {
        assert!(p().is_record_start(r#"{"a":1}"#));
        assert!(p().is_record_start(r#"  {"a":1}  "#));
        assert!(!p().is_record_start("garbage"));
        assert!(!p().is_record_start(""));
        assert!(!p().is_record_start(r#"[1,2,3]"#));   // 数组不是 object
    }
}
```

- [ ] **Step 3：跑测试**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::
```

Expected: 5 个 json_lines 测试 + 2 个 level 测试 + 2 个 parser::tests 测试，共 9 pass（json_lines 比 Plan 1 多了一个 `is_record_start_detects_json_object`）。

- [ ] **Step 4：commit**

```bash
git add src-tauri/src/parser/template.rs src-tauri/src/parser/json_lines.rs
git commit -m "refactor(parser): upgrade trait with is_record_start + parse_record(lines)"
```

---

### Task 1.2：多行合并算法 group_records

**Files:**
- Create: `src-tauri/src/parser/grouping.rs`
- Modify: `src-tauri/src/parser/mod.rs`（声明子模块）

- [ ] **Step 1：写 group_records + 测试**

新建 `src-tauri/src/parser/grouping.rs`：

```rust
// 行合并：按当前模板的 is_record_start 切分原始行为"逻辑日志"

use crate::parser::template::ParserTemplate;

pub struct RawRecord {
    pub start_line: u32,     // 1-based
    pub lines: Vec<String>,
}

pub fn group_records<T: ParserTemplate + ?Sized>(tpl: &T, lines: &[String]) -> Vec<RawRecord> {
    let mut out: Vec<RawRecord> = Vec::new();
    let mut current: Option<RawRecord> = None;

    for (i, line) in lines.iter().enumerate() {
        let is_start = tpl.is_record_start(line);
        if is_start || current.is_none() {
            if let Some(r) = current.take() {
                out.push(r);
            }
            current = Some(RawRecord {
                start_line: (i + 1) as u32,
                lines: vec![line.clone()],
            });
        } else if let Some(r) = current.as_mut() {
            r.lines.push(line.clone());
        }
    }
    if let Some(r) = current {
        out.push(r);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::template::{ParserTemplate, PartialEntry};

    /// 模拟一个"以 [ 开头判断起始"的模板
    struct DummyTpl;
    impl ParserTemplate for DummyTpl {
        fn id(&self) -> &str { "dummy" }
        fn name(&self) -> &str { "Dummy" }
        fn is_record_start(&self, line: &str) -> bool { line.starts_with('[') }
        fn parse_record(&self, _: &[String]) -> Option<PartialEntry> { None }
    }

    fn s(v: &str) -> String { v.to_string() }

    #[test]
    fn single_line_records() {
        let lines = vec![s("[a]"), s("[b]"), s("[c]")];
        let r = group_records(&DummyTpl, &lines);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].start_line, 1);
        assert_eq!(r[1].start_line, 2);
        assert_eq!(r[2].start_line, 3);
    }

    #[test]
    fn multiline_record_merged() {
        let lines = vec![s("[a]"), s("  cont1"), s("  cont2"), s("[b]")];
        let r = group_records(&DummyTpl, &lines);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].start_line, 1);
        assert_eq!(r[0].lines, vec!["[a]", "  cont1", "  cont2"]);
        assert_eq!(r[1].start_line, 4);
        assert_eq!(r[1].lines, vec!["[b]"]);
    }

    #[test]
    fn orphan_leading_lines_form_single_record() {
        // 文件开头若无起始行（比如被 truncated 头部），前几行包成一条
        let lines = vec![s("orphan1"), s("orphan2"), s("[a]")];
        let r = group_records(&DummyTpl, &lines);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].start_line, 1);
        assert_eq!(r[0].lines, vec!["orphan1", "orphan2"]);
        assert_eq!(r[1].start_line, 3);
    }

    #[test]
    fn empty_input_yields_empty() {
        let r = group_records(&DummyTpl, &[]);
        assert!(r.is_empty());
    }
}
```

- [ ] **Step 2：在 parser/mod.rs 声明子模块**

在 `src-tauri/src/parser/mod.rs` 的最顶部，把：
```rust
pub mod template;
pub mod json_lines;
pub mod level;
```
改为：
```rust
pub mod template;
pub mod json_lines;
pub mod level;
pub mod grouping;
```

- [ ] **Step 3：跑测试**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::grouping::
```

Expected: 4 pass。

- [ ] **Step 4：commit**

```bash
git add src-tauri/src/parser/{mod.rs,grouping.rs}
git commit -m "feat(parser): add multi-line record grouping"
```

---

### Task 1.3：parse_lines 改为两阶段（合并 + 解析）

**Files:**
- Modify: `src-tauri/src/parser/mod.rs`

- [ ] **Step 1：重写 parse_lines**

打开 `src-tauri/src/parser/mod.rs`，把现在的 `parse_lines` 函数体替换为：

```rust
/// 用指定模板对 lines 做两阶段解析：先按 is_record_start 合并，再并行解析。
pub fn parse_with_template<T: ParserTemplate + ?Sized + Sync>(
    tpl: &T, lines: &[String],
) -> Vec<LogEntry> {
    use grouping::group_records;
    let records = group_records(tpl, lines);

    records.par_iter().map(|r| {
        let line_count = r.lines.len() as u32;
        let raw_joined = r.lines.join("\n");
        match tpl.parse_record(&r.lines) {
            Some(p) => template::finalize(r.start_line, line_count, &raw_joined, p),
            None    => template::fallback(r.start_line, line_count, &raw_joined),
        }
    }).collect()
}

/// MVP 兼容入口：用 JsonLinesTemplate 解析。Task 4.2 会被 sniff-based 入口取代。
pub fn parse_lines(lines: &[String]) -> Vec<LogEntry> {
    parse_with_template(&JsonLinesTemplate, lines)
}
```

此时 `src-tauri/src/parser/mod.rs` 应为下面这样（**注意：后续 task（2.1 / 2.2 / 3.1 / 4.1 / 4.2）会陆续向顶部模块声明区追加 `tail_parser` / `regex_template` / `builtin` / `registry` / `sniff`，按各自 task 指示再加，不要现在一次性都加上**）：

```rust
pub mod template;
pub mod json_lines;
pub mod level;
pub mod grouping;

use crate::model::{FileMetadata, LogEntry, LogLevel};
use grouping::group_records;
use json_lines::JsonLinesTemplate;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use template::ParserTemplate;

/// 用指定模板对 lines 做两阶段解析：先按 is_record_start 合并，再并行解析。
pub fn parse_with_template<T: ParserTemplate + ?Sized + Sync>(
    tpl: &T, lines: &[String],
) -> Vec<LogEntry> {
    let records = group_records(tpl, lines);
    records.par_iter().map(|r| {
        let line_count = r.lines.len() as u32;
        let raw_joined = r.lines.join("\n");
        match tpl.parse_record(&r.lines) {
            Some(p) => template::finalize(r.start_line, line_count, &raw_joined, p),
            None    => template::fallback(r.start_line, line_count, &raw_joined),
        }
    }).collect()
}

/// MVP 兼容入口：用 JsonLinesTemplate 解析。Task 4.2 后会被 sniff-based 入口取代。
pub fn parse_lines(lines: &[String]) -> Vec<LogEntry> {
    parse_with_template(&JsonLinesTemplate, lines)
}

pub fn compute_metadata(path: &str, entries: &[LogEntry], template_id: &str) -> FileMetadata {
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
        template_id: template_id.to_string(),
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
        assert_eq!(r[0].line_count, 1);
        assert_eq!(r[1].level, LogLevel::Unknown);
        assert_eq!(r[1].raw, "garbage line");
        assert_eq!(r[2].level, LogLevel::Unknown);
    }

    #[test]
    fn metadata_collects_scopes_and_time_range() {
        let lines = vec![
            r#"{"time":"2026-05-22T09:00:00Z","level":"info","logger":"a","msg":"x"}"#.to_string(),
            r#"{"time":"2026-05-22T10:00:00Z","level":"warn","logger":"b","msg":"y"}"#.to_string(),
        ];
        let entries = parse_lines(&lines);
        let m = compute_metadata("/tmp/x.jsonl", &entries, "json-lines");
        assert_eq!(m.total, 2);
        assert_eq!(m.scopes, vec!["a".to_string(), "b".to_string()]);
        assert!(m.time_range.is_some());
        assert_eq!(m.template_id, "json-lines");
    }
}
```

注意 `compute_metadata` 多了 `template_id: &str` 参数（原来硬编码 `"json-lines"`）。

- [ ] **Step 2：commands.rs 调用 compute_metadata 处补 template_id**

打开 `src-tauri/src/commands.rs`，把 `cmd_open_file` 里：
```rust
let metadata = parser::compute_metadata(&path, &entries);
```
改为：
```rust
let metadata = parser::compute_metadata(&path, &entries, "json-lines");
```

（Task 4.2 后会被嗅探结果替换。）

- [ ] **Step 3：跑全部测试**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test
```

Expected: 全部通过（含集成测试）。

- [ ] **Step 4：commit**

```bash
git add src-tauri/src/parser/mod.rs src-tauri/src/commands.rs
git commit -m "refactor(parser): two-phase parse (group + parse) with template_id metadata"
```

---

## Phase 2：通用 RegexTemplate + TailParser

### Task 2.1：TailParser（JSON / JSON5）

**Files:**
- Create: `src-tauri/src/parser/tail_parser.rs`
- Modify: `src-tauri/src/parser/mod.rs`（声明子模块）
- Modify: `src-tauri/Cargo.toml`（加 `json5 = "0.4"`）

- [ ] **Step 1：加依赖**

打开 `src-tauri/Cargo.toml`，在 `[dependencies]` 里加：
```toml
json5 = "0.4"
```

- [ ] **Step 2：写 tail_parser**

新建 `src-tauri/src/parser/tail_parser.rs`：

```rust
// 尾部 JSON / JSON5 块解析：用于 bracket-electron 这种 message 尾部带 { ... } 的格式

use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
pub enum TailParserKind {
    JsonObject,   // 仅尝试严格 JSON
    JsonLike,     // 先 JSON 后 JSON5；都失败放 _raw_tail
}

/// 从合并后的 raw 文本里找尾部 {...} 块（含换行），解析为字符串化的 key-value。
/// 找不到 {...} 返回 None；找到了但解析失败 → 按 kind 决定是否放 _raw_tail。
///
/// 返回值：(剩余 message 部分, 解析出的 fields)
pub fn parse_tail(raw: &str, kind: TailParserKind) -> (String, HashMap<String, String>) {
    let Some((head, tail)) = split_tail_brace(raw) else {
        return (raw.trim().to_string(), HashMap::new());
    };

    // 先严格 JSON
    if let Ok(v) = serde_json::from_str::<Value>(tail) {
        if let Some(obj) = v.as_object() {
            return (head.trim().to_string(), object_to_map(obj));
        }
    }

    // JsonLike：再试 json5
    if matches!(kind, TailParserKind::JsonLike) {
        if let Ok(v) = json5::from_str::<Value>(tail) {
            if let Some(obj) = v.as_object() {
                return (head.trim().to_string(), object_to_map(obj));
            }
        }
        // 都失败：保留 _raw_tail
        let mut m = HashMap::new();
        m.insert("_raw_tail".to_string(), tail.to_string());
        return (head.trim().to_string(), m);
    }

    // JsonObject 严格模式失败：把 tail 视作 message 一部分
    (raw.trim().to_string(), HashMap::new())
}

/// 找最右侧的"配对花括号块"。返回 (head, tail) — tail 含外层 {}。
/// 简单平衡计数：从右向左扫描遇 `}` 计 1，遇 `{` 计 -1，回到 0 就是开头。
fn split_tail_brace(raw: &str) -> Option<(&str, &str)> {
    let bytes = raw.as_bytes();
    if !raw.trim_end().ends_with('}') { return None; }
    // 从字符串末尾扫描
    let mut depth: i32 = 0;
    let mut end = raw.trim_end().len();
    // 去掉末尾空白
    while end > 0 && bytes[end - 1].is_ascii_whitespace() { end -= 1; }
    if end == 0 || bytes[end - 1] != b'}' { return None; }

    let mut i = end;
    while i > 0 {
        i -= 1;
        match bytes[i] {
            b'}' => depth += 1,
            b'{' => {
                depth -= 1;
                if depth == 0 {
                    return Some((&raw[..i], &raw[i..end]));
                }
            }
            _ => {}
        }
    }
    None
}

fn object_to_map(obj: &serde_json::Map<String, Value>) -> HashMap<String, String> {
    obj.iter().map(|(k, v)| (k.clone(), stringify(v))).collect()
}

fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_strict_json_tail() {
        let raw = r#"service started {"feedUrl":"https://x","channel":"latest"}"#;
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonLike);
        assert_eq!(msg, "service started");
        assert_eq!(fields.get("feedUrl").map(String::as_str), Some("https://x"));
        assert_eq!(fields.get("channel").map(String::as_str), Some("latest"));
    }

    #[test]
    fn extracts_json5_tail_with_single_quotes() {
        let raw = r#"端口已注册 { source: 'main', id: 'main', userId: '' }"#;
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonLike);
        assert_eq!(msg, "端口已注册");
        assert_eq!(fields.get("source").map(String::as_str), Some("main"));
        assert_eq!(fields.get("id").map(String::as_str), Some("main"));
        assert_eq!(fields.get("userId").map(String::as_str), Some(""));
    }

    #[test]
    fn multiline_tail_works() {
        let raw = "service started {\n  feedUrl: 'https://x',\n  channel: 'latest'\n}";
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonLike);
        assert_eq!(msg, "service started");
        assert_eq!(fields.get("feedUrl").map(String::as_str), Some("https://x"));
    }

    #[test]
    fn unparseable_tail_kept_as_raw_in_jsonlike() {
        let raw = "msg {this is not valid json or json5 at all $$$}";
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonLike);
        assert_eq!(msg, "msg");
        assert!(fields.contains_key("_raw_tail"));
    }

    #[test]
    fn no_brace_returns_full_message_and_empty_fields() {
        let raw = "just a plain message";
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonLike);
        assert_eq!(msg, "just a plain message");
        assert!(fields.is_empty());
    }

    #[test]
    fn json_object_mode_drops_unparseable_tail_into_message() {
        let raw = "msg {invalid}";
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonObject);
        // 严格模式：解析失败时不创建 _raw_tail
        assert_eq!(msg, raw.trim());
        assert!(fields.is_empty());
    }
}
```

- [ ] **Step 3：在 parser/mod.rs 声明子模块**

在 `src-tauri/src/parser/mod.rs` 顶部模块声明里加 `pub mod tail_parser;`：

```rust
pub mod template;
pub mod json_lines;
pub mod level;
pub mod grouping;
pub mod tail_parser;
```

- [ ] **Step 4：跑测试**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::tail_parser::
```

Expected: 6 pass。

- [ ] **Step 5：commit**

```bash
git add src-tauri/src/parser/{mod.rs,tail_parser.rs} src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(parser): tail JSON/JSON5 extractor with multiline + raw fallback"
```

---

### Task 2.2：通用 RegexTemplate

**Files:**
- Create: `src-tauri/src/parser/regex_template.rs`
- Modify: `src-tauri/src/parser/mod.rs`

- [ ] **Step 1：写 RegexTemplate**

新建 `src-tauri/src/parser/regex_template.rs`：

```rust
// 通用正则模板：所有 bracket-* / python-* / nginx-* 共用

use crate::model::LogLevel;
use crate::parser::level::parse_level;
use crate::parser::tail_parser::{parse_tail, TailParserKind};
use crate::parser::template::{ParserTemplate, PartialEntry};
use chrono::{DateTime, NaiveDateTime, Utc};
use regex::Regex;
use std::collections::HashMap;

/// 字段映射：每个 LogEntry 字段对应正则里的哪个命名捕获组
#[derive(Debug, Clone)]
pub struct FieldMap {
    pub timestamp: Option<String>,   // 如果该模板无 timestamp 捕获，置 None
    pub level: Option<String>,
    pub scope: Option<String>,
    pub message: Option<String>,
}

pub struct RegexTemplate {
    pub id: String,
    pub name: String,
    pub pattern: Regex,
    pub start_pattern: Regex,
    pub time_formats: Vec<String>,
    pub field_map: FieldMap,
    pub tail: Option<TailParserKind>,
}

impl ParserTemplate for RegexTemplate {
    fn id(&self) -> &str { &self.id }
    fn name(&self) -> &str { &self.name }

    fn is_record_start(&self, line: &str) -> bool {
        self.start_pattern.is_match(line)
    }

    fn parse_record(&self, lines: &[String]) -> Option<PartialEntry> {
        let head = lines.first()?;
        let caps = self.pattern.captures(head)?;

        let timestamp = self.field_map.timestamp.as_ref()
            .and_then(|name| caps.name(name).map(|m| m.as_str()))
            .and_then(|s| parse_timestamp(s, &self.time_formats));

        let level = self.field_map.level.as_ref()
            .and_then(|name| caps.name(name).map(|m| parse_level(m.as_str())))
            .unwrap_or(LogLevel::Unknown);

        let scope = self.field_map.scope.as_ref()
            .and_then(|name| caps.name(name).map(|m| m.as_str().to_string()));

        let raw_message = self.field_map.message.as_ref()
            .and_then(|name| caps.name(name).map(|m| m.as_str().to_string()))
            .unwrap_or_default();

        // 多行场景：把 lines[1..] 附加到 raw_message 后面再走 tail 解析
        let combined_message = if lines.len() > 1 {
            let mut s = raw_message;
            for cont in &lines[1..] {
                s.push('\n');
                s.push_str(cont);
            }
            s
        } else {
            raw_message
        };

        let (message, fields) = match self.tail {
            Some(kind) => parse_tail(&combined_message, kind),
            None       => (combined_message.trim().to_string(), HashMap::new()),
        };

        Some(PartialEntry { timestamp, level, scope, message, fields })
    }
}

fn parse_timestamp(s: &str, formats: &[String]) -> Option<DateTime<Utc>> {
    let s = s.trim();
    // 优先 RFC3339（带时区）
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    // 否则按候选格式（无时区，假定 UTC）
    for fmt in formats {
        if let Ok(ndt) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::tail_parser::TailParserKind;

    fn tpl_3field() -> RegexTemplate {
        RegexTemplate {
            id: "t".into(),
            name: "T".into(),
            pattern: Regex::new(r"^\[(?P<ts>[^\]]+)\] \[(?P<level>[^\]]+)\] (?P<message>.*)$").unwrap(),
            start_pattern: Regex::new(r"^\[\d{4}").unwrap(),
            time_formats: vec!["%Y-%m-%d %H:%M:%S%.3f".into()],
            field_map: FieldMap {
                timestamp: Some("ts".into()),
                level: Some("level".into()),
                scope: None,
                message: Some("message".into()),
            },
            tail: None,
        }
    }

    fn lines(s: &str) -> Vec<String> { vec![s.to_string()] }

    #[test]
    fn parses_basic_three_field_line() {
        let t = tpl_3field();
        let r = t.parse_record(&lines("[2026-05-22 09:00:00.123] [info] hello")).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.message, "hello");
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn is_record_start_uses_start_pattern() {
        let t = tpl_3field();
        assert!(t.is_record_start("[2026-05-22 09:00:00.123] [info] hi"));
        assert!(!t.is_record_start("  continuation line"));
    }

    #[test]
    fn unmatched_line_returns_none() {
        let t = tpl_3field();
        assert!(t.parse_record(&lines("garbage")).is_none());
    }

    #[test]
    fn merges_multiline_into_message_when_no_tail_parser() {
        let t = tpl_3field();
        let lines = vec!["[2026-05-22 09:00:00.123] [info] head".to_string(), "continuation".to_string()];
        let r = t.parse_record(&lines).unwrap();
        // 没有 tail parser：lines 拼接到 message
        assert!(r.message.starts_with("head"));
        assert!(r.message.contains("continuation"));
    }

    #[test]
    fn rfc3339_timestamp_works() {
        let mut t = tpl_3field();
        t.time_formats.clear(); // 完全靠 RFC3339
        let r = t.parse_record(&lines("[2026-05-22T09:00:00Z] [info] x")).unwrap();
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn tail_parser_extracts_fields() {
        let t = RegexTemplate {
            id: "t2".into(),
            name: "T2".into(),
            pattern: Regex::new(r"^\[(?P<ts>[^\]]+)\] \[(?P<level>[^\]]+)\] \((?P<scope>[^\)]+)\) (?P<message>.*)$").unwrap(),
            start_pattern: Regex::new(r"^\[\d").unwrap(),
            time_formats: vec!["%Y-%m-%d %H:%M:%S%.3f".into()],
            field_map: FieldMap {
                timestamp: Some("ts".into()),
                level: Some("level".into()),
                scope: Some("scope".into()),
                message: Some("message".into()),
            },
            tail: Some(TailParserKind::JsonLike),
        };
        let r = t.parse_record(&lines(r#"[2026-05-22 09:00:00.123] [info] (network) 端口已注册 { source: 'main', id: 'main' }"#)).unwrap();
        assert_eq!(r.scope.as_deref(), Some("network"));
        assert_eq!(r.message, "端口已注册");
        assert_eq!(r.fields.get("source").map(String::as_str), Some("main"));
    }
}
```

- [ ] **Step 2：声明子模块**

`src-tauri/src/parser/mod.rs` 顶部加 `pub mod regex_template;`。

- [ ] **Step 3：跑测试**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::regex_template::
```

Expected: 6 pass。

- [ ] **Step 4：commit**

```bash
git add src-tauri/src/parser/{mod.rs,regex_template.rs}
git commit -m "feat(parser): generic RegexTemplate with field_map + tail parser"
```

---

## Phase 3：5 个内置模板 + fixtures

### Task 3.1：bracket-electron 模板 + fixture

**Files:**
- Create: `src-tauri/src/parser/builtin/mod.rs`
- Create: `src-tauri/src/parser/builtin/bracket_electron.rs`
- Create: `src-tauri/tests/fixtures/electron-multiline.log`
- Modify: `src-tauri/src/parser/mod.rs`

- [ ] **Step 1：建 builtin 模块**

新建 `src-tauri/src/parser/builtin/mod.rs`：

```rust
// 内置模板集合：每个文件导出一个工厂函数返回 RegexTemplate

pub mod bracket_electron;
pub mod bracket_common;
pub mod python_default;
pub mod nginx_combined;
pub mod logfmt;
```

注意先全部声明，后续 task 各自填实现。先创建空文件让编译过：

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri/src/parser"
mkdir -p builtin
touch builtin/{bracket_electron,bracket_common,python_default,nginx_combined,logfmt}.rs
```

每个空文件加占位：

`bracket_electron.rs`、`bracket_common.rs`、`python_default.rs`、`nginx_combined.rs`、`logfmt.rs` 都写：
```rust
// 占位，本 task 之后由各模板专属 task 填实现
```

在 `src-tauri/src/parser/mod.rs` 顶部加 `pub mod builtin;`。

- [ ] **Step 2：写 bracket-electron 工厂函数**

覆盖 `src-tauri/src/parser/builtin/bracket_electron.rs`：

```rust
// bracket-electron 模板：Electron 应用 (electron-log) 风格
// 样例：[2026-05-21 17:26:37.566] [info] (main/network-manager) message {fields...}

use crate::parser::regex_template::{FieldMap, RegexTemplate};
use crate::parser::tail_parser::TailParserKind;
use regex::Regex;

pub fn template() -> RegexTemplate {
    RegexTemplate {
        id: "bracket-electron".into(),
        name: "Bracket (Electron)".into(),
        pattern: Regex::new(
            r"^\[(?P<ts>[^\]]+)\] \[(?P<level>[^\]]+)\] \((?P<scope>[^\)]+)\) (?P<message>.*)$"
        ).unwrap(),
        start_pattern: Regex::new(r"^\[\d{4}-\d{2}-\d{2}[ T]").unwrap(),
        time_formats: vec![
            "%Y-%m-%d %H:%M:%S%.3f".into(),
            "%Y-%m-%dT%H:%M:%S%.fZ".into(),
            "%Y-%m-%d %H:%M:%S".into(),
        ],
        field_map: FieldMap {
            timestamp: Some("ts".into()),
            level: Some("level".into()),
            scope: Some("scope".into()),
            message: Some("message".into()),
        },
        tail: Some(TailParserKind::JsonLike),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;
    use crate::parser::template::ParserTemplate;

    #[test]
    fn parses_single_line() {
        let t = template();
        let raw = "[2026-05-21 17:26:37.566] [info] (main/network-manager) 启动网络进程";
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("main/network-manager"));
        assert_eq!(r.message, "启动网络进程");
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn parses_with_strict_json_tail() {
        let t = template();
        let raw = r#"[2026-05-21 17:26:37.760] [info] (gost-api) GET /config → 200 {"status":200}"#;
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.fields.get("status").map(String::as_str), Some("200"));
    }

    #[test]
    fn parses_with_js_style_json_tail() {
        let t = template();
        let raw = r#"[2026-05-21 17:26:37.624] [info] (network) 端口已注册 { source: 'main', id: 'main', userId: '' }"#;
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.message, "端口已注册");
        assert_eq!(r.fields.get("source").map(String::as_str), Some("main"));
        assert_eq!(r.fields.get("userId").map(String::as_str), Some(""));
    }

    #[test]
    fn parses_multiline_record() {
        let t = template();
        let lines = vec![
            "[2026-05-21 17:26:37.760] [info] (app-update) service started {".to_string(),
            "  feedUrl: 'https://djs-download.s3.ap-southeast-1.amazonaws.com/releases/dujiaoshou/',".to_string(),
            "  channel: 'latest'".to_string(),
            "}".to_string(),
        ];
        let r = t.parse_record(&lines).unwrap();
        assert_eq!(r.scope.as_deref(), Some("app-update"));
        assert_eq!(r.message, "service started");
        assert_eq!(r.fields.get("channel").map(String::as_str), Some("latest"));
    }

    #[test]
    fn is_record_start_matches_bracket_date() {
        let t = template();
        assert!(t.is_record_start("[2026-05-21 17:26:37.566] [info] (x) y"));
        assert!(!t.is_record_start("  continuation"));
        assert!(!t.is_record_start("garbage"));
    }
}
```

- [ ] **Step 3：写 fixture**

新建 `src-tauri/tests/fixtures/electron-multiline.log`：

```
[2026-05-21 17:26:37.566] [info] (main/network-manager) 启动网络进程 {"scriptPath":"/Users/x/scrm/proxy/network.js"}
[2026-05-21 17:26:37.576] [info] (main/network-manager) 网络进程已启动
[2026-05-21 17:26:37.577] [info] (main/network-manager) main-port 已建立
[2026-05-21 17:26:37.623] [info] (network) 网络进程已初始化
[2026-05-21 17:26:37.624] [info] (network) 端口已注册 { source: 'main', id: 'main', userId: '' }
[2026-05-21 17:26:37.760] [info] (app-update) service started {
  feedUrl: 'https://djs-download.s3.ap-southeast-1.amazonaws.com/releases/dujiaoshou/',
  channel: 'latest'
}
[2026-05-21 17:26:38.123] [warn] (gost) {"caller":"parsing/tls.go:57","level":"debug","msg":"load global TLS certificate files failed"}
[2026-05-21 17:26:38.456] [error] (auth) login failed for user 42
```

- [ ] **Step 4：跑测试**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::builtin::bracket_electron::
```

Expected: 5 pass。

- [ ] **Step 5：commit**

```bash
git add src-tauri/src/parser/{mod.rs,builtin} src-tauri/tests/fixtures/electron-multiline.log
git commit -m "feat(parser): bracket-electron template + multiline electron-log fixture"
```

---

### Task 3.2：bracket-common 模板 + fixture

**Files:**
- Modify: `src-tauri/src/parser/builtin/bracket_common.rs`
- Create: `src-tauri/tests/fixtures/bracket-common.log`

- [ ] **Step 1：写模板**

覆盖 `src-tauri/src/parser/builtin/bracket_common.rs`：

```rust
// bracket-common 模板：Java logback / Go zap 默认风格
// 样例：2026-05-22 12:00:00 [INFO] [auth] login ok

use crate::parser::regex_template::{FieldMap, RegexTemplate};
use regex::Regex;

pub fn template() -> RegexTemplate {
    RegexTemplate {
        id: "bracket-common".into(),
        name: "Bracket (Common)".into(),
        pattern: Regex::new(
            r"^(?P<ts>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?) \[(?P<level>[^\]]+)\] \[(?P<scope>[^\]]+)\] (?P<message>.*)$"
        ).unwrap(),
        start_pattern: Regex::new(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}").unwrap(),
        time_formats: vec![
            "%Y-%m-%d %H:%M:%S%.3f".into(),
            "%Y-%m-%d %H:%M:%S".into(),
            "%Y-%m-%dT%H:%M:%S%.fZ".into(),
        ],
        field_map: FieldMap {
            timestamp: Some("ts".into()),
            level: Some("level".into()),
            scope: Some("scope".into()),
            message: Some("message".into()),
        },
        tail: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;
    use crate::parser::template::ParserTemplate;

    #[test]
    fn parses_typical_line() {
        let t = template();
        let r = t.parse_record(&["2026-05-22 12:00:00 [INFO] [auth] login ok".to_string()]).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("auth"));
        assert_eq!(r.message, "login ok");
    }

    #[test]
    fn parses_with_milliseconds() {
        let t = template();
        let r = t.parse_record(&["2026-05-22 12:00:00.123 [WARN] [db] slow query".to_string()]).unwrap();
        assert_eq!(r.level, LogLevel::Warn);
        assert_eq!(r.scope.as_deref(), Some("db"));
    }

    #[test]
    fn is_record_start_matches_iso_date() {
        let t = template();
        assert!(t.is_record_start("2026-05-22 12:00:00 [INFO] [x] y"));
        assert!(!t.is_record_start("  continuation"));
    }
}
```

- [ ] **Step 2：写 fixture**

新建 `src-tauri/tests/fixtures/bracket-common.log`：

```
2026-05-22 12:00:00 [INFO] [auth] login ok
2026-05-22 12:00:01.123 [WARN] [db] slow query 1.2s
2026-05-22 12:00:02.456 [ERROR] [auth] token invalid for user 42
2026-05-22 12:00:03 [DEBUG] [db.pool] acquire conn
2026-05-22 12:00:04 [INFO] [http] GET /api/users 200
```

- [ ] **Step 3：测试 + commit**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::builtin::bracket_common::
```

Expected: 3 pass。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/parser/builtin/bracket_common.rs src-tauri/tests/fixtures/bracket-common.log
git commit -m "feat(parser): bracket-common template + fixture"
```

---

### Task 3.3：python-default 模板 + fixture

**Files:**
- Modify: `src-tauri/src/parser/builtin/python_default.rs`
- Create: `src-tauri/tests/fixtures/python.log`

- [ ] **Step 1：写模板**

覆盖 `src-tauri/src/parser/builtin/python_default.rs`：

```rust
// python-default 模板：Python logging 默认 BASIC_FORMAT
// 样例：2026-05-22 12:00:00,123 - auth - INFO - login ok

use crate::parser::regex_template::{FieldMap, RegexTemplate};
use regex::Regex;

pub fn template() -> RegexTemplate {
    RegexTemplate {
        id: "python-default".into(),
        name: "Python logging".into(),
        pattern: Regex::new(
            r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d+)?) - (?P<scope>[^\s]+) - (?P<level>[A-Z]+) - (?P<message>.*)$"
        ).unwrap(),
        start_pattern: Regex::new(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}").unwrap(),
        time_formats: vec![
            "%Y-%m-%d %H:%M:%S,%3f".into(),
            "%Y-%m-%d %H:%M:%S".into(),
        ],
        field_map: FieldMap {
            timestamp: Some("ts".into()),
            level: Some("level".into()),
            scope: Some("scope".into()),
            message: Some("message".into()),
        },
        tail: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;
    use crate::parser::template::ParserTemplate;

    #[test]
    fn parses_typical_line() {
        let t = template();
        let r = t.parse_record(&["2026-05-22 12:00:00,123 - auth - INFO - login ok".to_string()]).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("auth"));
        assert_eq!(r.message, "login ok");
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn parses_without_milliseconds() {
        let t = template();
        let r = t.parse_record(&["2026-05-22 12:00:00 - db.pool - DEBUG - acquire".to_string()]).unwrap();
        assert_eq!(r.level, LogLevel::Debug);
        assert_eq!(r.scope.as_deref(), Some("db.pool"));
    }
}
```

- [ ] **Step 2：写 fixture**

新建 `src-tauri/tests/fixtures/python.log`：

```
2026-05-22 12:00:00,123 - auth - INFO - login ok
2026-05-22 12:00:01,456 - db.pool - DEBUG - acquire conn
2026-05-22 12:00:02,789 - db - WARNING - slow query 1.2s
2026-05-22 12:00:03,000 - auth - ERROR - token invalid
2026-05-22 12:00:04,111 - http - INFO - GET /api/users 200
```

- [ ] **Step 3：测试 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::builtin::python_default::
```

Expected: 2 pass。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/parser/builtin/python_default.rs src-tauri/tests/fixtures/python.log
git commit -m "feat(parser): python-default template + fixture"
```

---

### Task 3.4：nginx-combined 模板 + fixture

**Files:**
- Modify: `src-tauri/src/parser/builtin/nginx_combined.rs`
- Create: `src-tauri/tests/fixtures/nginx-access.log`

- [ ] **Step 1：写模板**

覆盖 `src-tauri/src/parser/builtin/nginx_combined.rs`：

```rust
// nginx-combined 模板：Nginx 默认 combined access log
// 样例：127.0.0.1 - - [22/May/2026:12:00:00 +0000] "GET /x HTTP/1.1" 200 1234 "-" "Mozilla/5.0"

use crate::model::LogLevel;
use crate::parser::regex_template::{FieldMap, RegexTemplate};
use regex::Regex;

pub fn template() -> RegexTemplate {
    let mut t = RegexTemplate {
        id: "nginx-combined".into(),
        name: "Nginx Combined".into(),
        pattern: Regex::new(
            r#"^(?P<remote>\S+) (?P<ident>\S+) (?P<user>\S+) \[(?P<ts>[^\]]+)\] "(?P<request>[^"]*)" (?P<status>\d+) (?P<size>\S+)(?: "(?P<referer>[^"]*)" "(?P<ua>[^"]*)")?$"#
        ).unwrap(),
        start_pattern: Regex::new(r"^\d+\.\d+\.\d+\.\d+").unwrap(),
        time_formats: vec![
            "%d/%b/%Y:%H:%M:%S %z".into(),
        ],
        field_map: FieldMap {
            timestamp: Some("ts".into()),
            level: None,             // nginx 没有 level，用 status code 推断（见下方 override）
            scope: Some("remote".into()),
            message: Some("request".into()),
        },
        tail: None,
    };
    // 用一个稍后的 hook 处理 status → level；但 RegexTemplate trait 没暴露 hook，所以我们这里
    // 手工把 level "硬编码" 为 Info（access log 主流是 200），nginx error log 是另一种模板。
    // 由于本 MVP 不区分 nginx access vs error，把所有视为 Info。
    let _ = LogLevel::Info; // 标记意图：保持 Unknown 即可，由 FieldMap.level=None 控制
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::template::ParserTemplate;

    #[test]
    fn parses_combined_line() {
        let t = template();
        let raw = r#"127.0.0.1 - - [22/May/2026:12:00:00 +0000] "GET /api/users HTTP/1.1" 200 1234 "-" "Mozilla/5.0""#;
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.scope.as_deref(), Some("127.0.0.1"));
        assert_eq!(r.message, "GET /api/users HTTP/1.1");
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn parses_common_log_format_without_referer() {
        let t = template();
        let raw = r#"127.0.0.1 - - [22/May/2026:12:00:00 +0000] "GET /x HTTP/1.1" 200 1234"#;
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.scope.as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn is_record_start_matches_ip() {
        let t = template();
        assert!(t.is_record_start("127.0.0.1 - - [22/May/2026:12:00:00 +0000] \"GET /\" 200 0"));
        assert!(!t.is_record_start("  continuation"));
    }
}
```

- [ ] **Step 2：写 fixture**

新建 `src-tauri/tests/fixtures/nginx-access.log`：

```
127.0.0.1 - - [22/May/2026:12:00:00 +0000] "GET /api/users HTTP/1.1" 200 1234 "-" "Mozilla/5.0"
10.0.0.5 - - [22/May/2026:12:00:01 +0000] "POST /api/login HTTP/1.1" 401 89 "https://example.com" "curl/7.86.0"
127.0.0.1 - - [22/May/2026:12:00:02 +0000] "GET /static/app.css HTTP/1.1" 304 0 "-" "Mozilla/5.0"
```

- [ ] **Step 3：测试 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::builtin::nginx_combined::
```

Expected: 3 pass。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/parser/builtin/nginx_combined.rs src-tauri/tests/fixtures/nginx-access.log
git commit -m "feat(parser): nginx-combined template + fixture"
```

---

### Task 3.5：logfmt 模板（独立专用解析器）+ fixture

**Files:**
- Modify: `src-tauri/src/parser/builtin/logfmt.rs`
- Create: `src-tauri/tests/fixtures/logfmt.log`

- [ ] **Step 1：写专用解析器**

覆盖 `src-tauri/src/parser/builtin/logfmt.rs`：

```rust
// logfmt 模板：Heroku / k8s 风格 key=value
// 样例：time=2026-05-22T09:00:00Z level=info logger=auth msg="login ok" user=42

use crate::model::LogLevel;
use crate::parser::level::parse_level;
use crate::parser::template::{ParserTemplate, PartialEntry};
use chrono::{DateTime, Utc};
use std::collections::HashMap;

pub struct LogfmtTemplate;

impl ParserTemplate for LogfmtTemplate {
    fn id(&self) -> &str { "logfmt" }
    fn name(&self) -> &str { "logfmt" }

    fn is_record_start(&self, line: &str) -> bool {
        // logfmt 不跨行；起始行的条件：不以空白开头 + 含 '='
        !line.is_empty() && !line.starts_with(char::is_whitespace) && line.contains('=')
    }

    fn parse_record(&self, lines: &[String]) -> Option<PartialEntry> {
        let head = lines.first()?;
        let pairs = parse_logfmt(head)?;

        let mut map: HashMap<String, String> = pairs.into_iter().collect();
        let timestamp = map.remove("time")
            .or_else(|| map.remove("ts"))
            .or_else(|| map.remove("timestamp"))
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok().map(|d| d.with_timezone(&Utc)));

        let level = map.remove("level")
            .or_else(|| map.remove("lvl"))
            .or_else(|| map.remove("severity"))
            .map(|s| parse_level(&s))
            .unwrap_or(LogLevel::Unknown);

        let scope = map.remove("logger")
            .or_else(|| map.remove("scope"))
            .or_else(|| map.remove("module"));

        let message = map.remove("msg")
            .or_else(|| map.remove("message"))
            .unwrap_or_default();

        Some(PartialEntry {
            timestamp,
            level,
            scope,
            message,
            fields: map,
        })
    }
}

/// 把一行 logfmt 解析为 (key, value) 列表
/// 支持 `key=value` 和 `key="quoted value with spaces"`
fn parse_logfmt(s: &str) -> Option<Vec<(String, String)>> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // 跳过空白
        while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= bytes.len() { break; }

        // 读 key
        let key_start = i;
        while i < bytes.len() && bytes[i] != b'=' && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let key = std::str::from_utf8(&bytes[key_start..i]).ok()?.to_string();
        if key.is_empty() { return None; }

        // 期望 '='
        if i >= bytes.len() || bytes[i] != b'=' {
            // key 没有 = 跟着 → 视为孤立的 flag，值置空
            out.push((key, String::new()));
            continue;
        }
        i += 1; // 吃掉 '='

        // 读 value（带引号或不带）
        if i < bytes.len() && bytes[i] == b'"' {
            i += 1;
            let val_start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                // 简易处理转义：跳过 \"
                if bytes[i] == b'\\' && i + 1 < bytes.len() { i += 2; }
                else { i += 1; }
            }
            let val = std::str::from_utf8(&bytes[val_start..i]).ok()?
                .replace("\\\"", "\"");
            out.push((key, val));
            if i < bytes.len() { i += 1; } // 吃掉结尾 "
        } else {
            let val_start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() { i += 1; }
            let val = std::str::from_utf8(&bytes[val_start..i]).ok()?.to_string();
            out.push((key, val));
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;

    fn p() -> LogfmtTemplate { LogfmtTemplate }
    fn lines(s: &str) -> Vec<String> { vec![s.to_string()] }

    #[test]
    fn parses_simple_pairs() {
        let pairs = parse_logfmt("a=1 b=2 c=3").unwrap();
        assert_eq!(pairs.len(), 3);
        assert_eq!(pairs[0], ("a".to_string(), "1".to_string()));
    }

    #[test]
    fn parses_quoted_value_with_spaces() {
        let pairs = parse_logfmt(r#"msg="hello world" user=42"#).unwrap();
        assert_eq!(pairs[0], ("msg".to_string(), "hello world".to_string()));
        assert_eq!(pairs[1], ("user".to_string(), "42".to_string()));
    }

    #[test]
    fn parses_escaped_quote_in_value() {
        let pairs = parse_logfmt(r#"msg="he said \"hi\"""#).unwrap();
        assert_eq!(pairs[0].1, r#"he said "hi""#);
    }

    #[test]
    fn parses_full_logfmt_line() {
        let line = r#"time=2026-05-22T09:00:00Z level=info logger=auth msg="login ok" user=42"#;
        let r = p().parse_record(&lines(line)).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("auth"));
        assert_eq!(r.message, "login ok");
        assert!(r.timestamp.is_some());
        assert_eq!(r.fields.get("user").map(String::as_str), Some("42"));
    }

    #[test]
    fn is_record_start_requires_kv() {
        assert!(p().is_record_start("a=1"));
        assert!(p().is_record_start("a=1 b=2"));
        assert!(!p().is_record_start("  a=1"));      // 以空白开头视为续行
        assert!(!p().is_record_start("no equals here"));
        assert!(!p().is_record_start(""));
    }
}
```

- [ ] **Step 2：写 fixture**

新建 `src-tauri/tests/fixtures/logfmt.log`：

```
time=2026-05-22T09:00:00Z level=info logger=auth msg="login ok" user=42
time=2026-05-22T09:00:01Z level=warn logger=db msg="slow query 1.2s" query="SELECT *"
time=2026-05-22T09:00:02Z level=error logger=auth msg="token invalid" user=42
time=2026-05-22T09:00:03Z level=debug logger=db.pool msg="acquire conn"
time=2026-05-22T09:00:04Z level=info logger=http msg="GET /api/users 200"
```

- [ ] **Step 3：测试 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::builtin::logfmt::
```

Expected: 5 pass。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/parser/builtin/logfmt.rs src-tauri/tests/fixtures/logfmt.log
git commit -m "feat(parser): logfmt template (custom state machine) + fixture"
```

---

## Phase 4：嗅探 + 全局注册表

### Task 4.1：模板注册表

**Files:**
- Create: `src-tauri/src/parser/registry.rs`
- Modify: `src-tauri/src/parser/mod.rs`

- [ ] **Step 1：写注册表**

新建 `src-tauri/src/parser/registry.rs`：

```rust
// 全局模板注册表：内置 + 自定义（Plan 2a Phase 5 之后会注入自定义）

use crate::parser::builtin;
use crate::parser::json_lines::JsonLinesTemplate;
use crate::parser::regex_template::RegexTemplate;
use crate::parser::template::ParserTemplate;
use parking_lot::RwLock;
use std::sync::Arc;

pub enum Tpl {
    JsonLines(JsonLinesTemplate),
    Regex(RegexTemplate),
    Logfmt(builtin::logfmt::LogfmtTemplate),
}

impl Tpl {
    pub fn as_parser(&self) -> &dyn ParserTemplate {
        match self {
            Tpl::JsonLines(t) => t,
            Tpl::Regex(t) => t,
            Tpl::Logfmt(t) => t,
        }
    }
}

pub struct Registry {
    templates: RwLock<Vec<Arc<Tpl>>>,
}

impl Registry {
    pub fn new_with_builtins() -> Self {
        let templates: Vec<Arc<Tpl>> = vec![
            Arc::new(Tpl::JsonLines(JsonLinesTemplate)),
            Arc::new(Tpl::Regex(builtin::bracket_electron::template())),
            Arc::new(Tpl::Regex(builtin::bracket_common::template())),
            Arc::new(Tpl::Regex(builtin::python_default::template())),
            Arc::new(Tpl::Regex(builtin::nginx_combined::template())),
            Arc::new(Tpl::Logfmt(builtin::logfmt::LogfmtTemplate)),
        ];
        Self { templates: RwLock::new(templates) }
    }

    pub fn all(&self) -> Vec<Arc<Tpl>> {
        self.templates.read().clone()
    }

    pub fn find(&self, id: &str) -> Option<Arc<Tpl>> {
        self.templates.read().iter()
            .find(|t| t.as_parser().id() == id)
            .cloned()
    }

    /// 注入自定义模板（Phase 5 prefs 加载用）
    pub fn add(&self, tpl: Tpl) {
        self.templates.write().push(Arc::new(tpl));
    }

    /// 删除自定义模板
    pub fn remove(&self, id: &str) {
        self.templates.write().retain(|t| t.as_parser().id() != id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_six_builtins() {
        let r = Registry::new_with_builtins();
        let all = r.all();
        assert_eq!(all.len(), 6);
        let ids: Vec<&str> = all.iter().map(|t| t.as_parser().id()).collect();
        assert!(ids.contains(&"json-lines"));
        assert!(ids.contains(&"bracket-electron"));
        assert!(ids.contains(&"bracket-common"));
        assert!(ids.contains(&"python-default"));
        assert!(ids.contains(&"nginx-combined"));
        assert!(ids.contains(&"logfmt"));
    }

    #[test]
    fn find_returns_template_by_id() {
        let r = Registry::new_with_builtins();
        assert!(r.find("bracket-electron").is_some());
        assert!(r.find("non-existent").is_none());
    }
}
```

- [ ] **Step 2：声明 registry 子模块**

在 `src-tauri/src/parser/mod.rs` 顶部加 `pub mod registry;`：

```rust
pub mod template;
pub mod json_lines;
pub mod level;
pub mod grouping;
pub mod tail_parser;
pub mod regex_template;
pub mod builtin;
pub mod registry;
```

- [ ] **Step 3：测试 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::registry::
```

Expected: 2 pass。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/parser/{mod.rs,registry.rs}
git commit -m "feat(parser): template registry with 6 builtins + add/remove API"
```

---

### Task 4.2：sniff 算法

**Files:**
- Create: `src-tauri/src/parser/sniff.rs`
- Create: `src-tauri/tests/fixtures/mixed-noise.log`
- Modify: `src-tauri/src/parser/mod.rs`

- [ ] **Step 1：写 sniff**

新建 `src-tauri/src/parser/sniff.rs`：

```rust
// 自动嗅探：对 lines 跑每个模板，按命中率 + 字段完整度打分

use crate::parser::grouping::group_records;
use crate::parser::registry::{Registry, Tpl};
use crate::parser::template::ParserTemplate;
use serde::Serialize;
use std::sync::Arc;

const SAMPLE_LIMIT: usize = 200;
const AUTO_THRESHOLD: f32 = 0.8;
const SUGGEST_THRESHOLD: f32 = 0.4;

#[derive(Debug, Clone, Serialize)]
pub struct TemplateScore {
    pub template_id: String,
    pub template_name: String,
    pub confidence: f32,
    pub hit_rate: f32,
    pub field_completeness: f32,
    pub sample_records: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum SniffResult {
    AutoMatch { picked: TemplateScore, alternatives: Vec<TemplateScore> },
    Suggested { picked: TemplateScore, alternatives: Vec<TemplateScore> },
    NoMatch { alternatives: Vec<TemplateScore> },
}

pub fn sniff(registry: &Registry, lines: &[String]) -> SniffResult {
    let sample: &[String] = if lines.len() > SAMPLE_LIMIT {
        &lines[..SAMPLE_LIMIT]
    } else {
        lines
    };

    let mut scores: Vec<TemplateScore> = registry.all().iter()
        .map(|t| score_template(t.clone(), sample))
        .collect();

    scores.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));

    let picked = scores.first().cloned();
    let alternatives = scores.into_iter().skip(1).take(5).collect();

    match picked {
        Some(p) if p.confidence >= AUTO_THRESHOLD => SniffResult::AutoMatch { picked: p, alternatives },
        Some(p) if p.confidence >= SUGGEST_THRESHOLD => SniffResult::Suggested { picked: p, alternatives },
        Some(p) => SniffResult::NoMatch { alternatives: std::iter::once(p).chain(alternatives).collect() },
        None    => SniffResult::NoMatch { alternatives: vec![] },
    }
}

fn score_template(tpl: Arc<Tpl>, sample: &[String]) -> TemplateScore {
    let parser = tpl.as_parser();
    let records = group_records(parser, sample);

    let mut parsed_ok = 0u32;
    let mut total_field_score = 0f32;
    for r in &records {
        if let Some(p) = parser.parse_record(&r.lines) {
            parsed_ok += 1;
            let filled = [
                p.timestamp.is_some(),
                !matches!(p.level, crate::model::LogLevel::Unknown),
                p.scope.is_some(),
                !p.message.is_empty(),
            ];
            let count: u8 = filled.iter().map(|b| *b as u8).sum();
            total_field_score += (count as f32) / 4.0;
        }
    }

    let total = records.len().max(1) as f32;
    let hit_rate = (parsed_ok as f32) / total;
    let field_completeness = if parsed_ok > 0 {
        total_field_score / (parsed_ok as f32)
    } else {
        0.0
    };
    let confidence = hit_rate * 0.6 + field_completeness * 0.4;

    TemplateScore {
        template_id: parser.id().to_string(),
        template_name: parser.name().to_string(),
        confidence,
        hit_rate,
        field_completeness,
        sample_records: records.len() as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_picks_bracket_electron_for_electron_log() {
        let lines: Vec<String> = vec![
            "[2026-05-21 17:26:37.566] [info] (network) hi".into(),
            "[2026-05-21 17:26:37.576] [warn] (db) slow".into(),
            "[2026-05-21 17:26:37.577] [error] (auth) failed".into(),
        ];
        let r = sniff(&Registry::new_with_builtins(), &lines);
        match r {
            SniffResult::AutoMatch { picked, .. } | SniffResult::Suggested { picked, .. } => {
                assert_eq!(picked.template_id, "bracket-electron");
                assert!(picked.confidence > 0.7);
            }
            SniffResult::NoMatch { .. } => panic!("expected match"),
        }
    }

    #[test]
    fn sniff_picks_json_lines_for_jsonl() {
        let lines: Vec<String> = vec![
            r#"{"time":"2026-05-22T09:00:00Z","level":"info","logger":"a","msg":"x"}"#.into(),
            r#"{"time":"2026-05-22T09:00:01Z","level":"warn","logger":"b","msg":"y"}"#.into(),
        ];
        let r = sniff(&Registry::new_with_builtins(), &lines);
        match r {
            SniffResult::AutoMatch { picked, .. } => {
                assert_eq!(picked.template_id, "json-lines");
            }
            other => panic!("expected AutoMatch json-lines, got {:?}", other),
        }
    }

    #[test]
    fn sniff_returns_no_match_for_garbage() {
        let lines: Vec<String> = vec!["aaaa".into(), "bbbb".into(), "cccc".into()];
        let r = sniff(&Registry::new_with_builtins(), &lines);
        match r {
            SniffResult::NoMatch { .. } => (),
            SniffResult::Suggested { picked, .. } => {
                // 个别模板（如 logfmt：含 = 才匹配）可能给低 confidence，允许 Suggested 但要求 < 0.8
                assert!(picked.confidence < AUTO_THRESHOLD);
            }
            SniffResult::AutoMatch { .. } => panic!("garbage shouldn't auto-match"),
        }
    }
}
```

- [ ] **Step 2：写 mixed-noise fixture**

新建 `src-tauri/tests/fixtures/mixed-noise.log`：

```
[2026-05-22 09:00:00.000] [info] (auth) hello
[2026-05-22 09:00:01.000] [warn] (db) slow
[2026-05-22 09:00:02.000] [error] (auth) failed
random garbage line that matches nothing
another garbage line
[2026-05-22 09:00:05.000] [info] (http) recovered
```

- [ ] **Step 3：声明 sniff 子模块 + 跑测试**

在 `src-tauri/src/parser/mod.rs` 顶部加 `pub mod sniff;`。

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib parser::sniff::
```

Expected: 3 pass。

- [ ] **Step 4：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/parser/{mod.rs,sniff.rs} src-tauri/tests/fixtures/mixed-noise.log
git commit -m "feat(parser): auto-sniff template by confidence × field completeness"
```

---

### Task 4.3：parse_lines 接入嗅探（替换硬编码 JsonLines）

**Files:**
- Modify: `src-tauri/src/parser/mod.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/session/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1：parser/mod.rs 加 parse_with_sniff 入口**

在 `src-tauri/src/parser/mod.rs` 里加（保留旧的 `parse_lines` 不动，让 Plan 1 测试继续 pass）：

```rust
use registry::Registry;
use sniff::{sniff, SniffResult};

/// 嗅探后用最高分模板解析。如果完全无匹配，回退到把每行作为 Unknown fallback。
pub fn parse_with_sniff(registry: &Registry, lines: &[String]) -> (Vec<LogEntry>, String) {
    let result = sniff(registry, lines);
    let template_id = match &result {
        SniffResult::AutoMatch { picked, .. } | SniffResult::Suggested { picked, .. } => picked.template_id.clone(),
        SniffResult::NoMatch { .. } => "unknown".to_string(),
    };
    let entries = match template_id.as_str() {
        "unknown" => {
            // 全部 fallback：每行作 Unknown entry
            lines.iter().enumerate().map(|(i, l)| template::fallback((i + 1) as u32, 1, l)).collect()
        }
        id => {
            let tpl = registry.find(id).expect("registry must contain picked template");
            parse_with_template(tpl.as_parser(), lines)
        }
    };
    (entries, template_id)
}
```

- [ ] **Step 2：commands.rs cmd_open_file 走嗅探**

在 `src-tauri/src/commands.rs` 顶部 import 加：
```rust
use crate::parser::registry::Registry;
```

把 `cmd_open_file` 函数体改为：

```rust
#[tauri::command]
pub fn cmd_open_file(
    path: String,
    state: State<'_, SessionState>,
    registry: State<'_, Registry>,
) -> Result<FileMetadata, AppError> {
    let lines = reader::read_all_lines(Path::new(&path))?;
    let (entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    let metadata = parser::compute_metadata(&path, &entries, &template_id);
    state.load_with_lines(metadata.clone(), entries, lines);
    Ok(metadata)
}
```

注意：新增了 `registry: State<'_, Registry>` 参数 + 调用 `state.load_with_lines`（下一步加）。

- [ ] **Step 3：SessionState 缓存 raw lines**

打开 `src-tauri/src/session/state.rs`，把 `SessionInner` 加一个字段 `lines`：

```rust
pub struct SessionInner {
    pub metadata: FileMetadata,
    pub entries: Arc<Vec<LogEntry>>,
    pub cache: HashMap<u64, Arc<Vec<u32>>>,
    pub lines: Arc<Vec<String>>,        // NEW：缓存原始行，用于 reparse_with_template
}
```

加 `load_with_lines` 方法（替代 load；保留旧 load 但 deprecated 不破坏测试）：

```rust
impl SessionState {
    pub fn load_with_lines(&self, metadata: FileMetadata, entries: Vec<LogEntry>, lines: Vec<String>) {
        let mut w = self.0.write();
        *w = Some(SessionInner {
            metadata,
            entries: Arc::new(entries),
            cache: HashMap::new(),
            lines: Arc::new(lines),
        });
    }

    /// Plan 1 兼容入口：不缓存 lines（reparse 用 load_with_lines）
    pub fn load(&self, metadata: FileMetadata, entries: Vec<LogEntry>) {
        self.load_with_lines(metadata, entries, vec![])
    }

    pub fn lines(&self) -> Result<Arc<Vec<String>>, AppError> {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        Ok(inner.lines.clone())
    }
}
```

- [ ] **Step 4：lib.rs 注册 Registry 到 Tauri State**

修改 `src-tauri/src/lib.rs`，在文件顶部 `use session::SessionState;` 行下方加：

```rust
use parser::registry::Registry;
```

然后在 `run()` 里，在 `tauri::Builder::default()` 链上加 `.manage(Registry::new_with_builtins())`：

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionState::default())
        .manage(Registry::new_with_builtins())          // NEW
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

- [ ] **Step 5：跑全部测试 + 端到端集成测试**

Run:
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test
```

Expected: 全部通过。注意 `tests/integration.rs` 不依赖 `cmd_open_file`，它直接用 `parser::parse_lines` 入口，所以仍然过；其他单测也不动。

新增一个端到端集成测试以验证 sniff 路径：

新建 `src-tauri/tests/integration_sniff.rs`：

```rust
// 端到端：用 fixture 验证 sniff + 多模板解析正确

use log_viewer_lib::loader::reader;
use log_viewer_lib::model::LogLevel;
use log_viewer_lib::parser;
use log_viewer_lib::parser::registry::Registry;
use std::path::Path;

#[test]
fn electron_multiline_log_picks_bracket_electron() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/electron-multiline.log")).unwrap();
    let registry = Registry::new_with_builtins();
    let (entries, template_id) = parser::parse_with_sniff(&registry, &lines);

    assert_eq!(template_id, "bracket-electron");
    // 验证多行 record 被合并：service started 那条占 4 行
    let multiline = entries.iter().find(|e| e.message.contains("service started")).unwrap();
    assert_eq!(multiline.line_count, 4);
    assert_eq!(multiline.level, LogLevel::Info);
    assert_eq!(multiline.scope.as_deref(), Some("app-update"));
    assert!(multiline.fields.contains_key("channel"));
}

#[test]
fn nginx_log_picks_nginx_combined() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/nginx-access.log")).unwrap();
    let registry = Registry::new_with_builtins();
    let (_entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    assert_eq!(template_id, "nginx-combined");
}

#[test]
fn python_log_picks_python_default() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/python.log")).unwrap();
    let registry = Registry::new_with_builtins();
    let (_entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    assert_eq!(template_id, "python-default");
}

#[test]
fn logfmt_log_picks_logfmt() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/logfmt.log")).unwrap();
    let registry = Registry::new_with_builtins();
    let (_entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    assert_eq!(template_id, "logfmt");
}

#[test]
fn jsonl_log_picks_json_lines() {
    let lines = reader::read_all_lines(Path::new("tests/fixtures/sample.jsonl")).unwrap();
    let registry = Registry::new_with_builtins();
    let (_entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    assert_eq!(template_id, "json-lines");
}
```

跑测试：
```bash
$HOME/.cargo/bin/cargo test --test integration_sniff
```

Expected: 5 pass。

- [ ] **Step 6：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{parser/mod.rs,commands.rs,session/state.rs,lib.rs} src-tauri/tests/integration_sniff.rs
git commit -m "feat(parser): wire auto-sniff into open_file flow + integration tests"
```

---

## Phase 5：prefs 持久化（自定义模板）

### Task 5.1：prefs 模块基础

**Files:**
- Create: `src-tauri/src/prefs/mod.rs`
- Create: `src-tauri/src/prefs/store.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1：加 directories 依赖**

`src-tauri/Cargo.toml` `[dependencies]` 加：
```toml
directories = "5"
```

- [ ] **Step 2：写 store**

新建 `src-tauri/src/prefs/mod.rs`：
```rust
pub mod store;

pub use store::{CustomTemplate, PrefsStore};
```

新建 `src-tauri/src/prefs/store.rs`：

```rust
// prefs.json 读写：保存自定义解析模板
// 路径：{config_dir()}/log-viewer/prefs.json
// 损坏时备份为 prefs.json.bak.{ts} 并重置为默认

use crate::error::AppError;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomTemplate {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub start_pattern: String,
    pub time_formats: Vec<String>,
    pub field_map: CustomFieldMap,
    /// "none" | "json_object" | "json_like"
    pub tail_parser: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomFieldMap {
    pub timestamp: Option<String>,
    pub level: Option<String>,
    pub scope: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Prefs {
    pub version: u32,
    pub custom_templates: Vec<CustomTemplate>,
}

pub struct PrefsStore {
    path: PathBuf,
}

impl PrefsStore {
    pub fn new() -> Result<Self, AppError> {
        let dirs = ProjectDirs::from("dev", "local", "log-viewer")
            .ok_or_else(|| AppError::Internal("无法定位 config_dir".into()))?;
        let dir = dirs.config_dir().to_path_buf();
        fs::create_dir_all(&dir)?;
        let path = dir.join("prefs.json");
        Ok(Self { path })
    }

    /// 仅用于测试：指定路径
    pub fn at(path: PathBuf) -> Self { Self { path } }

    pub fn load(&self) -> Prefs {
        if !self.path.exists() {
            return Prefs { version: 1, custom_templates: vec![] };
        }
        match fs::read_to_string(&self.path) {
            Ok(s) => match serde_json::from_str::<Prefs>(&s) {
                Ok(p) => p,
                Err(_) => {
                    // 损坏：备份 + 重置
                    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                    let bak = self.path.with_extension(format!("json.bak.{}", ts));
                    let _ = fs::rename(&self.path, &bak);
                    Prefs { version: 1, custom_templates: vec![] }
                }
            }
            Err(_) => Prefs { version: 1, custom_templates: vec![] },
        }
    }

    pub fn save(&self, prefs: &Prefs) -> Result<(), AppError> {
        let s = serde_json::to_string_pretty(prefs)
            .map_err(|e| AppError::Internal(format!("序列化 prefs 失败：{e}")))?;
        fs::write(&self.path, s)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_template() -> CustomTemplate {
        CustomTemplate {
            id: "test".into(),
            name: "Test".into(),
            pattern: "^.*$".into(),
            start_pattern: "^.".into(),
            time_formats: vec![],
            field_map: CustomFieldMap {
                timestamp: None, level: None, scope: None, message: Some("msg".into()),
            },
            tail_parser: "none".into(),
        }
    }

    #[test]
    fn load_returns_empty_when_file_absent() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        let p = store.load();
        assert_eq!(p.version, 1);
        assert!(p.custom_templates.is_empty());
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        let prefs = Prefs { version: 1, custom_templates: vec![sample_template()] };
        store.save(&prefs).unwrap();
        let loaded = store.load();
        assert_eq!(loaded.custom_templates.len(), 1);
        assert_eq!(loaded.custom_templates[0].id, "test");
    }

    #[test]
    fn corrupted_file_is_backed_up_and_reset() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        fs::write(&path, "not valid json").unwrap();
        let store = PrefsStore::at(path.clone());
        let p = store.load();
        // 重置为空
        assert!(p.custom_templates.is_empty());
        // 原文件应被备份（同目录下出现 .bak.* 文件）
        let entries: Vec<_> = fs::read_dir(dir.path()).unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.iter().any(|n| n.starts_with("prefs.json.bak.")));
    }
}
```

- [ ] **Step 3：在 lib.rs 声明 prefs 模块 + 启动时构建 PrefsStore**

修改 `src-tauri/src/lib.rs`：

```rust
pub mod commands;
pub mod error;
pub mod loader;
pub mod model;
pub mod parser;
pub mod prefs;             // NEW
pub mod query;
pub mod session;
pub mod stats;

use parser::registry::Registry;
use prefs::PrefsStore;
use session::SessionState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let prefs_store = PrefsStore::new().expect("初始化 prefs 失败");
    let registry = Registry::new_with_builtins();
    // 启动时加载 prefs 并注入注册表
    let prefs = prefs_store.load();
    for tpl_cfg in &prefs.custom_templates {
        if let Ok(rt) = prefs::store::compile_custom_template(tpl_cfg) {
            registry.add(parser::registry::Tpl::Regex(rt));
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionState::default())
        .manage(registry)
        .manage(prefs_store)
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

注意：`compile_custom_template` 在下一个 task 加。

- [ ] **Step 4：commit（先不跑 lib.rs 那里，因为 compile_custom_template 还没写）**

先注释 lib.rs 里加载 prefs 那段 + `for tpl_cfg`：

```rust
    let _prefs_store = PrefsStore::new().expect("初始化 prefs 失败");
    let registry = Registry::new_with_builtins();
    // Task 5.2 之后启用：
    // let prefs = prefs_store.load();
    // for tpl_cfg in &prefs.custom_templates {
    //     if let Ok(rt) = prefs::store::compile_custom_template(tpl_cfg) {
    //         registry.add(parser::registry::Tpl::Regex(rt));
    //     }
    // }

    tauri::Builder::default()
        ...
        .manage(registry)
        // .manage(prefs_store)   // 等 Task 5.2 真正集成
        ...
```

跑测试：
```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib prefs::
```

Expected: 3 pass。整体编译要过。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{prefs,lib.rs} src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(prefs): add PrefsStore for custom template persistence"
```

---

### Task 5.2：CustomTemplate → RegexTemplate 编译

**Files:**
- Modify: `src-tauri/src/prefs/store.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1：加 compile_custom_template**

打开 `src-tauri/src/prefs/store.rs`，在文件末尾（tests 模块之前）加：

```rust
use crate::parser::regex_template::{FieldMap, RegexTemplate};
use crate::parser::tail_parser::TailParserKind;
use regex::Regex;

/// 把持久化的 CustomTemplate 编译为可运行的 RegexTemplate
pub fn compile_custom_template(c: &CustomTemplate) -> Result<RegexTemplate, AppError> {
    let pattern = Regex::new(&c.pattern)
        .map_err(|e| AppError::Parse(format!("pattern 编译失败：{e}")))?;
    let start_pattern = Regex::new(&c.start_pattern)
        .map_err(|e| AppError::Parse(format!("start_pattern 编译失败：{e}")))?;
    let tail = match c.tail_parser.as_str() {
        "none" => None,
        "json_object" => Some(TailParserKind::JsonObject),
        "json_like" => Some(TailParserKind::JsonLike),
        other => return Err(AppError::Parse(format!("未知 tail_parser: {other}"))),
    };
    Ok(RegexTemplate {
        id: c.id.clone(),
        name: c.name.clone(),
        pattern,
        start_pattern,
        time_formats: c.time_formats.clone(),
        field_map: FieldMap {
            timestamp: c.field_map.timestamp.clone(),
            level: c.field_map.level.clone(),
            scope: c.field_map.scope.clone(),
            message: c.field_map.message.clone(),
        },
        tail,
    })
}
```

在 tests 模块里加一个测试：

```rust
    #[test]
    fn compile_custom_template_ok() {
        let c = CustomTemplate {
            id: "x".into(),
            name: "X".into(),
            pattern: r"^(?P<msg>.*)$".into(),
            start_pattern: "^.".into(),
            time_formats: vec![],
            field_map: CustomFieldMap {
                timestamp: None, level: None, scope: None, message: Some("msg".into()),
            },
            tail_parser: "json_like".into(),
        };
        let rt = compile_custom_template(&c).unwrap();
        assert_eq!(rt.id, "x");
        assert!(rt.tail.is_some());
    }

    #[test]
    fn compile_custom_template_rejects_bad_regex() {
        let c = CustomTemplate {
            id: "x".into(), name: "X".into(),
            pattern: "[invalid".into(),
            start_pattern: "^".into(),
            time_formats: vec![],
            field_map: CustomFieldMap { timestamp: None, level: None, scope: None, message: None },
            tail_parser: "none".into(),
        };
        let r = compile_custom_template(&c);
        assert!(matches!(r, Err(AppError::Parse(_))));
    }
```

- [ ] **Step 2：lib.rs 放开 prefs 加载**

把 `src-tauri/src/lib.rs` 里被注释的几行解开：

```rust
pub fn run() {
    let prefs_store = PrefsStore::new().expect("初始化 prefs 失败");
    let registry = Registry::new_with_builtins();
    let prefs = prefs_store.load();
    for tpl_cfg in &prefs.custom_templates {
        if let Ok(rt) = prefs::store::compile_custom_template(tpl_cfg) {
            registry.add(parser::registry::Tpl::Regex(rt));
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionState::default())
        .manage(registry)
        .manage(prefs_store)
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

- [ ] **Step 3：测试 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test --lib prefs::
```

Expected: 5 pass。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{prefs/store.rs,lib.rs}
git commit -m "feat(prefs): compile CustomTemplate to RegexTemplate; load on startup"
```

---

## Phase 6：模板管理 Tauri commands

### Task 6.1：list_templates + reparse_with_template

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1：在 commands.rs 顶部加 import + 类型**

打开 `src-tauri/src/commands.rs`，顶部 import 区加：

```rust
use crate::parser::registry::Registry;
use serde::Serialize;
```

文件顶部加类型：

```rust
#[derive(Serialize)]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub builtin: bool,
}
```

- [ ] **Step 2：写 cmd_list_templates**

在 commands.rs 末尾加：

```rust
const BUILTIN_IDS: &[&str] = &[
    "json-lines", "bracket-electron", "bracket-common",
    "python-default", "nginx-combined", "logfmt",
];

#[tauri::command]
pub fn cmd_list_templates(registry: State<'_, Registry>) -> Vec<TemplateInfo> {
    registry.all().iter().map(|t| {
        let id = t.as_parser().id().to_string();
        let builtin = BUILTIN_IDS.contains(&id.as_str());
        TemplateInfo {
            id: id.clone(),
            name: t.as_parser().name().to_string(),
            builtin,
        }
    }).collect()
}
```

- [ ] **Step 3：写 cmd_reparse_with_template**

```rust
#[tauri::command]
pub fn cmd_reparse_with_template(
    template_id: String,
    state: State<'_, SessionState>,
    registry: State<'_, Registry>,
) -> Result<FileMetadata, AppError> {
    let lines = state.lines()?;
    let tpl = registry.find(&template_id)
        .ok_or_else(|| AppError::Internal(format!("模板未找到：{template_id}")))?;
    let entries = parser::parse_with_template(tpl.as_parser(), &lines);
    let old_meta = state.metadata()?;
    let metadata = parser::compute_metadata(&old_meta.path, &entries, &template_id);
    state.load_with_lines(metadata.clone(), entries, lines.to_vec());
    Ok(metadata)
}
```

- [ ] **Step 4：lib.rs 注册两个 command**

把 `lib.rs` 里的 `invoke_handler!` 改为：

```rust
.invoke_handler(tauri::generate_handler![
    commands::cmd_open_file,
    commands::cmd_query,
    commands::cmd_get_metadata,
    commands::cmd_get_page,
    commands::cmd_list_templates,
    commands::cmd_reparse_with_template,
])
```

- [ ] **Step 5：编译 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -5
```

Expected: 编译通过。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{commands.rs,lib.rs}
git commit -m "feat(commands): list_templates + reparse_with_template"
```

---

### Task 6.2：save / delete 自定义模板

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1：加 save + delete**

在 commands.rs 末尾加：

```rust
use crate::prefs::{CustomTemplate, PrefsStore};

#[tauri::command]
pub fn cmd_save_custom_template(
    tpl: CustomTemplate,
    registry: State<'_, Registry>,
    prefs_store: State<'_, PrefsStore>,
) -> Result<(), AppError> {
    // 1. 编译验证
    let rt = crate::prefs::store::compile_custom_template(&tpl)?;
    // 2. 不允许覆盖内置 id
    if BUILTIN_IDS.contains(&tpl.id.as_str()) {
        return Err(AppError::Parse(format!("不能使用内置 ID：{}", tpl.id)));
    }
    // 3. 注册表：先 remove 同 id（如果是更新），再 add
    registry.remove(&tpl.id);
    registry.add(crate::parser::registry::Tpl::Regex(rt));
    // 4. 持久化
    let mut prefs = prefs_store.load();
    prefs.custom_templates.retain(|t| t.id != tpl.id);
    prefs.custom_templates.push(tpl);
    prefs_store.save(&prefs)?;
    Ok(())
}

#[tauri::command]
pub fn cmd_delete_custom_template(
    id: String,
    registry: State<'_, Registry>,
    prefs_store: State<'_, PrefsStore>,
) -> Result<(), AppError> {
    if BUILTIN_IDS.contains(&id.as_str()) {
        return Err(AppError::Parse(format!("不能删除内置模板：{}", id)));
    }
    registry.remove(&id);
    let mut prefs = prefs_store.load();
    prefs.custom_templates.retain(|t| t.id != id);
    prefs_store.save(&prefs)?;
    Ok(())
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
])
```

- [ ] **Step 3：编译 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo build 2>&1 | tail -5
```

Expected: 编译通过。

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{commands.rs,lib.rs}
git commit -m "feat(commands): save/delete custom templates"
```

---

### Task 6.3：test_template

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1：写 cmd_test_template**

在 `commands.rs` 加：

```rust
#[derive(Serialize)]
pub struct TestSample {
    pub line_no: u32,
    pub line_count: u32,
    pub raw: String,
    pub ok: bool,
    pub message: Option<String>,
    pub level: Option<String>,
    pub scope: Option<String>,
    pub fields_count: u32,
}

#[derive(Serialize)]
pub struct TestResult {
    pub samples: Vec<TestSample>,
    pub hit_rate: f32,
    pub field_completeness: f32,
}

#[tauri::command]
pub fn cmd_test_template(
    tpl: CustomTemplate,
    limit: u32,
    state: State<'_, SessionState>,
) -> Result<TestResult, AppError> {
    let rt = crate::prefs::store::compile_custom_template(&tpl)?;
    let lines = state.lines()?;
    // 取前 N 行的样本（用 group_records 切分）
    let sample_limit = (limit as usize).max(1).min(lines.len());
    let sample = &lines[..sample_limit];

    let records = crate::parser::grouping::group_records(&rt, sample);
    let display_count = records.len().min(limit as usize);

    let mut samples = Vec::new();
    let mut parsed_ok = 0u32;
    let mut field_sum = 0f32;
    for r in records.iter().take(display_count) {
        let raw_joined = r.lines.join("\n");
        let line_count = r.lines.len() as u32;
        let parsed = <crate::parser::regex_template::RegexTemplate as crate::parser::template::ParserTemplate>::parse_record(&rt, &r.lines);
        match parsed {
            Some(p) => {
                parsed_ok += 1;
                let filled = [
                    p.timestamp.is_some(),
                    !matches!(p.level, crate::model::LogLevel::Unknown),
                    p.scope.is_some(),
                    !p.message.is_empty(),
                ];
                let count: u8 = filled.iter().map(|b| *b as u8).sum();
                field_sum += (count as f32) / 4.0;
                samples.push(TestSample {
                    line_no: r.start_line,
                    line_count,
                    raw: raw_joined,
                    ok: true,
                    message: Some(p.message),
                    level: Some(format!("{:?}", p.level)),
                    scope: p.scope,
                    fields_count: p.fields.len() as u32,
                });
            }
            None => {
                samples.push(TestSample {
                    line_no: r.start_line,
                    line_count,
                    raw: raw_joined,
                    ok: false,
                    message: None,
                    level: None,
                    scope: None,
                    fields_count: 0,
                });
            }
        }
    }

    let total = records.len().max(1) as f32;
    Ok(TestResult {
        samples,
        hit_rate: (parsed_ok as f32) / total,
        field_completeness: if parsed_ok > 0 { field_sum / (parsed_ok as f32) } else { 0.0 },
    })
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
])
```

- [ ] **Step 3：编译 + 跑全部测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | tail -10
```

Expected: 全部通过。

- [ ] **Step 4：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add src-tauri/src/{commands.rs,lib.rs}
git commit -m "feat(commands): test_template returns parsed samples + hit rate"
```

---

## Phase 7：前端集成

### Task 7.1：前端类型与 API 封装

**Files:**
- Modify: `src/types/log.ts`
- Modify: `src/api/commands.ts`

- [ ] **Step 1：加 template 类型**

在 `src/types/log.ts` 末尾追加：

```ts
// ─── 模板相关 ───

export interface TemplateInfo {
  id: string;
  name: string;
  builtin: boolean;
}

export type TailParserKind = 'none' | 'json_object' | 'json_like';

export interface CustomFieldMap {
  timestamp?: string | null;
  level?: string | null;
  scope?: string | null;
  message?: string | null;
}

export interface CustomTemplate {
  id: string;
  name: string;
  pattern: string;
  start_pattern: string;
  time_formats: string[];
  field_map: CustomFieldMap;
  tail_parser: TailParserKind;
}

export interface TestSample {
  line_no: number;
  line_count: number;
  raw: string;
  ok: boolean;
  message: string | null;
  level: string | null;
  scope: string | null;
  fields_count: number;
}

export interface TestResult {
  samples: TestSample[];
  hit_rate: number;
  field_completeness: number;
}
```

- [ ] **Step 2：API 封装**

在 `src/api/commands.ts` 末尾追加：

```ts
import type {
  TemplateInfo, CustomTemplate, TestResult, FileMetadata,
} from '../types/log';

export async function listTemplates(): Promise<TemplateInfo[]> {
  return invoke<TemplateInfo[]>('cmd_list_templates');
}

export async function reparseWithTemplate(templateId: string): Promise<FileMetadata> {
  return invoke<FileMetadata>('cmd_reparse_with_template', { templateId });
}

export async function saveCustomTemplate(tpl: CustomTemplate): Promise<void> {
  return invoke<void>('cmd_save_custom_template', { tpl });
}

export async function deleteCustomTemplate(id: string): Promise<void> {
  return invoke<void>('cmd_delete_custom_template', { id });
}

export async function testTemplate(tpl: CustomTemplate, limit: number): Promise<TestResult> {
  return invoke<TestResult>('cmd_test_template', { tpl, limit });
}
```

- [ ] **Step 3：验证 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -5
```

Expected: tsc + vite 全绿。

```bash
git add src/types/log.ts src/api/commands.ts
git commit -m "feat(fe): template TS types + API client methods"
```

---

### Task 7.2：zustand 加 templates / currentTemplateId

**Files:**
- Modify: `src/state/session.ts`

- [ ] **Step 1：扩展 store**

打开 `src/state/session.ts`，在 `SessionStore` 接口加：

```ts
import type { FileMetadata, QuerySpec, QueryResponse, LogLevel, TemplateInfo } from '../types/log';

// ... ALL_LEVELS 同前

interface SessionStore {
  metadata: FileMetadata | null;
  spec: QuerySpec;
  result: QueryResponse | null;
  loading: boolean;
  error: string | null;

  templates: TemplateInfo[];          // NEW
  currentTemplateId: string | null;   // NEW（来自 metadata.template_id 的缓存）

  setMetadata: (m: FileMetadata | null) => void;
  setSpec: (s: QuerySpec) => void;
  patchSpec: (p: Partial<QuerySpec>) => void;
  setResult: (r: QueryResponse | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;

  setTemplates: (ts: TemplateInfo[]) => void;     // NEW
}

export const useSession = create<SessionStore>((set) => ({
  metadata: null,
  spec: { levels: ALL_LEVELS },
  result: null,
  loading: false,
  error: null,
  templates: [],
  currentTemplateId: null,

  setMetadata: (m) => set({ metadata: m, currentTemplateId: m?.template_id ?? null }),
  setSpec: (spec) => set({ spec }),
  patchSpec: (p) => set((s) => ({ spec: { ...s.spec, ...p } })),
  setResult: (result) => set({ result }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  setTemplates: (templates) => set({ templates }),
}));
```

- [ ] **Step 2：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
git add src/state/session.ts
git commit -m "feat(fe): store templates + currentTemplateId in session"
```

---

### Task 7.3：TemplateMenu 顶部下拉

**Files:**
- Create: `src/components/TemplateMenu.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1：写 TemplateMenu**

新建 `src/components/TemplateMenu.tsx`：

```tsx
// 顶部模板下拉：显示当前模板 + 列出所有可选 + "管理模板" 入口

import { useEffect, useState } from 'react';
import { listTemplates, reparseWithTemplate } from '../api/commands';
import { useSession } from '../state/session';

interface Props {
  onOpenManager: () => void;
}

export function TemplateMenu({ onOpenManager }: Props) {
  const { templates, setTemplates, currentTemplateId, metadata, setMetadata, setError } = useSession();
  const [open, setOpen] = useState(false);

  // 文件打开后刷新模板列表（自定义模板可能在管理器里新增）
  useEffect(() => {
    if (!metadata) return;
    listTemplates().then(setTemplates).catch((e) => setError(String(e)));
  }, [metadata, setTemplates, setError]);

  if (!metadata) return null;

  const builtins = templates.filter((t) => t.builtin);
  const customs = templates.filter((t) => !t.builtin);
  const current = templates.find((t) => t.id === currentTemplateId);

  const reparse = async (id: string) => {
    setOpen(false);
    if (id === currentTemplateId) return;
    try {
      const md = await reparseWithTemplate(id);
      setMetadata(md);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-1.5 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50"
      >
        模板：{current?.name ?? currentTemplateId ?? '—'} ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-64 bg-white border rounded shadow-lg z-20 text-sm">
            <div className="px-3 py-1 text-xs text-slate-500 border-b">内置</div>
            {builtins.map((t) => (
              <button
                key={t.id}
                onClick={() => reparse(t.id)}
                className={[
                  'w-full text-left px-3 py-1.5 hover:bg-slate-100',
                  t.id === currentTemplateId ? 'font-semibold text-blue-700' : '',
                ].join(' ')}
              >
                {t.id === currentTemplateId ? '✓ ' : '  '}{t.name}
              </button>
            ))}
            {customs.length > 0 && (
              <>
                <div className="px-3 py-1 text-xs text-slate-500 border-t border-b">自定义</div>
                {customs.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => reparse(t.id)}
                    className={[
                      'w-full text-left px-3 py-1.5 hover:bg-slate-100',
                      t.id === currentTemplateId ? 'font-semibold text-blue-700' : '',
                    ].join(' ')}
                  >
                    {t.id === currentTemplateId ? '✓ ' : '  '}{t.name}
                  </button>
                ))}
              </>
            )}
            <div className="border-t">
              <button
                onClick={() => { setOpen(false); onOpenManager(); }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700"
              >
                ⚙ 管理模板…
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2：App.tsx 装配 + manager 占位**

修改 `src/App.tsx`，加 state + 渲染 TemplateMenu（管理对话框先用占位 alert，下个 Task 替换）：

```tsx
import { useState } from 'react';
import { OpenFileButton } from './components/OpenFileButton';
import { FilterBar } from './components/FilterBar';
import { StatsPanel } from './components/StatsPanel';
import { LogList } from './components/LogList';
import { TemplateMenu } from './components/TemplateMenu';
import { useSession } from './state/session';
import { useAutoQuery } from './hooks/useAutoQuery';

export default function App() {
  const { metadata, loading, error } = useSession();
  const [showManager, setShowManager] = useState(false);
  useAutoQuery();

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 px-4 py-2 border-b bg-white">
        <h1 className="text-base font-semibold">Log Viewer</h1>
        <OpenFileButton />
        {metadata && <TemplateMenu onOpenManager={() => setShowManager(true)} />}
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

      {/* 模板管理对话框（Task 7.4 替换） */}
      {showManager && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30">
          <div className="bg-white p-6 rounded shadow-lg">
            <p>模板管理对话框（Task 7.4）</p>
            <button
              className="mt-3 px-3 py-1 bg-slate-200 rounded"
              onClick={() => setShowManager(false)}
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3：验证 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -3
```

Expected: 编译通过。

```bash
git add src/components/TemplateMenu.tsx src/App.tsx
git commit -m "feat(fe): TemplateMenu dropdown for switching templates"
```

---

### Task 7.4：TemplateManagerDialog 模态

**Files:**
- Create: `src/components/TemplateManagerDialog.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1：写对话框**

新建 `src/components/TemplateManagerDialog.tsx`：

```tsx
// 模板管理模态：左侧列表 + 右侧表单 + 试解析预览

import { useEffect, useState } from 'react';
import {
  listTemplates, saveCustomTemplate, deleteCustomTemplate, testTemplate,
} from '../api/commands';
import { useSession } from '../state/session';
import type { CustomTemplate, TemplateInfo, TestResult, TailParserKind } from '../types/log';

interface Props {
  onClose: () => void;
}

const EMPTY_TEMPLATE: CustomTemplate = {
  id: '',
  name: '',
  pattern: '',
  start_pattern: '',
  time_formats: [],
  field_map: { timestamp: null, level: null, scope: null, message: null },
  tail_parser: 'none',
};

export function TemplateManagerDialog({ onClose }: Props) {
  const { setTemplates: setStoreTemplates } = useSession();
  const [list, setList] = useState<TemplateInfo[]>([]);
  const [editing, setEditing] = useState<CustomTemplate>(EMPTY_TEMPLATE);
  const [isNew, setIsNew] = useState(true);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 加载模板列表
  const refresh = async () => {
    const ts = await listTemplates();
    setList(ts);
    setStoreTemplates(ts);
  };
  useEffect(() => { refresh(); }, []);

  const startNew = () => {
    setEditing(EMPTY_TEMPLATE);
    setIsNew(true);
    setTestResult(null);
    setError(null);
  };

  const startEdit = (info: TemplateInfo) => {
    if (info.builtin) {
      setError('内置模板不可编辑（只能复制为新模板）');
      return;
    }
    // 自定义模板：理论上要从后端读完整 CustomTemplate（当前没有该 API）
    // MVP 简化：让用户重写。后续可加 cmd_get_custom_template。
    setError('编辑自定义模板：MVP 阶段请删除后重建');
  };

  const handleTest = async () => {
    setError(null);
    setTestResult(null);
    try {
      const r = await testTemplate(editing, 10);
      setTestResult(r);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    }
  };

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await saveCustomTemplate(editing);
      await refresh();
      setEditing(EMPTY_TEMPLATE);
      setIsNew(true);
      setTestResult(null);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await deleteCustomTemplate(id);
      await refresh();
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    }
  };

  const updateField = <K extends keyof CustomTemplate>(k: K, v: CustomTemplate[K]) => {
    setEditing((prev) => ({ ...prev, [k]: v }));
  };

  const updateFieldMap = (k: keyof CustomTemplate['field_map'], v: string) => {
    setEditing((prev) => ({ ...prev, field_map: { ...prev.field_map, [k]: v || null } }));
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30">
      <div className="bg-white w-[70vw] h-[80vh] rounded shadow-xl flex flex-col">
        <header className="flex items-center justify-between px-4 py-2 border-b">
          <h2 className="font-semibold">模板管理</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700">✕</button>
        </header>
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧：列表 */}
          <aside className="w-56 border-r overflow-y-auto p-2 text-sm">
            <div className="text-xs text-slate-500 px-2 py-1">内置（只读）</div>
            {list.filter((t) => t.builtin).map((t) => (
              <button
                key={t.id}
                onClick={() => startEdit(t)}
                className="w-full text-left px-2 py-1 rounded hover:bg-slate-100"
              >
                {t.name}
              </button>
            ))}
            <div className="text-xs text-slate-500 px-2 py-1 mt-3">自定义</div>
            {list.filter((t) => !t.builtin).length === 0 && (
              <div className="px-2 py-1 text-slate-400 italic">(空)</div>
            )}
            {list.filter((t) => !t.builtin).map((t) => (
              <div key={t.id} className="flex items-center gap-1">
                <button
                  onClick={() => startEdit(t)}
                  className="flex-1 text-left px-2 py-1 rounded hover:bg-slate-100"
                >
                  {t.name}
                </button>
                <button
                  onClick={() => handleDelete(t.id)}
                  className="px-1 text-red-500 hover:bg-red-50 rounded"
                  title="删除"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={startNew}
              className="w-full mt-3 px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              + 新建自定义
            </button>
          </aside>

          {/* 右侧：表单 */}
          <section className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
            {error && <div className="px-3 py-2 bg-red-50 text-red-700 rounded">{error}</div>}

            <Field label="名称">
              <input
                value={editing.name}
                onChange={(e) => updateField('name', e.target.value)}
                className="w-full border rounded px-2 py-1"
              />
            </Field>
            <Field label="模板 ID">
              <input
                value={editing.id}
                onChange={(e) => updateField('id', e.target.value)}
                className="w-full border rounded px-2 py-1 font-mono text-xs"
                placeholder="my-renderer-log"
              />
            </Field>
            <Field label="正则（命名捕获组）">
              <textarea
                value={editing.pattern}
                onChange={(e) => updateField('pattern', e.target.value)}
                rows={3}
                className="w-full border rounded px-2 py-1 font-mono text-xs"
                placeholder="^\\[(?P<ts>[^\\]]+)\\] \\[(?P<level>[^\\]]+)\\] (?P<message>.*)$"
              />
            </Field>
            <Field label="起始行正则">
              <input
                value={editing.start_pattern}
                onChange={(e) => updateField('start_pattern', e.target.value)}
                className="w-full border rounded px-2 py-1 font-mono text-xs"
                placeholder="^\\[\\d{4}-\\d{2}-\\d{2}"
              />
            </Field>
            <Field label="时间格式（每行一个 chrono format string）">
              <textarea
                value={editing.time_formats.join('\n')}
                onChange={(e) => updateField('time_formats', e.target.value.split('\n').filter((s) => s.trim()))}
                rows={2}
                className="w-full border rounded px-2 py-1 font-mono text-xs"
                placeholder="%Y-%m-%d %H:%M:%S%.3f"
              />
            </Field>

            <div className="space-y-1">
              <div className="text-xs text-slate-500">字段映射（→ 正则里的命名捕获组）</div>
              {(['timestamp', 'level', 'scope', 'message'] as const).map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <span className="w-20 text-xs">{k}</span>
                  <input
                    value={editing.field_map[k] ?? ''}
                    onChange={(e) => updateFieldMap(k, e.target.value)}
                    className="flex-1 border rounded px-2 py-0.5 font-mono text-xs"
                    placeholder={k}
                  />
                </div>
              ))}
            </div>

            <Field label="Tail 解析">
              <select
                value={editing.tail_parser}
                onChange={(e) => updateField('tail_parser', e.target.value as TailParserKind)}
                className="border rounded px-2 py-1"
              >
                <option value="none">无</option>
                <option value="json_object">严格 JSON</option>
                <option value="json_like">JsonLike（JSON + JSON5 + raw 兜底）</option>
              </select>
            </Field>

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

            {testResult && (
              <div className="border rounded p-2 mt-2">
                <div className="text-xs text-slate-500 mb-1">
                  命中率 {(testResult.hit_rate * 100).toFixed(0)}% · 字段完整度 {(testResult.field_completeness * 100).toFixed(0)}%
                </div>
                <ul className="space-y-0.5">
                  {testResult.samples.map((s) => (
                    <li key={s.line_no} className="font-mono text-xs flex gap-2">
                      <span className="text-slate-400 w-12">#{s.line_no}{s.line_count > 1 ? `-${s.line_no + s.line_count - 1}` : ''}</span>
                      <span className={s.ok ? 'text-green-600' : 'text-red-600'}>{s.ok ? '✓' : '✗'}</span>
                      <span className="truncate flex-1">{s.ok ? `${s.level} [${s.scope ?? '-'}] ${s.message}` : s.raw.slice(0, 80)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500 mb-0.5">{label}</div>
      {children}
    </div>
  );
}
```

注意：上面 placeholder 里用 `r'...'` 是 Rust 风格，TSX 不支持，要改成普通字符串。修复：

把 `placeholder={r'^\[(?P<ts>[^\]]+)\] \[(?P<level>[^\]]+)\] (?P<message>.*)$'}` 改为：
```tsx
placeholder="^\\[(?P<ts>[^\\]]+)\\] \\[(?P<level>[^\\]]+)\\] (?P<message>.*)$"
```

和 `placeholder={r'^\[\d{4}-\d{2}-\d{2}'}` 改为：
```tsx
placeholder="^\\[\\d{4}-\\d{2}-\\d{2}"
```

- [ ] **Step 2：App.tsx 替换占位**

把 `App.tsx` 里 `{showManager && (...)}` 整段替换为：

```tsx
{showManager && <TemplateManagerDialog onClose={() => setShowManager(false)} />}
```

并在顶部 import 加：
```tsx
import { TemplateManagerDialog } from './components/TemplateManagerDialog';
```

- [ ] **Step 3：验证 + commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm run build 2>&1 | tail -5
```

Expected: 编译通过。

```bash
git add src/components/TemplateManagerDialog.tsx src/App.tsx
git commit -m "feat(fe): TemplateManagerDialog with test preview + save/delete"
```

---

## Phase 8：端到端验证 + 收尾

### Task 8.1：跑全部测试 + 手动验收清单

- [ ] **Step 1：Rust 全测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer/src-tauri" && $HOME/.cargo/bin/cargo test 2>&1 | tail -20
```

Expected: 全部通过。预计 lib 测试数 ≈ 31（Plan 1）+ 5（json_lines is_record_start）+ 4（grouping）+ 6（tail_parser）+ 6（regex_template）+ 5（bracket_electron）+ 3（bracket_common）+ 2（python_default）+ 3（nginx_combined）+ 5（logfmt）+ 2（registry）+ 3（sniff）+ 5（prefs） = **80 lib tests**；集成 1（Plan 1）+ 5（sniff） = 6。

- [ ] **Step 2：前端测试**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer" && npm test 2>&1 | tail -5
```

Expected: 1 pass（FilterBar，Plan 1 已有）。

- [ ] **Step 3：手动验收 — 让用户启动应用按清单跑**

提示用户运行 `npm run tauri dev`，按下面的清单逐项验证。每项验证完打勾。

- [ ] 打开 `/Users/kimyeung/Library/Logs/scrm-client/main.log`
- [ ] 顶部条显示"模板 bracket-electron"（不再是 json-lines）
- [ ] 列表条目大部分有 INFO/WARN/ERROR 颜色（不再全 UNKNOWN）
- [ ] 至少能看到一行以 `#11-13` 这种范围行号显示的多行 entry
- [ ] StatsPanel "总数 / level 分组" 反映实际比例（不再是 N / UNKNOWN N）
- [ ] Top scope 显示像 `main/network-manager`、`network`、`app-update` 这种名字
- [ ] 顶部 "模板 ▾" 下拉打开，列出 6 个内置模板（前面带 ✓ 表示当前）
- [ ] 切到 `bracket-common` → 列表瞬间全部变成 UNKNOWN（因为格式不匹配），切回 `bracket-electron` 恢复
- [ ] 点 "管理模板…" → 弹出模态，能看到内置列表 + "+新建自定义"按钮
- [ ] 新建自定义：填写名称 `test-renderer` / ID `test-renderer` / 一个简单正则（如 `^(?P<message>.*)$`）/ 起始行 `^.` → 点 "测试解析" 显示前 10 条结果 → 点 "保存"
- [ ] 关闭模态后顶部下拉重新打开，下拉里出现 "自定义 / test-renderer"
- [ ] 切到 test-renderer → 列表用该模板重新解析
- [ ] 重启应用（关闭窗口 → 重新 `npm run tauri dev`）→ 自定义模板仍在（持久化生效）

如果任何项失败 → 停下定位问题、修复、重测；不要继续 Task 8.2。

- [ ] **Step 4：commit（如果有 fix）**

如果上述清单顺利通过，无需 commit。如果发现 bug 修了，加常规 fix commit。

---

### Task 8.2：README 更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1：更新 README**

覆盖 `README.md`：

````markdown
# Log Viewer

桌面 GUI 日志查看与分析工具（Tauri + React + TypeScript）。

## 当前状态：Plan 2a 已完成

已实现：
- 6 种内置解析模板：`json-lines` / `bracket-electron` / `bracket-common` / `logfmt` / `python-default` / `nginx-combined`
- 打开文件自动嗅探最合适的模板
- 多行 entry 自动合并（如 electron-log 尾部 JSON 跨行）
- 顶部下拉手动切换模板
- 模板管理对话框：新建/删除自定义正则模板，"试解析"实时预览
- 自定义模板持久化到 `~/Library/Application Support/log-viewer/prefs.json`
- 按级别 / scope（exact/glob/regex）/ 时间区间 / 关键词筛选
- 虚拟滚动列表（按需分页）
- 总数 + level 分组 + Top scope 统计

未实现（见 Plan 2b）：
- 实时跟踪（tail -f）
- 详情抽屉
- 时间桶趋势图（sparkline）
- 轮转检测

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
````

- [ ] **Step 2：commit**

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git add README.md
git commit -m "docs: update README for Plan 2a (multi-template + sniffer + manager)"
```

---

## 完成判定

Plan 2a 完成的硬性条件：

- [ ] `cargo test` 全绿（≈ 80 lib + 6 integration）
- [ ] `npm test` 全绿
- [ ] Task 8.1 Step 3 的手动验收清单全部通过
- [ ] Git 历史按 task 分散提交（不要一坨大 commit）

完成后告诉 Claude："Plan 2a 完成，开始写 Plan 2b"。Plan 2b 会引入：
- 实时跟踪（watcher + 增量解析）
- 详情抽屉（行点击 → 右侧滑出）
- 时间桶趋势图 sparkline
- 文件轮转检测与询问
