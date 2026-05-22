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
