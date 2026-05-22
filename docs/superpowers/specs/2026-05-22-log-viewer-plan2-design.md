# Log Viewer Plan 2 设计文档

- **日期**：2026-05-22
- **状态**：设计已认可，待生成实现计划
- **前置**：[2026-05-22-log-viewer-design.md](2026-05-22-log-viewer-design.md)（项目总 spec）；[Plan 1 MVP](../plans/2026-05-22-log-viewer-plan-1-mvp.md)（已实施完毕）

---

## 1. 范围

| 子系统 | 内容 |
|---|---|
| **解析** | 5 个新增内置模板 + 自动嗅探算法 + 多行合并 + 尾部 JSON5 解析 |
| **模板管理** | 顶部下拉切换模板 + "模板管理"对话框（新建/编辑/删除自定义模板、试解析预览） |
| **实时跟踪** | `notify` watcher 监听文件追加 → 增量解析（含多行）→ 前端事件追加；顶部 toggle；离开底部时浮动"↓N 条新日志"；轮转弹询问 |
| **详情抽屉** | 点击列表行 → 右侧 35vw 抽屉显示 `fields` + `raw`；↑/↓/Esc 键导航 |
| **时间趋势 sparkline** | StatsPanel 内嵌（≈60px 高）；按 level 堆叠的 AreaChart；时间桶自适应 |
| **持久化** | `prefs.json` 存自定义模板（系统标准 `config_dir`） |

### 1.1 内置模板清单（共 6 个）

| ID | 形态 | 来源场景 |
|---|---|---|
| `json-lines` | `{"time":"...","level":"info","msg":"..."}` | Plan 1 已实现 |
| **`bracket-electron`** | `[2026-05-21 17:26:37.566] [info] (main/network-manager) message {fields...}` | electron-log，**用户的 main.log** |
| `bracket-common` | `2026-05-22 12:00:00 [INFO] [auth] login ok` | Java logback / Go zap 默认 |
| `logfmt` | `time=... level=info logger=auth msg="..."` | Heroku / Kubernetes |
| `python-default` | `2026-05-22 12:00:00,123 - auth - INFO - login ok` | Python `logging` 默认 |
| `nginx-combined` | `127.0.0.1 - - [22/May/2026:12:00:00 +0000] "GET ..."` | Nginx access log |

### 1.2 嗅探策略

读首 200 行，对每个模板（内置 + 已保存自定义）跑：
1. `is_record_start` 切分逻辑日志
2. `parse_record` 解析每条
3. 算 `confidence = parsed_ok_rate * 0.6 + field_completeness * 0.4`

字段完整度 = `(timestamp + level + scope + message 非空)` 平均：

| confidence | 行为 |
|---|---|
| ≥ 0.8 | `AutoMatch`：静默用 |
| ≥ 0.4 | `Suggested`：弹"看起来是 X 格式，确认 / 换 / 自定义" |
| < 0.4 | `NoMatch`：弹模板选择 + 新建自定义入口 |

---

## 2. 解析器架构

### 2.1 模板抽象升级

```rust
pub trait ParserTemplate: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    /// 判断一行是否是新日志的起点。续行追加到前一条
    fn is_record_start(&self, line: &str) -> bool;
    /// 在合并后的 N 行上解析（lines[0] 是起始行）
    fn parse_record(&self, lines: &[String]) -> Option<PartialEntry>;
}
```

Plan 1 的 JsonLinesTemplate 改造：
- `is_record_start`：去首尾空白后以 `{` 开头并 `serde_json::from_str` 成功
- `parse_record`：只看 lines[0]，其余忽略（JSON Lines 不跨行）

### 2.2 通用 RegexTemplate（多模板复用）

```rust
pub struct RegexTemplate {
    id: String,
    name: String,
    pattern: Regex,                    // 命名捕获组
    start_pattern: Regex,              // is_record_start 用
    time_formats: Vec<String>,         // 多个候选 chrono 格式
    field_map: FieldMap,
    tail_parser: Option<TailParser>,
}

enum TailParser {
    JsonObject,        // 严格 JSON
    JsonLike,          // serde_json → json5 → fallback _raw_tail
}
```

`parse_record(&self, lines)` 流程：
1. 主正则跑 lines[0]，按 field_map 抓 ts / level / scope / message
2. 如果 lines.len() > 1，把 lines[1..] join 入 message 后端
3. 如果 tail_parser 不为 None：从合并后的 raw 匹配 `\{[\s\S]*\}\s*$`，扔给 tail_parser
4. tail_parser 解析出的 key-value 合并到 fields（值字符串化）

### 2.3 bracket-electron 具体设计

样例输入（3 行）：
```
[2026-05-21 17:26:37.760] [info] [app-update] service started {
    feedUrl: 'https://djs-download.s3.ap-southeast-1.amazonaws.com/releases/dujiaoshou/',
    channel: 'latest'
}
```

- `start_pattern`: `^\[\d{4}-\d{2}-\d{2}[ T]`
- `pattern`（主）: `^\[(?P<ts>[^\]]+)\] \[(?P<level>[^\]]+)\] \((?P<scope>[^\)]+)\) (?P<message>.*)$`
- `time_formats`: `["%Y-%m-%d %H:%M:%S%.3f", "%Y-%m-%dT%H:%M:%S%.fZ"]`
- `tail_parser`: `JsonLike`

注意 `(?P<scope>[^\)]+)` 匹配圆括号内任意非 `)` —— 适配 `(network)`、`(main/network-manager)` 等。

`bracket-common` 与 `bracket-electron` 区别：scope 用 `\[...\]` 而非 `\(...\)`，level 在 ts 之后用方括号包裹。

### 2.4 logfmt 专用解析器

logfmt 的 `key=value` 语法对正则不友好（值含空格时要带引号），用专用状态机：

```rust
pub struct LogfmtTemplate;

impl ParserTemplate for LogfmtTemplate {
    fn is_record_start(&self, line: &str) -> bool {
        // 含 = 且不以空白开头（logfmt 几乎不跨行）
        !line.starts_with(char::is_whitespace) && line.contains('=')
    }
    fn parse_record(&self, lines: &[String]) -> Option<PartialEntry> {
        let line = &lines[0];
        let pairs = parse_logfmt(line)?;
        // 映射 time/ts → timestamp, level/lvl → level, logger/scope → scope, msg/message → message
        // 剩下进 fields
    }
}

/// 简易 logfmt 解析：key=value 或 key="quoted value"
fn parse_logfmt(s: &str) -> Option<Vec<(String, String)>>;
```

### 2.5 嗅探打分细化

为避免 bracket-electron 和 bracket-common 互相误匹（两者都含方括号），打分公式：

```
confidence = parsed_ok_rate * 0.6 + field_completeness * 0.4
field_completeness = mean(
    timestamp_filled,
    level_filled,
    scope_filled,
    message_non_empty,
)
```

bracket-electron 在 user main.log 上 → 4 字段全填、命中 100% → confidence ≈ 1.0。bracket-common 因 `(scope)` 不被方括号正则捕获，scope 为空，field_completeness ≤ 0.75，命中率也低，confidence 显著低于 bracket-electron。

### 2.6 多行合并机制

**Phase A — 行合并**：扫描原始行，按当前选定模板的 `is_record_start` 切分逻辑日志：

```rust
fn group_records<T: ParserTemplate>(
    tpl: &T, lines: &[String]
) -> Vec<RawRecord> {
    let mut out: Vec<RawRecord> = Vec::new();
    let mut current: Option<RawRecord> = None;
    for (i, line) in lines.iter().enumerate() {
        if tpl.is_record_start(line) || current.is_none() {
            if let Some(r) = current.take() { out.push(r); }
            current = Some(RawRecord {
                start_line: (i + 1) as u32,
                lines: vec![line.clone()],
            });
        } else if let Some(r) = current.as_mut() {
            r.lines.push(line.clone());
        }
    }
    if let Some(r) = current { out.push(r); }
    out
}

pub struct RawRecord {
    pub start_line: u32,
    pub lines: Vec<String>,
}
```

**Phase B — 模板解析**：rayon 并行对每个 RawRecord 调 `tpl.parse_record(&r.lines)`，包装成 LogEntry（含 `line_count = r.lines.len()`）。

**孤立续行兜底**：如果文件第一行不是 record_start（罕见，如文件被截断头部），前段"孤儿行"包成一条 fallback LogEntry（level=Unknown）。这是 `current.is_none()` 分支的语义。

### 2.7 LogEntry 模型变化

```rust
pub struct LogEntry {
    pub line_no: u32,        // 起始行号
    pub line_count: u32,     // NEW：占用的原始行数（≥1）
    pub timestamp: Option<DateTime<Utc>>,
    pub level: LogLevel,
    pub scope: Option<String>,
    pub message: String,
    pub fields: HashMap<String, String>,
    pub raw: String,         // 所有原始行用 \n 连接
}
```

前后端类型同步：TS `LogEntry` 加 `line_count: number`。

### 2.8 文件结构

```
src-tauri/src/parser/
├── mod.rs                  (修改：注册表 + sniff 调度)
├── template.rs             (修改：加 is_record_start + 改 parse_record 签名)
├── level.rs
├── json_lines.rs           (修改：实现 is_record_start)
├── regex_template.rs       (新)
├── tail_parser.rs          (新)
├── sniff.rs                (新)
└── builtin/
    ├── mod.rs              (新：导出 5 个模板 + 注册到全局 registry)
    ├── bracket_electron.rs
    ├── bracket_common.rs
    ├── logfmt.rs
    ├── python_default.rs
    └── nginx_combined.rs
```

### 2.9 新增依赖

```toml
json5 = "0.4"           # 宽松 JSON5 解析
notify = "6"            # 文件监听（§4 用）
directories = "5"       # 找系统 config_dir（§3.4 用）
```

---

## 3. 模板管理 UI

### 3.1 入口

顶部 header 加按钮：
```
☰ Log Viewer  [打开日志文件]  [模板: bracket-electron ▾]   ⚡ 实时跟踪 ○   路径 · 行数
```

### 3.2 模板下拉

```
当前: bracket-electron   ✓
─────────────────────────
内置：
  json-lines
  bracket-electron ✓
  bracket-common
  logfmt
  python-default
  nginx-combined
─────────────────────────
自定义：
  my-renderer-log
─────────────────────────
⚙ 管理模板…
```

点击任一模板 → 调 `cmd_reparse_with_template` 用该模板**重新解析当前文件**（复用已读 lines，不重读磁盘），更新 metadata + 列表 + 统计。

### 3.3 "管理模板" 对话框

70vw × 80vh 模态，左右两栏：

- **左**：模板列表（内置只读，自定义可编辑/删除），底部 `[+ 新建自定义]`
- **右**：表单
  - 名称 / 模板 ID
  - 正则（命名捕获组）—— 实时校验，错误标红并禁用保存
  - 起始行正则
  - 时间格式（多行，每行一个 chrono 格式串，按序尝试）
  - 字段映射（timestamp/level/scope/message → 源字段名）
  - Tail 解析（无 / JSON / JsonLike）
  - 试解析当前文件前 10 行（命中率 + 字段填充情况）
  - `[测试解析]` / `[保存]` / `[删除]` / `[取消]`

### 3.4 持久化：`prefs.json`

存放位置：`{config_dir()}/log-viewer/prefs.json`
- macOS: `~/Library/Application Support/log-viewer/`
- Linux: `~/.config/log-viewer/`
- Windows: `%APPDATA%\log-viewer\`

格式：
```json
{
  "version": 1,
  "custom_templates": [
    {
      "id": "my-renderer-log",
      "name": "My Renderer Log",
      "pattern": "^\\[(?P<ts>[^\\]]+)\\] (?P<level>\\w+) (?P<scope>\\S+) (?P<message>.*)$",
      "start_pattern": "^\\[\\d{4}-\\d{2}-\\d{2}",
      "time_formats": ["%Y-%m-%d %H:%M:%S%.3f"],
      "field_map": { "timestamp": "ts", "level": "level", "scope": "scope", "message": "message" },
      "tail_parser": "json_like"
    }
  ]
}
```

启动时加载 → 加入嗅探池 + 注册表。损坏：备份为 `prefs.json.bak.{ts}` + 重置为默认。

### 3.5 新增 Tauri commands

```rust
#[tauri::command] fn cmd_list_templates() -> Vec<TemplateInfo>;
#[tauri::command] fn cmd_save_custom_template(t: CustomTemplate) -> Result<(), AppError>;
#[tauri::command] fn cmd_delete_custom_template(id: String) -> Result<(), AppError>;
#[tauri::command] fn cmd_test_template(t: CustomTemplate, limit: u32) -> Result<TestResult, AppError>;
#[tauri::command] fn cmd_reparse_with_template(template_id: String) -> Result<FileMetadata, AppError>;
```

`TestResult`：
```rust
pub struct TestResult {
    pub samples: Vec<TestSample>,   // 前 limit 行的解析结果
    pub hit_rate: f32,
    pub field_completeness: f32,
}

pub struct TestSample {
    pub line_no: u32,
    pub raw: String,
    pub parsed: Option<PartialEntryPreview>,
    pub error: Option<String>,
}
```

---

## 4. 实时跟踪（tail -f）

### 4.1 用户体验

```
顶部 toggle： ⚡ 实时跟踪 [○]     默认关
       打开后：⚡ 实时跟踪 [●]     脉冲指示器
```

- 开启 → 启动 watcher，文件追加 → 增量解析 → Tauri event 推给前端
- 用户**在底部** → 新条目自动追加，自动滚到底
- 用户**滚动离开底部** → 右下角浮动按钮 `↓ N 条新日志`，点击跳底
- 关闭 → 卸载 watcher，已追加的条目保留；再开继续从当前位置（不从头重读）

### 4.2 后端：`loader/watcher.rs`

```rust
pub struct FileWatcher {
    handle: notify::RecommendedWatcher,
    abort: Arc<AtomicBool>,
}

impl FileWatcher {
    pub fn start(
        path: PathBuf,
        last_offset: Arc<AtomicU64>,
        last_inode: u64,
        template_id: String,
        next_line_no: Arc<AtomicU32>,
        on_append: impl Fn(Vec<LogEntry>) + Send + Sync + 'static,
        on_rotation: impl Fn(RotationEvent) + Send + Sync + 'static,
    ) -> Result<Self, AppError>;
    pub fn stop(self);
}

pub enum RotationEvent {
    Truncated,
    InodeChanged,
    Removed,
}
```

`notify` 触发 `Modify` 事件 → `seek(last_offset)` → 读到 EOF → 按行切分。不完整尾行（最后一段没 `\n`）→ 回退到 last_offset 之前对应位置，等下次事件再处理。

**增量行合并**：维护 `pending_lines: Vec<String>` 缓冲：
- 收到新行：如果 `is_record_start` → 把当前 pending 收尾成一条 LogEntry 推送，开新 buffer 放此行
- 否则追加到 pending
- 500ms 内无新行 → 把当前 pending 收尾推送（避免最后一条多行 entry 长时间卡在缓冲不出现）

### 4.3 文件轮转检测

每次 watcher 事件触发时：
- `file.metadata().len() < last_offset` → `Truncated`
- 通过 `MetadataExt::ino()` 比对 → 不一致 → `InodeChanged`
- 文件不存在 → `Removed`

前端弹窗（`RotationDialog`）：
- `Truncated`: "文件被截断（可能日志轮转）。重新加载 / 仅停止跟踪？"
- `InodeChanged`: "文件被替换。重新加载新文件 / 继续跟踪旧 inode / 停止跟踪？"
- `Removed`: 直接 toast"文件已删除，已停止跟踪"

### 4.4 前端

`src/hooks/useTailFollow.ts`：
```ts
export function useTailFollow() {
  const { follow, metadata, setMetadata, appendEntries } = useSession();
  useEffect(() => {
    if (!metadata || !follow) return;
    const unsubAppend = listen('entries_appended', (e) => {
      appendEntries(e.payload.entries);
      cmdGetMetadata().then(setMetadata);
    });
    const unsubRotate = listen('file_rotated', (e) => {
      // 弹 RotationDialog
    });
    return () => { unsubAppend(); unsubRotate(); };
  }, [follow, metadata, setMetadata, appendEntries]);
}
```

zustand store 扩展：
```ts
follow: boolean;
selectedLineNo: number | null;
setFollow: (b: boolean) => void;
setSelectedLineNo: (n: number | null) => void;
appendEntries: (entries: LogEntry[]) => void;   // 追加到 result.page_entries 末尾、total_matched++
```

### 4.5 新增 Tauri commands

```rust
#[tauri::command] fn cmd_start_follow(state: State<SessionState>) -> Result<(), AppError>;
#[tauri::command] fn cmd_stop_follow(state: State<SessionState>) -> Result<(), AppError>;
```

Watcher 句柄保存到 `SessionState`（`Option<FileWatcher>`），关闭文件时自动 stop。

---

## 5. 详情抽屉 + 时间趋势 sparkline

### 5.1 详情抽屉

- **触发**：点击列表行 → 右侧滑出抽屉（宽 35vw，最小 380px，最大 720px）
- **关闭**：再点该行 / 点抽屉空白处 / Esc / 右上角 `✕`
- **导航**：抽屉里 `↑/↓` 切到上/下一条匹配，同步列表高亮

布局：
```
┌────── 详情 #11-13 ───────────────────────[✕]┐
│ 时间   2026-05-21 17:26:37.760              │
│ 级别   INFO                                 │
│ Scope  app-update                           │
│ 行号   #11–13 (3 行)                        │
├─────────────────────────────────────────────┤
│ Message                                     │
│ ┌─────────────────────────────────────────┐ │
│ │ service started                         │ │
│ └─────────────────────────────────────────┘ │
├─────────────────────────────────────────────┤
│ Fields (2)                                  │
│ ┌─────────────────────────────────────────┐ │
│ │ feedUrl   https://djs-download.s3...    │ │
│ │ channel   latest                        │ │
│ └─────────────────────────────────────────┘ │
├─────────────────────────────────────────────┤
│ Raw                                  [📋复制]│
│ ┌─────────────────────────────────────────┐ │
│ │ [2026-05-21 17:26:37.760] [info] [app...│ │
│ │     feedUrl: '...',                     │ │
│ │     channel: 'latest'                   │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ [应用 scope 筛选] [按时间区间 ±5 分钟]      │
└─────────────────────────────────────────────┘
```

实现：`src/components/DetailDrawer.tsx`，从 zustand 读 `selectedLineNo`。LogList Row 加 onClick + 高亮（`bg-blue-50`）。

底部快捷按钮：
- **应用 scope 筛选** → `patchSpec({ scope_filter: { field_name: 'scope', pattern: entry.scope, mode: 'exact' } })`
- **按时间区间 ±5 分钟** → `patchSpec({ time_range: [entry.timestamp - 5min, entry.timestamp + 5min] })`

### 5.2 时间趋势 sparkline

**位置**：嵌入 StatsPanel 顶部，约 60px 高，全宽
**桶宽自适应**：

```ts
function pickBucketSize(durationMs: number): 'minute' | 'hour' | 'day' {
  if (durationMs <= 2 * 3600 * 1000)       return 'minute';
  if (durationMs <= 2 * 24 * 3600 * 1000)  return 'hour';
  return 'day';
}
```

桶数恒定 60 个，桶宽 = `时间范围 / 60` 向最近预设单位 round。

**后端聚合**：

```rust
pub struct TimeBucket {
    pub bucket_start: DateTime<Utc>,
    pub total: u32,
    pub by_level: HashMap<LogLevel, u32>,
}

pub fn time_buckets(
    entries: &[LogEntry],
    matched: &[u32],
    range: (DateTime<Utc>, DateTime<Utc>),
    bucket_count: u32,
) -> Vec<TimeBucket>;
```

调度：`run_query` 同时算 stats + time_buckets。挂在 `QueryResponse.stats.time_buckets`。

**前端（recharts AreaChart 堆叠）**：

```tsx
<ResponsiveContainer width="100%" height={60}>
  <AreaChart data={timeBuckets} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
    <Area dataKey="error" stackId="1" stroke="#b91c1c" fill="#fecaca" />
    <Area dataKey="warn"  stackId="1" stroke="#a16207" fill="#fde68a" />
    <Area dataKey="info"  stackId="1" stroke="#1d4ed8" fill="#bfdbfe" />
    <Area dataKey="debug" stackId="1" stroke="#0e7490" fill="#a5f3fc" />
    <Area dataKey="trace" stackId="1" stroke="#475569" fill="#e2e8f0" />
    <Tooltip formatter={(v, name) => [`${v} 条`, name]} labelFormatter={fmtBucketLabel} />
    <Brush dataKey="bucket_start" height={12} />
  </AreaChart>
</ResponsiveContainer>
```

无坐标轴节省高度，hover 显示 tooltip：`2026-05-21 17:26 ~ 17:27 · ERROR 3, INFO 42`。

**交互**：用 recharts `<Brush />` 拖选时间段 → `patchSpec({ time_range: [bucketStart, bucketEnd] })` 收窄筛选。

**降级**：
- 文件无任何 timestamp → 显示"无时间数据"提示
- 筛选后 < 3 个时间点 → sparkline 隐藏

---

## 6. 测试策略 + 项目结构变化

### 6.1 Rust 后端测试

| 模块 | 测试 |
|---|---|
| `parser/regex_template.rs` | 单测：5 个 RegexTemplate 各跑 5+ 真实样例（bracket-electron 含多行 + JSON5） |
| `parser/tail_parser.rs` | 严格 JSON / json5 / 整段兜底三种路径 |
| `parser/sniff.rs` | 给定 fixture，断言返回正确 SniffResult |
| `parser/mod.rs`（合并算法） | 给含多行 entry 的 fixture，验证 line_count、raw、fields 正确 |
| `loader/watcher.rs` | tempfile 创建文件 → start watcher → 追加 → 等事件 → 断言；轮转测试 |
| `stats/aggregator.rs` | `time_buckets` 函数桶划分 + 堆叠数据正确 |
| `prefs/store.rs` | 读 / 写 / 损坏文件回退 |
| 集成 `integration_bracket_electron.rs` | 真实多行 fixture 端到端 |

### 6.2 前端测试

- `DetailDrawer.test.tsx` — 点 row 打开抽屉、Esc 关闭、↑/↓ 切换
- `useTailFollow.test.tsx` — mock Tauri event，验证 entries_appended 触发列表追加
- `TemplateManagerDialog.test.tsx` — 输入正则后"试解析"触发 cmd_test_template、显示命中率
- `TrendSparkline.test.tsx` — time_buckets 为空时不渲染

### 6.3 Fixtures 新增

```
src-tauri/tests/fixtures/
├── sample.jsonl                       # Plan 1 已有
├── electron-multiline.log             # 从用户 main.log 截前 200 行匿名化
├── bracket-common.log
├── logfmt.log
├── python.log
├── nginx-access.log
└── mixed-noise.log                    # 前半 bracket-electron 后半 garbage，验证嗅探鲁棒性
```

### 6.4 项目结构变化总览

```
src-tauri/src/
├── parser/
│   ├── mod.rs              (修改：注册表 + sniff 调度 + 多行合并)
│   ├── template.rs         (修改：加 is_record_start)
│   ├── level.rs
│   ├── json_lines.rs       (修改：实现 is_record_start)
│   ├── regex_template.rs   (新)
│   ├── tail_parser.rs      (新)
│   ├── sniff.rs            (新)
│   └── builtin/
│       ├── mod.rs                       (新)
│       ├── bracket_electron.rs          (新)
│       ├── bracket_common.rs            (新)
│       ├── logfmt.rs                    (新)
│       ├── python_default.rs            (新)
│       └── nginx_combined.rs            (新)
├── loader/
│   ├── reader.rs           (修改：暴露 byte_offset 给 watcher)
│   └── watcher.rs          (新)
├── session/
│   └── state.rs            (修改：加 watcher 句柄、follow 状态、line_no 续号)
├── stats/aggregator.rs     (修改：加 time_buckets)
├── prefs/                  (新模块)
│   ├── mod.rs
│   └── store.rs
├── model.rs                (修改：LogEntry 加 line_count、Stats 加 time_buckets)
└── commands.rs             (修改 + 7 个新命令：5 个模板管理 + 2 个实时跟踪)

src/
├── components/
│   ├── DetailDrawer.tsx               (新)
│   ├── TemplateMenu.tsx               (新：顶部下拉)
│   ├── TemplateManagerDialog.tsx      (新：管理模态)
│   ├── TrendSparkline.tsx             (新：嵌入 StatsPanel)
│   ├── FollowToggle.tsx               (新：顶部 toggle)
│   └── RotationDialog.tsx             (新：轮转询问)
├── hooks/
│   ├── useTailFollow.ts               (新)
│   └── useKeyboardNav.ts              (新：抽屉里 ↑/↓)
├── state/session.ts                   (修改：加 follow / selectedLineNo / appendEntries)
├── api/commands.ts                    (修改：加 8 个新方法)
└── types/log.ts                       (修改：LogEntry.line_count / Stats.time_buckets)
```

### 6.5 完成判定

- [ ] `cargo test` 全绿（含所有新增模板单测 + watcher 集成）
- [ ] `npm test` 全绿
- [ ] `npm run tauri dev` 启动后：
  - [ ] 打开真实 main.log → 顶部模板自动识别为 `bracket-electron`
  - [ ] 列表显示带颜色的条目，多行 entry 显示为 `#11-13` 范围
  - [ ] StatsPanel 显示 level 分组（不再全 UNKNOWN）+ sparkline
  - [ ] 点击一行 → 右侧抽屉显示 message + fields + raw
  - [ ] 抽屉里 ↑/↓ 切换条目
  - [ ] 顶部模板下拉 → 切到 bracket-common → 列表重新解析（命中率显著低）
  - [ ] 模板管理对话框 → 新建自定义 → 试解析 → 保存 → 重新打开命中率提升
  - [ ] 实时跟踪 toggle 开 → `echo "..." >> main.log` → 1s 内列表自动多一条
  - [ ] 滚动到上方 → 追加新行 → 右下角浮动按钮 `↓ 1 条新日志` → 点击跳底

### 6.6 估算工作量

Plan 2 约 **35-40 个 task**：
- 解析子系统重构 + 5 个新模板：~10 task
- 模板管理 UI + 自定义模板持久化：~6 task
- watcher + 实时跟踪前后端：~6 task
- 详情抽屉 + 时间趋势：~5 task
- 模型迁移（line_count）+ 端到端验证：~5 task
- 文档 + 收尾：~3 task

预计 token 消耗 1.2-1.8M，时间 4-7 小时（如完整 subagent-driven 执行）。

---

## 7. 设计认可

- 范围 §1：✅
- 解析器架构 §2（含 §2.6 多行合并）：✅
- 模板管理 UI §3：✅
- 实时跟踪 §4：✅
- 详情抽屉 + 趋势 sparkline §5：✅
- 测试 + 项目结构 + 完成判定 §6：✅
