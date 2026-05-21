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
