# Log Viewer 设计文档

- **日期**：2026-05-22
- **状态**：设计已认可，待生成实现计划
- **作者**：用户 + Claude（brainstorming）

---

## 1. 概述

一个本地桌面 GUI 应用，用于查看与分析 `.log` 日志文件。核心能力：**按时间区间 / 日志级别 / scope 筛选 + 统计数量 + 全文搜索 + 实时跟踪**。支持混合格式日志（通过预设模板 + 自动嗅探 + 自定义模板）。

## 2. 目标与非目标

### 2.1 目标（MVP）

- 打开任意 `.log` 文件（≤100MB 主流场景，最大 500MB 提示加载）
- 内置多种常见日志格式的解析模板，自动嗅探匹配
- 用户可手写正则模板并保存复用
- 多维度筛选：时间区间、级别（info/warn/error/debug/trace）、scope（模块名或任意字段）、全文关键词
- 统计面板：总数、按 level 分组、按 scope 分组（Top N）、按时间桶趋势图
- 实时跟踪（tail -f 风格）：监听文件追加，自动增量解析与展示
- 保存与复用筛选器
- 最近打开文件列表
- 导出筛选结果为 CSV / JSON

### 2.2 非目标（不在 MVP）

- 多文件合并查看 / 跨文件搜索
- 远程文件（SSH、HTTP）拉取
- 日志告警与规则引擎
- 长期存储与历史归档
- 团队协作 / 多人共享筛选器
- GB 级以上文件的流式架构（届时再做架构演进）

## 3. 用户需求确认（来自 brainstorming）

| 维度 | 选择 |
|---|---|
| 运行形态 | 桌面 GUI 应用 |
| 技术栈 | Tauri（Rust 后端 + Web 前端） |
| 日志格式 | 混合 / 不确定 → 预设模板 + 自动嗅探 |
| 文件大小 | 中等（1-100 MB） |
| 使用场景 | 历史文件 + 实时跟踪 两者都要 |
| scope 含义 | 模块名（默认） + 任意字段（用户可指定） |
| 统计维度 | 总数、按 level 分组、按 scope 分组、按时间桶趋势 |
| 扩展能力 | 最近文件、保存筛选器、全文搜索、CSV/JSON 导出 |

## 4. 技术栈

- **后端**：Rust + Tauri 2.x
  - `notify`：文件监听
  - `encoding_rs` + `chardetng`：字符集探测
  - `regex`：模板正则
  - `serde` / `serde_json`：序列化
  - `chrono`：时间解析
  - `rayon`：并行遍历
  - `parking_lot::RwLock`：Session 共享状态
  - `thiserror`：错误类型
  - `tempfile` / `criterion`：测试 & 性能基准
- **前端**：React + TypeScript + Tailwind CSS
  - `react-window`：虚拟列表
  - `recharts`：统计图表
  - `zustand`：状态管理
  - `vitest` + `@testing-library/react`：测试

## 5. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend（Web，跑在 WebView）            │
│  React + TypeScript + Tailwind                              │
│  ┌──────────┬─────────────┬──────────┬──────────────────┐   │
│  │ 文件面板 │ 筛选/搜索栏 │ 虚拟列表 │ 统计面板（图表）  │   │
│  └──────────┴─────────────┴──────────┴──────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │  Tauri Command / Event（JSON）
┌──────────────────────┴──────────────────────────────────────┐
│                    Backend（Rust）                          │
│  ┌────────────┬──────────────┬────────────┬──────────────┐  │
│  │ FileLoader │ ParserEngine │ QueryEngine│ StatsEngine  │  │
│  │ + Watcher  │ (模板+嗅探)  │ (筛选+搜索)│ (聚合)       │  │
│  └─────┬──────┴──────┬───────┴─────┬──────┴──────┬───────┘  │
│        └─────────────┴─────────────┴─────────────┘          │
│           ┌────────┴───────┐                                │
│           │  Session State │ Vec<Arc<LogEntry>> + 元数据    │
│           └────────┬───────┘                                │
│           ┌────────┴───────┐                                │
│           │  Preferences   │ 最近文件、筛选器、自定义模板  │
│           └────────────────┘                                │
└─────────────────────────────────────────────────────────────┘
```

## 6. 模块划分

| 模块 | 职责 | 关键依赖 |
|---|---|---|
| **FileLoader** | 读取文件、字符集探测、按行切分；监听文件变化做增量追加 | `notify`, `encoding_rs` |
| **ParserEngine** | 嗅探格式 → 选定模板 → 把每行解析为 `LogEntry`；用户可注册自定义模板 | `regex`, `serde_json` |
| **QueryEngine** | 接收 `QuerySpec`，并行筛选，返回匹配的条目索引 | `rayon` |
| **StatsEngine** | 在筛选结果上做聚合：总数 / level / scope / 时间桶 | `rayon`, `chrono` |
| **Session State** | 全内存保存当前文件的所有 `LogEntry`；`Arc` 共享 | `parking_lot::RwLock` |
| **Preferences** | 最近文件、保存的筛选器、用户自定义模板，JSON 持久化 | `serde_json` |
| **前端 UI** | 文件面板、筛选栏、虚拟列表、统计面板、模板选择器 | `react`, `react-window`, `recharts`, `zustand` |

## 7. 核心数据结构

```rust
struct LogEntry {
    line_no: u32,                       // 原文件行号
    timestamp: Option<DateTime<Utc>>,   // 可能解析失败
    level: LogLevel,                    // Info/Warn/Error/Debug/Trace/Unknown
    scope: Option<String>,              // 模块名（默认 logger/scope/module 字段）
    message: String,
    fields: HashMap<String, String>,    // 其他结构化字段（任意字段作为 scope 的来源）
    raw: String,                        // 原始行
}

enum LogLevel { Trace, Debug, Info, Warn, Error, Unknown }

struct QuerySpec {
    time_range: Option<(DateTime<Utc>, DateTime<Utc>)>,
    levels: Option<HashSet<LogLevel>>,
    scope_filter: Option<ScopeFilter>,
    text_search: Option<String>,
}

struct ScopeFilter {
    field_name: String,         // 默认 "scope"，可换 "logger" / "module" / 任意
    pattern: String,
    mode: MatchMode,            // Exact / Glob / Regex
}
```

**字段查找约定**：当 `field_name == "scope"` 时，QueryEngine 优先匹配 `LogEntry.scope`；否则统一在 `LogEntry.fields` 字典中按 `field_name` 取值。没有该字段的条目视为不匹配（除非用户显式勾选"包含缺失字段"）。

## 8. 关键数据流

### 8.1 打开文件 → 显示

```
用户选择文件
  ↓
[FE] cmd_open_file(path)
  ↓
[BE] FileLoader 流式读取（避免一次性大 String 分配）
  ↓
[BE] ParserEngine.sniff() 读首 100 行尝试匹配
  ↓ 选定模板 / 提示用户选择
[BE] 并行解析全部行（rayon），生成 Vec<LogEntry>
  ↓
[BE] 写入 Session State；返回元数据 {total, time_range, levels, scopes}
  ↓
[FE] 显示文件头、激活筛选栏、请求首页条目 + 首次统计
```

**字符集探测**：先用 BOM；无 BOM 则用 `chardetng`；失败回退 UTF-8（lossy 替换为 U+FFFD）。

### 8.2 筛选 → 列表 + 统计

```
[FE] 用户调整任一筛选条件（150ms debounce）
  ↓
[FE] cmd_query({spec, page: 0, page_size: 200})
  ↓
[BE] QueryEngine.filter() — rayon 并行遍历，返回 Vec<u32> 行号
  ↓
[BE] StatsEngine.aggregate(matched_indices) — 总数/level/scope/时间桶
  ↓
[BE] 返回 { page_entries, total_matched, stats }
  ↓
[FE] 虚拟列表渲染当前页；统计面板更新图表
[FE] 滚动时按需 cmd_query 拉后续页（同 spec，递增 page）
```

**缓存策略**：筛选结果在 BE 端按 `QuerySpec` 哈希缓存，后续翻页 / 重拉统计无需重算；spec 变化即失效。

### 8.3 实时跟踪（tail -f）

```
[BE] 打开时注册 notify Watcher
  ↓
文件追加 → notify 事件
  ↓
[BE] 从上次偏移读新增字节，按行切分，解析为新 LogEntry
  ↓
[BE] 追加到 Session State；广播 Tauri Event "entries_appended"
  ↓
[FE] 收到事件：
   - 用户在底部 → 增量过滤新条目，追加到列表
   - 用户在历史位置 → 右下角浮动按钮 "↓ N 条新日志"
```

**增量过滤**：QueryEngine 只对新增条目跑 filter，通过的追加到缓存。

## 9. 解析模板系统

### 9.1 模板定义

```rust
struct ParserTemplate {
    id: String,
    name: String,
    builtin: bool,
    kind: TemplateKind,
    field_map: FieldMap,
}

enum TemplateKind {
    JsonLines,
    Logfmt,
    Regex { pattern: String, time_format: String },
}

struct FieldMap {
    timestamp: String,     // 源字段名
    level: String,
    scope: String,
    message: String,
}
```

**Level 归一化**：从源字段取出字符串后，按大小写不敏感映射到 `LogLevel` 枚举：`trace→Trace`、`debug→Debug`、`info/information→Info`、`warn/warning→Warn`、`error/err/fatal/critical→Error`，其他一律 `Unknown`。映射表内置，不开放配置（YAGNI）。

### 9.2 内置模板（MVP 5 个）

| ID | 适用 | 示例 |
|---|---|---|
| `json-lines` | 结构化 JSON 日志 | `{"time":"...","level":"info","logger":"auth","msg":"..."}` |
| `logfmt` | logfmt 风格 | `time=... level=info logger=auth msg="..."` |
| `python-default` | Python logging 默认 | `2026-05-22 12:00:00,123 - auth - INFO - login ok` |
| `bracket-common` | 通用方括号格式 | `2026-05-22 12:00:00 [INFO] [auth] login ok` |
| `nginx-combined` | Nginx access log | `127.0.0.1 - - [22/May/2026:12:00:00 +0000] "GET ..."` |

### 9.3 自动嗅探算法

```
sniff(file) -> SniffResult:
    1. 读首 100 行（跳过空行）
    2. 对每个模板：
        a. 尝试解析这 100 行
        b. 命中率 = parsed_ok / sampled
        c. 置信度 = 命中率 + 字段完整度加权
    3. 排序，取最高分：
        - 置信度 >= 0.8 → AutoMatch(template_id)
        - 置信度 >= 0.4 → Suggested(template_id, alternatives)
        - 否则           → NoMatch(suggested_alternatives)
    4. 前端按结果决定 UI：
        - AutoMatch  → 静默使用，顶部小标记
        - Suggested  → 弹确认条
        - NoMatch    → 弹模板选择 + "新建自定义模板"入口
```

### 9.4 解析失败兜底

每行解析失败时不丢弃 —— 生成 `LogEntry { level: Unknown, message: 整行, fields: {} }`。好处：
- 行号永远连续
- 用户能看到"哪些行没被识别"
- 统计面板单独显示 "Unparsed: N" 一栏

### 9.5 自定义模板

用户在"模板管理"界面：
- 选 `Regex` 类型 → 填写正则（命名捕获组）+ 时间格式 + 字段映射
- 用当前打开的文件试解析 → 即时预览前 10 行
- 命名 + 保存 → 加入嗅探候选池（持久化到 prefs.json）

## 10. 前端 UI 布局与交互

### 10.1 主窗口布局

```
┌────────────────────────────────────────────────────────────────────┐
│ ☰ Log Viewer    /path/to/foo.log [×]   [模板: bracket-common ▾]    │
│                                                  ⚡ 实时跟踪 ON [○] │
├──────────┬─────────────────────────────────────────────────────────┤
│ 最近文件 │ 筛选栏 ▽                                                 │
│ ─────── │ 时间: [起] ~ [止]    [快捷: 最近1h ▾]                    │
│         │ 级别: [✓ERROR] [✓WARN] [ INFO] [ DEBUG] [ TRACE]         │
│         │ Scope: 字段=[logger▾] 匹配=[auth.* ] [精确│通配│正则]    │
│ ─────── │ 搜索: [keyword]   [Aa] [.*]                              │
│ 保存的  │ [💾 保存此筛选器]            [📥 导出 CSV │ JSON]         │
│ 筛选器  │ ─────────────────────────────────────────────────────    │
│         │ 统计面板（可折叠）                                       │
│         │  总数 12,438  ERROR 89  WARN 320  INFO 11,902 ...        │
│         │  ▁▂▃▅▇▅▃▂▁ 时间趋势（按分钟）                            │
│         │  Top Scope: auth(4321) db(2103) http(1898) ...           │
│         │ ─────────────────────────────────────────────────────    │
│         │ 列表（虚拟滚动） ───── 12,438 / 198,432 匹配 ────        │
│         │ #L1234  09:01:23  ERROR  [auth]    login failed for...   │
│         │ #L1245  09:01:24  WARN   [db]      slow query 1.2s       │
│         │ ...                                                      │
│         │                          [↓ 5 条新日志]                  │
└──────────┴─────────────────────────────────────────────────────────┘
```

### 10.2 关键交互

- **筛选栏**：所有输入 150ms debounce 触发查询；时间区间提供快捷预设；Level 是 toggle 按钮组，颜色对应；Scope 包含字段选择 + 匹配模式 + 输入框
- **虚拟列表**：`react-window`，行高 28px；单击展开详情抽屉显示所有 `fields` 与原始 raw；双击行号复制；底部状态条显示"匹配数 / 总数 + 当前光标行号"
- **实时跟踪**：顶部 toggle；离开底部时新日志显示为右下角 "↓ N 条新日志"浮动按钮；ON 状态柔和脉冲指示
- **保存的筛选器**：左侧列表点击应用；右键重命名 / 删除
- **统计面板**：可折叠；时间趋势图按区间自适应桶（≤2h 分钟桶 / ≤2d 小时桶 / 否则天桶）；Top Scope 显示 Top 10，点击立即填入筛选

### 10.3 键盘快捷键（MVP）

| 快捷键 | 动作 |
|---|---|
| `⌘O` | 打开文件 |
| `⌘F` | 聚焦搜索框 |
| `⌘L` | 聚焦 level 切换 |
| `g g / G` | 跳到顶部 / 底部 |
| `j / k` | 下一行 / 上一行 |
| `⌘E` | 导出当前结果 |
| `⌘\` | 切换实时跟踪 |

## 11. 错误处理矩阵

| 错误场景 | 处理方式 |
|---|---|
| 文件不存在 / 无读权限 | FE toast，不加入"最近打开" |
| 字符集探测失败 | 回退 UTF-8 lossy，顶部黄色横幅"部分字符无法解码" |
| 模板嗅探无匹配 | 弹模板选择对话框，提供"按整行原文显示"应急选项 |
| 单行解析失败 | 兜底为 `level=Unknown` 条目，不中断 |
| 文件被删除 / 移动 | notify 报错 → 顶部"文件已不可访问"，关闭跟踪保留数据 |
| 文件被截断 / 轮转 | 检测大小回退或 inode 变化 → 弹询问："重新加载 / 继续跟踪新文件 / 仅停止跟踪" |
| 文件 > 500MB | 加载前弹窗确认；提供"仅加载最后 N MB"选项 |
| 解析超时（>10s） | 后端发进度事件，前端进度条 + 取消按钮 |
| Prefs 文件损坏 | 自动备份为 `prefs.json.bak.{ts}`，重置为默认 |

所有 Rust 端错误用 `thiserror` 定义类型化错误；Tauri command 统一返回 `Result<T, AppError>`，前端用类型化 union 处理。

## 12. 测试策略

### 12.1 Rust 后端

- **`ParserEngine`**：每个内置模板写 5+ 真实样例的解析单测；嗅探算法写"高置信 / 模糊 / 无匹配"三类 fixture
- **`QueryEngine`**：构造 10k 条目内存数据集，跑每种筛选组合，断言结果集 + 计数
- **`StatsEngine`**：固定数据集 → 断言每种聚合输出
- **`FileLoader`**：用 `tempfile` 真实写文件、追加、删除、改 inode，验证 watcher 行为
- **性能基准（`criterion`）**：100MB 文件的"打开 → 筛选 → 统计"端到端时延，作为回归阈值

### 12.2 前端

- 关键组件（FilterBar / LogList / StatsPanel）的渲染 + 交互测试
- 状态管理：QuerySpec 变化触发查询的 debounce + 取消重叠请求
- Tauri 调用 mock 化，不依赖真实后端

### 12.3 端到端（可选 MVP 后做）

用 Tauri webdriver 跑：打开样例文件 → 应用筛选 → 验证列表 + 统计；实时跟踪 → 追加 → 验证条目自动追加。

### 12.4 TDD 节奏

每个 Rust 模块先写 failing test → 写实现 → 重构。前端先写组件单测再实现。

## 13. 项目结构

```
log-viewer/
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── main.rs             # 入口 + Tauri 命令注册
│   │   ├── commands.rs         # Tauri command 层（薄）
│   │   ├── loader/             # FileLoader + Watcher
│   │   ├── parser/             # ParserEngine + 内置模板 + 嗅探
│   │   ├── query/              # QueryEngine + QuerySpec
│   │   ├── stats/              # StatsEngine
│   │   ├── session/            # Session State
│   │   ├── prefs/              # Preferences 持久化
│   │   ├── error.rs            # AppError 定义
│   │   └── model.rs            # LogEntry / LogLevel 等共享类型
│   ├── tests/                  # 集成测试 + fixtures
│   └── Cargo.toml
├── src/                        # 前端
│   ├── components/
│   │   ├── FilterBar/
│   │   ├── LogList/            # 虚拟列表 + 详情抽屉
│   │   ├── StatsPanel/
│   │   ├── Sidebar/            # 最近文件 + 保存的筛选器
│   │   └── TemplatePicker/
│   ├── hooks/
│   │   ├── useQuery.ts         # debounce + 取消
│   │   ├── useFileSession.ts
│   │   └── useTailFollow.ts
│   ├── api/                    # Tauri command 封装 + 类型
│   ├── state/                  # 全局状态（zustand）
│   ├── types/                  # 与 Rust 共享的 TS 类型
│   └── main.tsx
├── docs/
│   └── superpowers/specs/
│       └── 2026-05-22-log-viewer-design.md
├── package.json
└── README.md
```

## 14. 未来扩展（不在 MVP）

- 多文件合并查看（跨文件统一时间轴）
- 远程文件源（SSH / SFTP / HTTP）
- 日志高亮规则（按 message 内容着色）
- 收藏 / 标注某些行
- 切换到 SQLite/DuckDB 后端以支持 GB 级文件
- 命令行模式（headless）：直接在 CLI 跑筛选/统计
- 主题（暗色/亮色）切换

## 15. 设计认可

- 整体架构 §1：✅
- 数据流 §2：✅
- 解析模板系统 §3：✅
- UI 布局与交互 §4：✅
- 错误处理 / 测试 / 项目结构 §5：✅
