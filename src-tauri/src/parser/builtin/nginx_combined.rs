// nginx-combined 模板：Nginx 默认 combined access log
// 样例：127.0.0.1 - - [22/May/2026:12:00:00 +0000] "GET /x HTTP/1.1" 200 1234 "-" "Mozilla/5.0"

use crate::parser::regex_template::{FieldMap, RegexTemplate};
use regex::Regex;

pub fn template() -> RegexTemplate {
    RegexTemplate {
        id: "nginx-combined".into(),
        name: "Nginx Combined".into(),
        pattern: Regex::new(
            r#"^(?P<remote>\S+) (?P<ident>\S+) (?P<user>\S+) \[(?P<ts>[^\]]+)\] "(?P<request>[^"]*)" (?P<status>\d+) (?P<size>\S+)(?: "(?P<referer>[^"]*)" "(?P<ua>[^"]*)")?$"#
        ).unwrap(),
        start_pattern: Regex::new(r"^\d+\.\d+\.\d+\.\d+").unwrap(),
        time_formats: vec![
            "%d/%b/%Y:%H:%M:%S %z".into(),
        ],
        field_map: FieldMap {
            timestamp: Some("ts".into()),
            level: None,
            scope: Some("remote".into()),
            message: Some("request".into()),
        },
        tail: None,
        unwrap_nested: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::template::ParserTemplate;

    #[test]
    fn parses_combined_line() {
        let t = template();
        let raw = r#"127.0.0.1 - - [22/May/2026:12:00:00 +0000] "GET /api/users HTTP/1.1" 200 1234 "-" "Mozilla/5.0""#;
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.scope.as_deref(), Some("127.0.0.1"));
        assert_eq!(r.message, "GET /api/users HTTP/1.1");
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn parses_common_log_format_without_referer() {
        let t = template();
        let raw = r#"127.0.0.1 - - [22/May/2026:12:00:00 +0000] "GET /x HTTP/1.1" 200 1234"#;
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.scope.as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn is_record_start_matches_ip() {
        let t = template();
        assert!(t.is_record_start("127.0.0.1 - - [22/May/2026:12:00:00 +0000] \"GET /\" 200 0"));
        assert!(!t.is_record_start("  continuation"));
    }
}
