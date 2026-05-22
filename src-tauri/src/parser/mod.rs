pub mod template;
pub mod json_lines;
pub mod level;
pub mod grouping;
pub mod tail_parser;

use crate::model::{FileMetadata, LogEntry, LogLevel};
use grouping::group_records;
use json_lines::JsonLinesTemplate;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use template::ParserTemplate;

/// 用指定模板对 lines 做两阶段解析：先按 is_record_start 合并，再并行解析。
pub fn parse_with_template<T: ParserTemplate + ?Sized + Sync>(
    tpl: &T, lines: &[String],
) -> Vec<LogEntry> {
    let records = group_records(tpl, lines);
    records.par_iter().map(|r| {
        let line_count = r.lines.len() as u32;
        let raw_joined = r.lines.join("\n");
        match tpl.parse_record(&r.lines) {
            Some(p) => template::finalize(r.start_line, line_count, &raw_joined, p),
            None    => template::fallback(r.start_line, line_count, &raw_joined),
        }
    }).collect()
}

/// MVP 兼容入口：用 JsonLinesTemplate 解析。Task 4.3 后会被 sniff-based 入口取代。
pub fn parse_lines(lines: &[String]) -> Vec<LogEntry> {
    parse_with_template(&JsonLinesTemplate, lines)
}

pub fn compute_metadata(path: &str, entries: &[LogEntry], template_id: &str) -> FileMetadata {
    let mut level_counts: HashMap<LogLevel, u32> = HashMap::new();
    let mut scopes: HashSet<String> = HashSet::new();
    let mut min_t = None;
    let mut max_t = None;
    for e in entries {
        *level_counts.entry(e.level).or_insert(0) += 1;
        if let Some(s) = &e.scope { scopes.insert(s.clone()); }
        if let Some(t) = e.timestamp {
            min_t = Some(min_t.map(|m: chrono::DateTime<chrono::Utc>| m.min(t)).unwrap_or(t));
            max_t = Some(max_t.map(|m: chrono::DateTime<chrono::Utc>| m.max(t)).unwrap_or(t));
        }
    }
    let time_range = match (min_t, max_t) {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    };
    let mut scope_list: Vec<String> = scopes.into_iter().collect();
    scope_list.sort();
    FileMetadata {
        path: path.to_string(),
        total: entries.len() as u32,
        time_range,
        level_counts,
        scopes: scope_list,
        template_id: template_id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mixed_lines_with_fallback() {
        let lines = vec![
            r#"{"level":"info","msg":"hi"}"#.to_string(),
            "garbage line".to_string(),
            "".to_string(),
        ];
        let r = parse_lines(&lines);
        // JsonLines.is_record_start 对 garbage 和空行都返回 false，所以它们会被并到上一条 entry
        // 这里更新断言以反映新的合并语义
        assert_eq!(r.len(), 1, "garbage 和空行被并到 JSON 对象那条 entry");
        assert_eq!(r[0].level, LogLevel::Info);
        assert_eq!(r[0].line_count, 3, "包含原 3 行");
    }

    #[test]
    fn metadata_collects_scopes_and_time_range() {
        let lines = vec![
            r#"{"time":"2026-05-22T09:00:00Z","level":"info","logger":"a","msg":"x"}"#.to_string(),
            r#"{"time":"2026-05-22T10:00:00Z","level":"warn","logger":"b","msg":"y"}"#.to_string(),
        ];
        let entries = parse_lines(&lines);
        let m = compute_metadata("/tmp/x.jsonl", &entries, "json-lines");
        assert_eq!(m.total, 2);
        assert_eq!(m.scopes, vec!["a".to_string(), "b".to_string()]);
        assert!(m.time_range.is_some());
        assert_eq!(m.template_id, "json-lines");
    }
}
