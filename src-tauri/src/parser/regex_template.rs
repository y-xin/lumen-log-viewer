// 通用正则模板：所有 bracket-* / python-* / nginx-* 共用

use crate::model::LogLevel;
use crate::parser::level::parse_level;
use crate::parser::tail_parser::{parse_tail, TailParserKind};
use crate::parser::template::{ParserTemplate, PartialEntry};
use chrono::{DateTime, NaiveDateTime, Utc};
use regex::Regex;
use std::collections::HashMap;

/// 字段映射：每个 LogEntry 字段对应正则里的哪个命名捕获组
#[derive(Debug, Clone)]
pub struct FieldMap {
    pub timestamp: Option<String>,
    pub level: Option<String>,
    pub scope: Option<String>,
    pub message: Option<String>,
}

pub struct RegexTemplate {
    pub id: String,
    pub name: String,
    pub pattern: Regex,
    pub start_pattern: Regex,
    pub time_formats: Vec<String>,
    pub field_map: FieldMap,
    pub tail: Option<TailParserKind>,
}

impl ParserTemplate for RegexTemplate {
    fn id(&self) -> &str { &self.id }
    fn name(&self) -> &str { &self.name }

    fn is_record_start(&self, line: &str) -> bool {
        self.start_pattern.is_match(line)
    }

    fn parse_record(&self, lines: &[String]) -> Option<PartialEntry> {
        let head = lines.first()?;
        let caps = self.pattern.captures(head)?;

        let timestamp = self.field_map.timestamp.as_ref()
            .and_then(|name| caps.name(name).map(|m| m.as_str()))
            .and_then(|s| parse_timestamp(s, &self.time_formats));

        let level = self.field_map.level.as_ref()
            .and_then(|name| caps.name(name).map(|m| parse_level(m.as_str())))
            .unwrap_or(LogLevel::Unknown);

        let scope = self.field_map.scope.as_ref()
            .and_then(|name| caps.name(name).map(|m| m.as_str().to_string()));

        let raw_message = self.field_map.message.as_ref()
            .and_then(|name| caps.name(name).map(|m| m.as_str().to_string()))
            .unwrap_or_default();

        // 多行场景：把 lines[1..] 附加到 raw_message 后面再走 tail 解析
        let combined_message = if lines.len() > 1 {
            let mut s = raw_message;
            for cont in &lines[1..] {
                s.push('\n');
                s.push_str(cont);
            }
            s
        } else {
            raw_message
        };

        let (message, fields) = match self.tail {
            Some(kind) => parse_tail(&combined_message, kind),
            None       => (combined_message.trim().to_string(), HashMap::new()),
        };

        Some(PartialEntry { timestamp, level, scope, message, fields })
    }
}

fn parse_timestamp(s: &str, formats: &[String]) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    for fmt in formats {
        if let Ok(ndt) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::tail_parser::TailParserKind;

    fn tpl_3field() -> RegexTemplate {
        RegexTemplate {
            id: "t".into(),
            name: "T".into(),
            pattern: Regex::new(r"^\[(?P<ts>[^\]]+)\] \[(?P<level>[^\]]+)\] (?P<message>.*)$").unwrap(),
            start_pattern: Regex::new(r"^\[\d{4}").unwrap(),
            time_formats: vec!["%Y-%m-%d %H:%M:%S%.3f".into()],
            field_map: FieldMap {
                timestamp: Some("ts".into()),
                level: Some("level".into()),
                scope: None,
                message: Some("message".into()),
            },
            tail: None,
        }
    }

    fn lines(s: &str) -> Vec<String> { vec![s.to_string()] }

    #[test]
    fn parses_basic_three_field_line() {
        let t = tpl_3field();
        let r = t.parse_record(&lines("[2026-05-22 09:00:00.123] [info] hello")).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.message, "hello");
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn is_record_start_uses_start_pattern() {
        let t = tpl_3field();
        assert!(t.is_record_start("[2026-05-22 09:00:00.123] [info] hi"));
        assert!(!t.is_record_start("  continuation line"));
    }

    #[test]
    fn unmatched_line_returns_none() {
        let t = tpl_3field();
        assert!(t.parse_record(&lines("garbage")).is_none());
    }

    #[test]
    fn merges_multiline_into_message_when_no_tail_parser() {
        let t = tpl_3field();
        let lines = vec!["[2026-05-22 09:00:00.123] [info] head".to_string(), "continuation".to_string()];
        let r = t.parse_record(&lines).unwrap();
        assert!(r.message.starts_with("head"));
        assert!(r.message.contains("continuation"));
    }

    #[test]
    fn rfc3339_timestamp_works() {
        let mut t = tpl_3field();
        t.time_formats.clear();
        let r = t.parse_record(&lines("[2026-05-22T09:00:00Z] [info] x")).unwrap();
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn tail_parser_extracts_fields() {
        let t = RegexTemplate {
            id: "t2".into(),
            name: "T2".into(),
            pattern: Regex::new(r"^\[(?P<ts>[^\]]+)\] \[(?P<level>[^\]]+)\] \((?P<scope>[^\)]+)\) (?P<message>.*)$").unwrap(),
            start_pattern: Regex::new(r"^\[\d").unwrap(),
            time_formats: vec!["%Y-%m-%d %H:%M:%S%.3f".into()],
            field_map: FieldMap {
                timestamp: Some("ts".into()),
                level: Some("level".into()),
                scope: Some("scope".into()),
                message: Some("message".into()),
            },
            tail: Some(TailParserKind::JsonLike),
        };
        let r = t.parse_record(&lines(r#"[2026-05-22 09:00:00.123] [info] (network) 端口已注册 { source: 'main', id: 'main' }"#)).unwrap();
        assert_eq!(r.scope.as_deref(), Some("network"));
        assert_eq!(r.message, "端口已注册");
        assert_eq!(r.fields.get("source").map(String::as_str), Some("main"));
    }
}
