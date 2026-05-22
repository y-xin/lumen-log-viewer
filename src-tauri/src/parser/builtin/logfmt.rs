// logfmt 模板：Heroku / k8s 风格 key=value
// 样例：time=2026-05-22T09:00:00Z level=info logger=auth msg="login ok" user=42

use crate::model::LogLevel;
use crate::parser::level::parse_level;
use crate::parser::template::{ParserTemplate, PartialEntry};
use chrono::{DateTime, Utc};
use std::collections::HashMap;

pub struct LogfmtTemplate;

impl ParserTemplate for LogfmtTemplate {
    fn id(&self) -> &str { "logfmt" }
    fn name(&self) -> &str { "logfmt" }

    fn is_record_start(&self, line: &str) -> bool {
        !line.is_empty() && !line.starts_with(char::is_whitespace) && line.contains('=')
    }

    fn parse_record(&self, lines: &[String]) -> Option<PartialEntry> {
        let head = lines.first()?;
        let pairs = parse_logfmt(head)?;

        let mut map: HashMap<String, String> = pairs.into_iter().collect();
        let timestamp = map.remove("time")
            .or_else(|| map.remove("ts"))
            .or_else(|| map.remove("timestamp"))
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok().map(|d| d.with_timezone(&Utc)));

        let level = map.remove("level")
            .or_else(|| map.remove("lvl"))
            .or_else(|| map.remove("severity"))
            .map(|s| parse_level(&s))
            .unwrap_or(LogLevel::Unknown);

        let scope = map.remove("logger")
            .or_else(|| map.remove("scope"))
            .or_else(|| map.remove("module"));

        let message = map.remove("msg")
            .or_else(|| map.remove("message"))
            .unwrap_or_default();

        Some(PartialEntry {
            timestamp,
            level,
            scope,
            message,
            fields: map,
        })
    }
}

/// 把一行 logfmt 解析为 (key, value) 列表。支持 key=value 和 key="quoted value"。
fn parse_logfmt(s: &str) -> Option<Vec<(String, String)>> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= bytes.len() { break; }

        let key_start = i;
        while i < bytes.len() && bytes[i] != b'=' && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let key = std::str::from_utf8(&bytes[key_start..i]).ok()?.to_string();
        if key.is_empty() { return None; }

        if i >= bytes.len() || bytes[i] != b'=' {
            out.push((key, String::new()));
            continue;
        }
        i += 1;

        if i < bytes.len() && bytes[i] == b'"' {
            i += 1;
            let val_start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' && i + 1 < bytes.len() { i += 2; }
                else { i += 1; }
            }
            let val = std::str::from_utf8(&bytes[val_start..i]).ok()?
                .replace("\\\"", "\"");
            out.push((key, val));
            if i < bytes.len() { i += 1; }
        } else {
            let val_start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() { i += 1; }
            let val = std::str::from_utf8(&bytes[val_start..i]).ok()?.to_string();
            out.push((key, val));
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;

    fn p() -> LogfmtTemplate { LogfmtTemplate }
    fn lines(s: &str) -> Vec<String> { vec![s.to_string()] }

    #[test]
    fn parses_simple_pairs() {
        let pairs = parse_logfmt("a=1 b=2 c=3").unwrap();
        assert_eq!(pairs.len(), 3);
        assert_eq!(pairs[0], ("a".to_string(), "1".to_string()));
    }

    #[test]
    fn parses_quoted_value_with_spaces() {
        let pairs = parse_logfmt(r#"msg="hello world" user=42"#).unwrap();
        assert_eq!(pairs[0], ("msg".to_string(), "hello world".to_string()));
        assert_eq!(pairs[1], ("user".to_string(), "42".to_string()));
    }

    #[test]
    fn parses_escaped_quote_in_value() {
        let pairs = parse_logfmt(r#"msg="he said \"hi\"""#).unwrap();
        assert_eq!(pairs[0].1, r#"he said "hi""#);
    }

    #[test]
    fn parses_full_logfmt_line() {
        let line = r#"time=2026-05-22T09:00:00Z level=info logger=auth msg="login ok" user=42"#;
        let r = p().parse_record(&lines(line)).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("auth"));
        assert_eq!(r.message, "login ok");
        assert!(r.timestamp.is_some());
        assert_eq!(r.fields.get("user").map(String::as_str), Some("42"));
    }

    #[test]
    fn is_record_start_requires_kv() {
        assert!(p().is_record_start("a=1"));
        assert!(p().is_record_start("a=1 b=2"));
        assert!(!p().is_record_start("  a=1"));
        assert!(!p().is_record_start("no equals here"));
        assert!(!p().is_record_start(""));
    }
}
