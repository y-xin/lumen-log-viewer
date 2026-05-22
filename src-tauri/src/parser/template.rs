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

/// 解析失败兜底：保留行内容，level=Unknown
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
