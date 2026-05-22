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
