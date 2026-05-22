// RFC3339 时间戳 + [LEVEL] 风格：如 Warp、一些 Rust/Go 应用默认
// 样例：2026-05-22T01:58:41Z [INFO] message
// 时间戳允许带毫秒和时区偏移（Z 或 +08:00）

use crate::parser::regex_template::{FieldMap, RegexTemplate};
use regex::Regex;

pub fn template() -> RegexTemplate {
    RegexTemplate {
        id: "rfc3339-bracket".into(),
        name: "RFC3339 + [LEVEL]".into(),
        pattern: Regex::new(
            r"^(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+\[(?P<level>\w+)\]\s+(?P<message>.*)$"
        ).unwrap(),
        start_pattern: Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}").unwrap(),
        time_formats: vec![
            "%Y-%m-%dT%H:%M:%S%.fZ".into(),
            "%Y-%m-%dT%H:%M:%SZ".into(),
            "%Y-%m-%dT%H:%M:%S%.f%:z".into(),
            "%Y-%m-%dT%H:%M:%S%:z".into(),
            "%Y-%m-%dT%H:%M:%S%.f%z".into(),
            "%Y-%m-%dT%H:%M:%S%z".into(),
        ],
        field_map: FieldMap {
            timestamp: Some("ts".into()),
            level: Some("level".into()),
            scope: None,           // 该格式没有显式 scope，由用户后续 scope_filter 在 fields 里筛
            message: Some("message".into()),
        },
        tail: None,
        unwrap_nested: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;
    use crate::parser::template::ParserTemplate;

    #[test]
    fn parses_warp_style_line() {
        let t = template();
        let r = t.parse_record(&["2026-05-22T01:58:41Z [INFO] Spawning terminal server process...".into()]).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.message, "Spawning terminal server process...");
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn parses_with_millis_and_warn() {
        let t = template();
        let r = t.parse_record(&["2026-05-22T01:58:41.123Z [WARN] SQLite issue".into()]).unwrap();
        assert_eq!(r.level, LogLevel::Warn);
    }

    #[test]
    fn parses_with_tz_offset() {
        let t = template();
        let r = t.parse_record(&["2026-05-22T09:58:41+08:00 [ERROR] boom".into()]).unwrap();
        assert_eq!(r.level, LogLevel::Error);
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn is_record_start_only_matches_iso_prefix() {
        let t = template();
        assert!(t.is_record_start("2026-05-22T01:58:41Z [INFO] x"));
        assert!(!t.is_record_start("    continuation"));
        assert!(!t.is_record_start("[2026-05-22 12:00] [info] x"));
    }
}
