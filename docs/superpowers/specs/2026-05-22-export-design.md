# 导出筛选结果（CSV / JSON Lines / JSON Array）设计文档

- **日期**：2026-05-22
- **状态**：设计已认可，待生成实现计划
- **前置**：[2026-05-22-log-viewer-design.md](2026-05-22-log-viewer-design.md)

## 1. 目标

在 Plan 1 / 2a / 2b 基础上加一个导出能力：把**当前 QuerySpec 下的全部匹配条目**按用户指定格式写到本地文件。

## 2. 范围确认（来自 brainstorming）

| 维度 | 选择 |
|---|---|
| 导出哪些条目 | 当前全部匹配条目（不是当前页、不是全文件、不是手动选中范围） |
| 支持格式 | CSV、JSON Lines (.jsonl)、JSON Array |
| CSV 字段策略 | 核心 7 列固定：`line_no, line_count, timestamp, level, scope, message, fields_json`；`fields_json` 是该条 entry 的 fields 对象 JSON 字符串 |
| 进度反馈 | 仅 loading 状态；不做百分比进度（百万条预计几秒可完成） |
| 字符集 | UTF-8，无 BOM |

### 2.1 非目标

- 进度事件 / 取消
- 手动选中范围导出
- 导出全文件（不过滤）
- 自定义列范围
- 压缩输出（.gz / .zip）
- 异步导出 / 后台任务队列

## 3. 后端

### 3.1 新模块 `src-tauri/src/export.rs`

```rust
use crate::model::LogEntry;
use std::io::{BufWriter, Write};

pub fn export_csv<W: Write>(
    entries: &[LogEntry], matched: &[u32], w: &mut BufWriter<W>,
) -> std::io::Result<()>;

pub fn export_jsonl<W: Write>(
    entries: &[LogEntry], matched: &[u32], w: &mut BufWriter<W>,
) -> std::io::Result<()>;

pub fn export_json_array<W: Write>(
    entries: &[LogEntry], matched: &[u32], w: &mut BufWriter<W>,
) -> std::io::Result<()>;
```

**关键细节**：

- 所有函数 streaming 写：遍历 matched，按 index 取 entry，写一条 flush 一条（实际由 BufWriter 缓冲）
- 不构建中间 String → 避免大文件内存峰值

### 3.2 CSV 格式

表头：
```
line_no,line_count,timestamp,level,scope,message,fields_json
```

每条 entry 一行。字段按 RFC4180 转义：
- 含 `,` `"` `\n` `\r` 之一 → 整体加 `"..."` 包裹
- 字段内 `"` → `""`
- timestamp：RFC3339（同 `serde_json::to_string`）
- level：lowercase
- scope：原样（可能为空字符串）
- message：原样（多行 message 内部换行原样保留，整字段加引号包裹）
- fields_json：`serde_json::to_string(&entry.fields)` — 空 fields 输出 `{}`

### 3.3 JSON Lines 格式

每行一个 `serde_json::to_string(&LogEntry)` 输出，行尾 `\n`。LogEntry 已实现 Serialize，复用即可。

### 3.4 JSON Array 格式

```json
[
{
  "line_no": 1,
  ...
},
{
  ...
}
]
```

实现：先写 `[\n`，遍历时第一个 entry 写 `  {pretty}`，之后每个 entry 前写 `,\n  {pretty}`，最后写 `\n]`。`pretty` = `serde_json::to_string_pretty`。

### 3.5 新 Tauri command

```rust
#[derive(Deserialize)]
pub enum ExportFormat {
    Csv,
    Jsonl,
    JsonArray,
}

#[tauri::command]
pub fn cmd_export(
    spec: QuerySpec,
    format: ExportFormat,
    path: String,
    state: State<'_, SessionState>,
) -> Result<ExportResult, AppError>;

#[derive(Serialize)]
pub struct ExportResult {
    pub count: u32,           // 实际写入的 entry 数（= matched.len()）
    pub bytes_written: u64,
}
```

执行流：
1. `query::run_query(&state, &spec)` 拿 matched indices
2. `state.with_entries(|entries| ...)` 在 entries 上跑序列化
3. 打开 `std::fs::File::create(path)` → `BufWriter::new`
4. 按 format 派发到对应 export_* 函数
5. flush → 拿 bytes_written → 返回

### 3.6 错误处理

- session 未加载 → `AppError::NoSession`
- path 不可写 → `AppError::Io`
- 序列化失败 → `AppError::Internal`

### 3.7 测试

`#[cfg(test)] mod tests` in `export.rs`：

- CSV：3 个 entry（含中文、含 `"`、含 `,`、含换行 message、空 fields、有 fields） → 断言完整字符串
- JSONL：每行能用 `serde_json::from_str` 解回 LogEntry
- JSON Array：整体能 `serde_json::from_str::<Vec<LogEntry>>` 解回
- 空 matched：CSV 只输出表头；JSONL 输出空字符串；JSON Array 输出 `[]\n`（特殊处理，避免 `[\n\n]` 这种空但有多余空行的丑形态）

集成测试 `tests/integration_export.rs`：
- 用 fixture `sample.jsonl` → 跑 spec → 导出到 tempdir → 读回文件用各自 parser/csv crate 验证

## 4. 前端

### 4.1 新组件 `src/components/ExportMenu.tsx`

UI：FilterBar 末尾右对齐放一个 `📥 导出 ▾` 按钮，点击下拉 3 个格式：

```
📥 导出 ▾
─────────
CSV (.csv)
JSON Lines (.jsonl)
JSON Array (.json)
```

选格式后：
1. 调 `@tauri-apps/plugin-dialog` 的 `save({ defaultPath, filters })` 弹保存对话框
2. defaultPath：`<原文件名 basename>-export-<YYYYMMDD-HHMMSS>.<ext>`
3. 拿到 path（用户取消时 path == null → 返回）
4. button 进 loading state（spinner + disabled），调 `exportToFile(spec, format, path)`
5. 成功 → 在按钮下方/全局 toast 显示 "已导出 N 条到 ..."；3 秒后消失
6. 失败 → 把 `setError(...)` 走 App 顶部 error 横幅

### 4.2 API 封装

`src/api/commands.ts`：

```ts
export type ExportFormat = 'Csv' | 'Jsonl' | 'JsonArray';
export interface ExportResult {
  count: number;
  bytes_written: number;
}
export async function exportToFile(
  spec: QuerySpec, format: ExportFormat, path: string,
): Promise<ExportResult>;
```

### 4.3 Capabilities

`@tauri-apps/plugin-dialog` 的 `save()` 也需要 capability。当前 `capabilities/default.json` 已经有 `dialog:default` 涵盖 save，无需新增；如果有报错再加 `dialog:allow-save`。

## 5. 文件结构变化

```
src-tauri/src/
├── export.rs              (新)
├── commands.rs            (修改：+ cmd_export + ExportFormat + ExportResult)
└── lib.rs                 (修改：注册 cmd_export)
src-tauri/tests/
└── integration_export.rs  (新)

src/
├── components/
│   ├── ExportMenu.tsx     (新)
│   └── FilterBar.tsx      (修改：嵌入 ExportMenu)
└── api/commands.ts        (修改：+ exportToFile + 类型)
```

## 6. 验收清单

- [ ] `cargo test` 全绿
- [ ] `npm test` 全绿
- [ ] 打开 main.log → 应用任意筛选 → 点 📥 → 选 CSV → save dialog → 选路径 → 文件成功生成
- [ ] 用 Excel / `cat` 打开 CSV，5+1 列正确，含中文不乱码（UTF-8）
- [ ] JSONL：用 `jq -s` / 重新打开本工具能解析
- [ ] JSON Array：用 vscode / 浏览器查看格式正确
- [ ] 大文件（如导出 137 行 main.log）成功；如试 100MB 文件也应秒级完成
- [ ] 导出失败（如选只读路径）→ 顶部 error 横幅显示

## 7. 估算

- 后端：3 个 export 函数 + 1 个 command + 测试，~6 task
- 前端：API 封装 + ExportMenu + FilterBar 嵌入 + 验收，~4 task
- 总 ~10 task，预计 1.5-2 小时完成
