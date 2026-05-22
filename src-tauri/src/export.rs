// 三种导出格式：CSV / JSONL / JSON Array
// 全部 streaming：BufWriter 逐条写，避免大文件内存峰值

use crate::model::LogEntry;
use std::io::{BufWriter, Write};

const CSV_HEADER: &str = "line_no,line_count,timestamp,level,scope,message,fields_json\n";

/// CSV：7 列固定，UTF-8 无 BOM，RFC4180 转义
pub fn export_csv<W: Write>(
    entries: &[LogEntry],
    matched: &[u32],
    w: &mut BufWriter<W>,
) -> std::io::Result<()> {
    w.write_all(CSV_HEADER.as_bytes())?;
    for &idx in matched {
        let Some(e) = entries.get(idx as usize) else { continue; };
        let fields_json = serde_json::to_string(&e.fields).unwrap_or_else(|_| "{}".into());
        let ts = e.timestamp.map(|t| t.to_rfc3339()).unwrap_or_default();
        let level = level_lower(&e.level);
        let scope = e.scope.as_deref().unwrap_or("");
        writeln!(
            w,
            "{},{},{},{},{},{},{}",
            e.line_no,
            e.line_count,
            csv_escape(&ts),
            csv_escape(&level),
            csv_escape(scope),
            csv_escape(&e.message),
            csv_escape(&fields_json),
        )?;
    }
    Ok(())
}

fn level_lower(l: &crate::model::LogLevel) -> String {
    serde_json::to_string(l).unwrap_or_default().trim_matches('"').to_string()
}

/// RFC4180 转义：含 , " \n \r 之一 → 整体加 " 包裹；内部 " → ""
fn csv_escape(s: &str) -> String {
    let needs_quote = s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r');
    if !needs_quote { return s.to_string(); }
    let escaped = s.replace('"', "\"\"");
    format!("\"{}\"", escaped)
}

/// JSON Lines：每行一个 LogEntry JSON，行尾 \n
pub fn export_jsonl<W: Write>(
    entries: &[LogEntry],
    matched: &[u32],
    w: &mut BufWriter<W>,
) -> std::io::Result<()> {
    for &idx in matched {
        let Some(e) = entries.get(idx as usize) else { continue; };
        let line = serde_json::to_string(e)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        w.write_all(line.as_bytes())?;
        w.write_all(b"\n")?;
    }
    Ok(())
}

/// JSON Array：整文件是一个 JSON 数组（每个元素 pretty 打印）。
/// 空 matched 输出 "[]\n" 以避免 "[\n\n]" 这种丑形态
pub fn export_json_array<W: Write>(
    entries: &[LogEntry],
    matched: &[u32],
    w: &mut BufWriter<W>,
) -> std::io::Result<()> {
    if matched.is_empty() {
        w.write_all(b"[]\n")?;
        return Ok(());
    }
    w.write_all(b"[\n")?;
    let mut first = true;
    for &idx in matched {
        let Some(e) = entries.get(idx as usize) else { continue; };
        if !first {
            w.write_all(b",\n")?;
        }
        first = false;
        let pretty = serde_json::to_string_pretty(e)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        w.write_all(pretty.as_bytes())?;
    }
    w.write_all(b"\n]\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LogEntry, LogLevel};
    use chrono::{TimeZone, Utc};
    use std::collections::HashMap;
    use std::io::Cursor;

    fn e(line: u32, scope: Option<&str>, message: &str, fields: &[(&str, &str)]) -> LogEntry {
        let mut f = HashMap::new();
        for (k, v) in fields { f.insert(k.to_string(), v.to_string()); }
        LogEntry {
            line_no: line,
            line_count: 1,
            timestamp: Some(Utc.with_ymd_and_hms(2026, 5, 22, 9, 0, 0).unwrap()),
            level: LogLevel::Info,
            scope: scope.map(String::from),
            message: message.into(),
            fields: f,
            raw: String::new(),
        }
    }

    fn export_to_string<F>(write_fn: F) -> String
    where F: FnOnce(&mut BufWriter<Cursor<Vec<u8>>>) -> std::io::Result<()> {
        let mut w = BufWriter::new(Cursor::new(Vec::new()));
        write_fn(&mut w).unwrap();
        w.flush().unwrap();
        let inner = w.into_inner().unwrap().into_inner();
        String::from_utf8(inner).unwrap()
    }

    #[test]
    fn csv_header_only_when_no_matches() {
        let s = export_to_string(|w| export_csv(&[], &[], w));
        assert_eq!(s, CSV_HEADER);
    }

    #[test]
    fn csv_writes_one_row_per_match() {
        let entries = vec![
            e(1, Some("a"), "hello", &[]),
            e(2, Some("b"), "world", &[("k", "v")]),
        ];
        let s = export_to_string(|w| export_csv(&entries, &[0, 1], w));
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[1].starts_with("1,1,2026-05-22T09:00:00+00:00,info,a,hello,"));
        assert!(lines[1].ends_with("{}"));
        assert!(lines[2].contains(",b,world,"));
        // fields_json = {"k":"v"} 含 " → RFC4180 整体加引号、内部 " → ""
        assert!(lines[2].ends_with("\"{\"\"k\"\":\"\"v\"\"}\""));
    }

    #[test]
    fn csv_escapes_special_chars() {
        let entries = vec![
            e(1, Some("scope"), "msg, with \"quote\"\nand newline", &[]),
        ];
        let s = export_to_string(|w| export_csv(&entries, &[0], w));
        assert!(s.contains("\"msg, with \"\"quote\"\"\nand newline\""));
    }

    #[test]
    fn csv_handles_chinese_and_empty_scope() {
        let entries = vec![ e(1, None, "中文消息", &[]) ];
        let s = export_to_string(|w| export_csv(&entries, &[0], w));
        let lines: Vec<&str> = s.lines().collect();
        assert!(lines[1].contains(",info,,中文消息,"));
    }

    #[test]
    fn jsonl_empty_matched_is_empty_string() {
        let s = export_to_string(|w| export_jsonl(&[], &[], w));
        assert_eq!(s, "");
    }

    #[test]
    fn jsonl_each_line_roundtrips() {
        let entries = vec![
            e(1, Some("a"), "hi", &[("k", "v")]),
            e(2, Some("b"), "ho", &[]),
        ];
        let s = export_to_string(|w| export_jsonl(&entries, &[0, 1], w));
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines.len(), 2);
        for line in &lines {
            let back: LogEntry = serde_json::from_str(line).unwrap();
            assert!(back.line_no == 1 || back.line_no == 2);
        }
    }

    #[test]
    fn json_array_empty_matched_is_brackets_only() {
        let s = export_to_string(|w| export_json_array(&[], &[], w));
        assert_eq!(s, "[]\n");
    }

    #[test]
    fn json_array_parses_back_to_vec() {
        let entries = vec![
            e(1, Some("a"), "hi", &[("k", "v")]),
            e(2, Some("b"), "ho", &[]),
        ];
        let s = export_to_string(|w| export_json_array(&entries, &[0, 1], w));
        let back: Vec<LogEntry> = serde_json::from_str(&s).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].line_no, 1);
        assert_eq!(back[1].line_no, 2);
    }
}
