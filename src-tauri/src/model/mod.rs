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
    pub line_count: u32,
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
    /// scope → 出现次数，全文件统计（不随筛选变化）。供 StatsPanel 渲染多选 tag。
    pub scope_counts: HashMap<String, u32>,
    pub template_id: String,
    /// 嗅探匹配质量："AutoMatch"（≥0.8 置信度）/ "Suggested"（0.4-0.8）/ "NoMatch"（<0.4）
    /// 仅 cmd_open_file（自动嗅探）流程会赋值；reparse / 测试场景为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sniff_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimeBucket {
    pub bucket_start: DateTime<Utc>,
    pub total: u32,
    pub by_level: HashMap<LogLevel, u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub total: u32,
    pub level_counts: HashMap<LogLevel, u32>,
    pub top_scopes: Vec<(String, u32)>,
    pub time_buckets: Vec<TimeBucket>,
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
            line_count: 1,
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

pub mod source;
pub use source::LogSource;
