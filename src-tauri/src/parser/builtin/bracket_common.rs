// bracket-common 模板：Java logback / Go zap 默认风格
// 样例：2026-05-22 12:00:00 [INFO] [auth] login ok

use crate::parser::regex_template::{FieldMap, RegexTemplate};
use regex::Regex;

pub fn template() -> RegexTemplate {
    RegexTemplate {
        id: "bracket-common".into(),
        name: "Bracket (Common)".into(),
        pattern: Regex::new(
            r"^(?P<ts>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?) \[(?P<level>[^\]]+)\] \[(?P<scope>[^\]]+)\] (?P<message>.*)$"
        ).unwrap(),
        start_pattern: Regex::new(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}").unwrap(),
        time_formats: vec![
            "%Y-%m-%d %H:%M:%S%.3f".into(),
            "%Y-%m-%d %H:%M:%S".into(),
            "%Y-%m-%dT%H:%M:%S%.fZ".into(),
        ],
        field_map: FieldMap {
            timestamp: Some("ts".into()),
            level: Some("level".into()),
            scope: Some("scope".into()),
            message: Some("message".into()),
        },
        tail: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;
    use crate::parser::template::ParserTemplate;

    #[test]
    fn parses_typical_line() {
        let t = template();
        let r = t.parse_record(&["2026-05-22 12:00:00 [INFO] [auth] login ok".to_string()]).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("auth"));
        assert_eq!(r.message, "login ok");
    }

    #[test]
    fn parses_with_milliseconds() {
        let t = template();
        let r = t.parse_record(&["2026-05-22 12:00:00.123 [WARN] [db] slow query".to_string()]).unwrap();
        assert_eq!(r.level, LogLevel::Warn);
        assert_eq!(r.scope.as_deref(), Some("db"));
    }

    #[test]
    fn is_record_start_matches_iso_date() {
        let t = template();
        assert!(t.is_record_start("2026-05-22 12:00:00 [INFO] [x] y"));
        assert!(!t.is_record_start("  continuation"));
    }
}
