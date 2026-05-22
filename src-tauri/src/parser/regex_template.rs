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
    /// 嵌套剥离：当 message 本身又能被同一模板解析时（如 electron-log
    /// 包装的子进程 stderr 也是 bracket 风格），自动剥离一层。
    /// 内层的 ts/level/scope 进 fields 的 inner_* 键，message 替换为内层 message。
    /// 仅尝试 1 层（避免无限递归）。
    pub unwrap_nested: bool,
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

        let (mut message, mut fields) = match self.tail {
            Some(kind) => parse_tail(&combined_message, kind),
            None       => (combined_message.trim().to_string(), HashMap::new()),
        };

        // 嵌套剥离：message 整体匹配同模板时再解一层
        if self.unwrap_nested {
            if let Some(unwrapped) = self.try_unwrap_nested(&message, &mut fields) {
                message = unwrapped;
            }
        }

        Some(PartialEntry { timestamp, level, scope, message, fields })
    }
}

impl RegexTemplate {
    /// 嵌套剥离辅助：尝试用本模板再解一次 message。
    /// 成功 → 内层 ts/level/scope 写入 fields 的 inner_* 键；返回内层 message（已跑过 tail parser）
    /// 失败 → 返回 None，调用方保持原 message
    fn try_unwrap_nested(&self, msg: &str, fields: &mut HashMap<String, String>) -> Option<String> {
        if !self.start_pattern.is_match(msg) { return None; }
        let caps = self.pattern.captures(msg)?;

        if let Some(name) = &self.field_map.timestamp {
            if let Some(m) = caps.name(name) {
                fields.entry("inner_timestamp".into()).or_insert_with(|| m.as_str().to_string());
            }
        }
        if let Some(name) = &self.field_map.level {
            if let Some(m) = caps.name(name) {
                fields.entry("inner_level".into()).or_insert_with(|| m.as_str().to_string());
            }
        }
        if let Some(name) = &self.field_map.scope {
            if let Some(m) = caps.name(name) {
                fields.entry("inner_scope".into()).or_insert_with(|| m.as_str().to_string());
            }
        }

        let inner_raw = self.field_map.message.as_ref()
            .and_then(|name| caps.name(name).map(|m| m.as_str().to_string()))
            .unwrap_or_default();

        // 内层 message 可能再带 tail JSON
        let (inner_msg, inner_fields) = match self.tail {
            Some(kind) => parse_tail(&inner_raw, kind),
            None       => (inner_raw.trim().to_string(), HashMap::new()),
        };
        for (k, v) in inner_fields {
            fields.entry(k).or_insert(v); // 外层优先：fields 已有的 key 不覆盖
        }
        Some(inner_msg)
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
            unwrap_nested: false,
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
            unwrap_nested: false,
        };
        let r = t.parse_record(&lines(r#"[2026-05-22 09:00:00.123] [info] (network) 端口已注册 { source: 'main', id: 'main' }"#)).unwrap();
        assert_eq!(r.scope.as_deref(), Some("network"));
        assert_eq!(r.message, "端口已注册");
        assert_eq!(r.fields.get("source").map(String::as_str), Some("main"));
    }

    #[test]
    fn unwrap_nested_strips_outer_layer_when_message_is_another_log() {
        // 模拟 electron-log 包装 gost 子进程 stderr：外层 + 内层都是 bracket 格式
        let t = RegexTemplate {
            id: "tnest".into(),
            name: "TNest".into(),
            pattern: Regex::new(r"^\[(?P<ts>[^\]]+)\]\s+\[(?P<level>[^\]]+)\]\s+\[(?P<scope>[^\]]+)\]\s*(?P<message>.*)$").unwrap(),
            start_pattern: Regex::new(r"^\[\d{4}-").unwrap(),
            time_formats: vec!["%Y-%m-%d %H:%M:%S%.3f".into()],
            field_map: FieldMap {
                timestamp: Some("ts".into()),
                level: Some("level".into()),
                scope: Some("scope".into()),
                message: Some("message".into()),
            },
            tail: Some(TailParserKind::JsonLike),
            unwrap_nested: true,
        };
        let raw = r#"[2026-05-22 10:52:09.160] [warn] [gost] [2026-05-22 10:52:09.160] [warn] [gost] {"caller":"x.go:1","msg":"hi"}"#;
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.scope.as_deref(), Some("gost"));
        // message 应只剩内层去掉 {json} 后的部分（这里是空，因为前缀去完就只有 json）
        assert!(r.message.is_empty() || r.message.trim().is_empty());
        // 内层 ts/level/scope 进 inner_*
        assert_eq!(r.fields.get("inner_scope").map(String::as_str), Some("gost"));
        assert_eq!(r.fields.get("inner_level").map(String::as_str), Some("warn"));
        // tail JSON 也提取
        assert_eq!(r.fields.get("caller").map(String::as_str), Some("x.go:1"));
        assert_eq!(r.fields.get("msg").map(String::as_str), Some("hi"));
    }

    #[test]
    fn unwrap_nested_no_op_when_message_doesnt_match() {
        let t = RegexTemplate {
            id: "tnest".into(),
            name: "TNest".into(),
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
            unwrap_nested: true,
        };
        let raw = "[2026-05-22 09:00:00.123] [info] just plain text";
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.message, "just plain text");
        assert!(r.fields.is_empty());
    }
}
