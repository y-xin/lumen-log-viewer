// JSON Lines（每行一个 JSON 对象）解析模板

use crate::model::LogLevel;
use crate::parser::level::parse_level;
use crate::parser::template::{ParserTemplate, PartialEntry};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::HashMap;

pub struct JsonLinesTemplate;

const TIME_KEYS: &[&str] = &["time", "ts", "timestamp", "@timestamp"];
const LEVEL_KEYS: &[&str] = &["level", "lvl", "severity"];
const SCOPE_KEYS: &[&str] = &["scope", "logger", "module", "name"];
const MESSAGE_KEYS: &[&str] = &["msg", "message"];

impl ParserTemplate for JsonLinesTemplate {
    fn id(&self) -> &str { "json-lines" }
    fn name(&self) -> &str { "JSON Lines" }

    fn is_record_start(&self, line: &str) -> bool {
        let t = line.trim();
        if !t.starts_with('{') { return false; }
        serde_json::from_str::<Value>(t).map(|v| v.is_object()).unwrap_or(false)
    }

    fn parse_record(&self, lines: &[String]) -> Option<PartialEntry> {
        let raw = lines.first()?;
        let v: Value = serde_json::from_str(raw.trim()).ok()?;
        let obj = v.as_object()?;

        let timestamp = pick_str(obj, TIME_KEYS).and_then(|s| parse_time(&s));
        let level = pick_str(obj, LEVEL_KEYS)
            .map(|s| parse_level(&s))
            .unwrap_or(LogLevel::Unknown);
        let scope = pick_str(obj, SCOPE_KEYS);
        let message = pick_str(obj, MESSAGE_KEYS).unwrap_or_default();

        let consumed: Vec<&str> = TIME_KEYS.iter()
            .chain(LEVEL_KEYS).chain(SCOPE_KEYS).chain(MESSAGE_KEYS)
            .copied().collect();
        let mut fields = HashMap::new();
        for (k, val) in obj {
            if consumed.contains(&k.as_str()) { continue; }
            fields.insert(k.clone(), stringify(val));
        }

        Some(PartialEntry { timestamp, level, scope, message, fields })
    }
}

fn pick_str(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(v) = obj.get(*k) {
            return Some(stringify(v));
        }
    }
    None
}

fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;

    fn p() -> JsonLinesTemplate { JsonLinesTemplate }
    fn lines(s: &str) -> Vec<String> { vec![s.to_string()] }

    #[test]
    fn parses_standard_line() {
        let raw = r#"{"time":"2026-05-22T09:00:00Z","level":"info","logger":"auth","msg":"hi","x":1}"#;
        let r = p().parse_record(&lines(raw)).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("auth"));
        assert_eq!(r.message, "hi");
        assert!(r.timestamp.is_some());
        assert_eq!(r.fields.get("x").map(|s| s.as_str()), Some("1"));
    }

    #[test]
    fn supports_alternate_keys() {
        let raw = r#"{"ts":"2026-05-22T09:00:00Z","severity":"WARN","module":"db","message":"slow"}"#;
        let r = p().parse_record(&lines(raw)).unwrap();
        assert_eq!(r.level, LogLevel::Warn);
        assert_eq!(r.scope.as_deref(), Some("db"));
        assert_eq!(r.message, "slow");
    }

    #[test]
    fn returns_none_on_garbage() {
        assert!(p().parse_record(&lines("this is not json")).is_none());
        assert!(p().parse_record(&lines("")).is_none());
    }

    #[test]
    fn missing_level_yields_unknown() {
        let raw = r#"{"msg":"hi"}"#;
        let r = p().parse_record(&lines(raw)).unwrap();
        assert_eq!(r.level, LogLevel::Unknown);
    }

    #[test]
    fn is_record_start_detects_json_object() {
        assert!(p().is_record_start(r#"{"a":1}"#));
        assert!(p().is_record_start(r#"  {"a":1}  "#));
        assert!(!p().is_record_start("garbage"));
        assert!(!p().is_record_start(""));
        assert!(!p().is_record_start(r#"[1,2,3]"#));
    }
}
