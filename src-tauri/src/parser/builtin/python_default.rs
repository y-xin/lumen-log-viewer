// python-default 模板：Python logging 默认 BASIC_FORMAT
// 样例：2026-05-22 12:00:00,123 - auth - INFO - login ok

use crate::parser::regex_template::{FieldMap, RegexTemplate};
use regex::Regex;

pub fn template() -> RegexTemplate {
    RegexTemplate {
        id: "python-default".into(),
        name: "Python logging".into(),
        pattern: Regex::new(
            r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d+)?) - (?P<scope>[^\s]+) - (?P<level>[A-Z]+) - (?P<message>.*)$"
        ).unwrap(),
        start_pattern: Regex::new(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}").unwrap(),
        time_formats: vec![
            "%Y-%m-%d %H:%M:%S,%3f".into(),
            "%Y-%m-%d %H:%M:%S".into(),
        ],
        field_map: FieldMap {
            timestamp: Some("ts".into()),
            level: Some("level".into()),
            scope: Some("scope".into()),
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
    fn parses_typical_line() {
        let t = template();
        let r = t.parse_record(&["2026-05-22 12:00:00,123 - auth - INFO - login ok".to_string()]).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("auth"));
        assert_eq!(r.message, "login ok");
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn parses_without_milliseconds() {
        let t = template();
        let r = t.parse_record(&["2026-05-22 12:00:00 - db.pool - DEBUG - acquire".to_string()]).unwrap();
        assert_eq!(r.level, LogLevel::Debug);
        assert_eq!(r.scope.as_deref(), Some("db.pool"));
    }
}
