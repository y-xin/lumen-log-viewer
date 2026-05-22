pub mod template;
pub mod json_lines;
pub mod level;

use crate::model::{FileMetadata, LogEntry, LogLevel};
use json_lines::JsonLinesTemplate;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use template::{fallback, finalize, ParserTemplate};

/// MVP：直接用 JSON Lines 模板。Plan 2 会替换为"嗅探 → 选模板"
pub fn parse_lines(lines: &[String]) -> Vec<LogEntry> {
    let tpl = JsonLinesTemplate;
    lines.par_iter()
        .enumerate()
        .map(|(i, line)| {
            let line_no = (i + 1) as u32;
            if line.trim().is_empty() {
                return fallback(line_no, 1, line);
            }
            match tpl.parse_record(&[line.clone()]) {
                Some(p) => finalize(line_no, 1, line, p),
                None => fallback(line_no, 1, line),
            }
        })
        .collect()
}

pub fn compute_metadata(path: &str, entries: &[LogEntry]) -> FileMetadata {
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
        template_id: "json-lines".into(),
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
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].level, LogLevel::Info);
        assert_eq!(r[1].level, LogLevel::Unknown);
        assert_eq!(r[1].raw, "garbage line");
        assert_eq!(r[2].level, LogLevel::Unknown); // 空行也兜底，保持行号连续
    }

    #[test]
    fn metadata_collects_scopes_and_time_range() {
        let lines = vec![
            r#"{"time":"2026-05-22T09:00:00Z","level":"info","logger":"a","msg":"x"}"#.to_string(),
            r#"{"time":"2026-05-22T10:00:00Z","level":"warn","logger":"b","msg":"y"}"#.to_string(),
        ];
        let entries = parse_lines(&lines);
        let m = compute_metadata("/tmp/x.jsonl", &entries);
        assert_eq!(m.total, 2);
        assert_eq!(m.scopes, vec!["a".to_string(), "b".to_string()]);
        assert!(m.time_range.is_some());
    }
}
