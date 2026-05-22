// 尾部 JSON / JSON5 块解析：用于 bracket-electron 这种 message 尾部带 { ... } 的格式

use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
pub enum TailParserKind {
    JsonObject,   // 仅尝试严格 JSON
    JsonLike,     // 先 JSON 后 JSON5；都失败放 _raw_tail
}

/// 从合并后的 raw 文本里找尾部 {...} 块（含换行），解析为字符串化的 key-value。
/// 找不到 {...} 返回 (raw.trim(), empty)；找到了但解析失败 → 按 kind 决定是否放 _raw_tail。
pub fn parse_tail(raw: &str, kind: TailParserKind) -> (String, HashMap<String, String>) {
    let Some((head, tail)) = split_tail_brace(raw) else {
        return (raw.trim().to_string(), HashMap::new());
    };

    // 先严格 JSON
    if let Ok(v) = serde_json::from_str::<Value>(tail) {
        if let Some(obj) = v.as_object() {
            return (head.trim().to_string(), object_to_map(obj));
        }
    }

    // JsonLike：再试 json5
    if matches!(kind, TailParserKind::JsonLike) {
        if let Ok(v) = json5::from_str::<Value>(tail) {
            if let Some(obj) = v.as_object() {
                return (head.trim().to_string(), object_to_map(obj));
            }
        }
        // 都失败：保留 _raw_tail
        let mut m = HashMap::new();
        m.insert("_raw_tail".to_string(), tail.to_string());
        return (head.trim().to_string(), m);
    }

    // JsonObject 严格模式失败：把 tail 视作 message 一部分
    (raw.trim().to_string(), HashMap::new())
}

/// 找最右侧的"配对花括号块"。返回 (head, tail) — tail 含外层 {}。
fn split_tail_brace(raw: &str) -> Option<(&str, &str)> {
    let bytes = raw.as_bytes();
    if !raw.trim_end().ends_with('}') { return None; }
    let mut end = raw.trim_end().len();
    while end > 0 && bytes[end - 1].is_ascii_whitespace() { end -= 1; }
    if end == 0 || bytes[end - 1] != b'}' { return None; }

    let mut depth: i32 = 0;
    let mut i = end;
    while i > 0 {
        i -= 1;
        match bytes[i] {
            b'}' => depth += 1,
            b'{' => {
                depth -= 1;
                if depth == 0 {
                    return Some((&raw[..i], &raw[i..end]));
                }
            }
            _ => {}
        }
    }
    None
}

fn object_to_map(obj: &serde_json::Map<String, Value>) -> HashMap<String, String> {
    obj.iter().map(|(k, v)| (k.clone(), stringify(v))).collect()
}

fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_strict_json_tail() {
        let raw = r#"service started {"feedUrl":"https://x","channel":"latest"}"#;
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonLike);
        assert_eq!(msg, "service started");
        assert_eq!(fields.get("feedUrl").map(String::as_str), Some("https://x"));
        assert_eq!(fields.get("channel").map(String::as_str), Some("latest"));
    }

    #[test]
    fn extracts_json5_tail_with_single_quotes() {
        let raw = r#"端口已注册 { source: 'main', id: 'main', userId: '' }"#;
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonLike);
        assert_eq!(msg, "端口已注册");
        assert_eq!(fields.get("source").map(String::as_str), Some("main"));
        assert_eq!(fields.get("id").map(String::as_str), Some("main"));
        assert_eq!(fields.get("userId").map(String::as_str), Some(""));
    }

    #[test]
    fn multiline_tail_works() {
        let raw = "service started {\n  feedUrl: 'https://x',\n  channel: 'latest'\n}";
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonLike);
        assert_eq!(msg, "service started");
        assert_eq!(fields.get("feedUrl").map(String::as_str), Some("https://x"));
    }

    #[test]
    fn unparseable_tail_kept_as_raw_in_jsonlike() {
        let raw = "msg {this is not valid json or json5 at all $$$}";
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonLike);
        assert_eq!(msg, "msg");
        assert!(fields.contains_key("_raw_tail"));
    }

    #[test]
    fn no_brace_returns_full_message_and_empty_fields() {
        let raw = "just a plain message";
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonLike);
        assert_eq!(msg, "just a plain message");
        assert!(fields.is_empty());
    }

    #[test]
    fn json_object_mode_drops_unparseable_tail_into_message() {
        let raw = "msg {invalid}";
        let (msg, fields) = parse_tail(raw, TailParserKind::JsonObject);
        assert_eq!(msg, raw.trim());
        assert!(fields.is_empty());
    }
}
