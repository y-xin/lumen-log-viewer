// bracket-electron 模板：Electron 应用 (electron-log) 风格
// 样例：[2026-05-21 17:26:37.566] [info] (main/network-manager) message {fields...}

use crate::parser::regex_template::{FieldMap, RegexTemplate};
use crate::parser::tail_parser::TailParserKind;
use regex::Regex;

pub fn template() -> RegexTemplate {
    RegexTemplate {
        id: "bracket-electron".into(),
        name: "Bracket (Electron)".into(),
        pattern: Regex::new(
            r"^\[(?P<ts>[^\]]+)\] \[(?P<level>[^\]]+)\] \((?P<scope>[^\)]+)\) (?P<message>.*)$"
        ).unwrap(),
        start_pattern: Regex::new(r"^\[\d{4}-\d{2}-\d{2}[ T]").unwrap(),
        time_formats: vec![
            "%Y-%m-%d %H:%M:%S%.3f".into(),
            "%Y-%m-%dT%H:%M:%S%.fZ".into(),
            "%Y-%m-%d %H:%M:%S".into(),
        ],
        field_map: FieldMap {
            timestamp: Some("ts".into()),
            level: Some("level".into()),
            scope: Some("scope".into()),
            message: Some("message".into()),
        },
        tail: Some(TailParserKind::JsonLike),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogLevel;
    use crate::parser::template::ParserTemplate;

    #[test]
    fn parses_single_line() {
        let t = template();
        let raw = "[2026-05-21 17:26:37.566] [info] (main/network-manager) 启动网络进程";
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.scope.as_deref(), Some("main/network-manager"));
        assert_eq!(r.message, "启动网络进程");
        assert!(r.timestamp.is_some());
    }

    #[test]
    fn parses_with_strict_json_tail() {
        let t = template();
        let raw = r#"[2026-05-21 17:26:37.760] [info] (gost-api) GET /config → 200 {"status":200}"#;
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.fields.get("status").map(String::as_str), Some("200"));
    }

    #[test]
    fn parses_with_js_style_json_tail() {
        let t = template();
        let raw = r#"[2026-05-21 17:26:37.624] [info] (network) 端口已注册 { source: 'main', id: 'main', userId: '' }"#;
        let r = t.parse_record(&[raw.to_string()]).unwrap();
        assert_eq!(r.message, "端口已注册");
        assert_eq!(r.fields.get("source").map(String::as_str), Some("main"));
        assert_eq!(r.fields.get("userId").map(String::as_str), Some(""));
    }

    #[test]
    fn parses_multiline_record() {
        let t = template();
        let lines = vec![
            "[2026-05-21 17:26:37.760] [info] (app-update) service started {".to_string(),
            "  feedUrl: 'https://djs-download.s3.ap-southeast-1.amazonaws.com/releases/dujiaoshou/',".to_string(),
            "  channel: 'latest'".to_string(),
            "}".to_string(),
        ];
        let r = t.parse_record(&lines).unwrap();
        assert_eq!(r.scope.as_deref(), Some("app-update"));
        assert_eq!(r.message, "service started");
        assert_eq!(r.fields.get("channel").map(String::as_str), Some("latest"));
    }

    #[test]
    fn is_record_start_matches_bracket_date() {
        let t = template();
        assert!(t.is_record_start("[2026-05-21 17:26:37.566] [info] (x) y"));
        assert!(!t.is_record_start("  continuation"));
        assert!(!t.is_record_start("garbage"));
    }
}
