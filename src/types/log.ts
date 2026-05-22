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
  /** 多选 scope 白名单（StatsPanel 的 tag 多选）。与 scope_filter 是 AND 关系。 */
  scope_in?: string[] | null;
  text_search?: string | null;
}

export interface LogEntry {
  line_no: number;
  line_count: number;
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
  /** scope → 出现次数，全文件统计（不随筛选变化），供 StatsPanel 多选 tag 渲染。 */
  scope_counts: Record<string, number>;
  template_id: string;
}

export interface TimeBucket {
  bucket_start: string;          // RFC3339
  total: number;
  by_level: Partial<Record<LogLevel, number>>;
}

export interface Stats {
  total: number;
  level_counts: Partial<Record<LogLevel, number>>;
  top_scopes: [string, number][];
  time_buckets: TimeBucket[];     // NEW
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

// ─── Saved Filters ───

export interface SavedFilter {
  id: string;
  name: string;
  created_at: string;             // ISO 8601 UTC
  levels: LogLevel[] | null;
  scope_filter: ScopeFilter | null;
  text_search: string | null;
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

// ─── 导出 ───

export type ExportFormat = 'csv' | 'jsonl' | 'json_array';

export interface ExportResult {
  count: number;
  bytes_written: number;
}
