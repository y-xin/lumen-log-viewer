// 统计聚合：在已匹配的索引集合上算总数 + level 分组 + scope Top10
// 时间桶趋势放 Plan 2

use crate::model::{LogEntry, LogLevel, Stats};
use std::collections::HashMap;

pub fn aggregate(entries: &[LogEntry], matched: &[u32]) -> Stats {
    let mut level_counts: HashMap<LogLevel, u32> = HashMap::new();
    let mut scope_counts: HashMap<String, u32> = HashMap::new();

    for &idx in matched {
        let Some(e) = entries.get(idx as usize) else { continue; };
        *level_counts.entry(e.level).or_insert(0) += 1;
        if let Some(s) = &e.scope {
            *scope_counts.entry(s.clone()).or_insert(0) += 1;
        }
    }

    let mut top: Vec<(String, u32)> = scope_counts.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    top.truncate(10);

    Stats { total: matched.len() as u32, level_counts, top_scopes: top }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn e(level: LogLevel, scope: Option<&str>) -> LogEntry {
        LogEntry {
            line_no: 0, timestamp: None, level, scope: scope.map(String::from),
            message: String::new(), fields: HashMap::new(), raw: String::new(),
        }
    }

    #[test]
    fn aggregates_total_and_level_counts() {
        let entries = vec![
            e(LogLevel::Info, Some("a")),
            e(LogLevel::Error, Some("a")),
            e(LogLevel::Info, Some("b")),
        ];
        let matched = vec![0u32, 1, 2];
        let s = aggregate(&entries, &matched);
        assert_eq!(s.total, 3);
        assert_eq!(s.level_counts.get(&LogLevel::Info), Some(&2));
        assert_eq!(s.level_counts.get(&LogLevel::Error), Some(&1));
    }

    #[test]
    fn top_scopes_sorted_by_count_desc_then_name() {
        let entries = vec![
            e(LogLevel::Info, Some("b")),
            e(LogLevel::Info, Some("a")),
            e(LogLevel::Info, Some("a")),
            e(LogLevel::Info, Some("c")),
        ];
        let s = aggregate(&entries, &[0u32, 1, 2, 3]);
        assert_eq!(s.top_scopes[0], ("a".to_string(), 2));
        // b 和 c 同为 1，按名字升序
        assert_eq!(s.top_scopes[1].0, "b");
        assert_eq!(s.top_scopes[2].0, "c");
    }

    #[test]
    fn ignores_entries_without_scope_in_top() {
        let entries = vec![ e(LogLevel::Info, None), e(LogLevel::Info, Some("a")) ];
        let s = aggregate(&entries, &[0u32, 1]);
        assert_eq!(s.top_scopes.len(), 1);
    }
}
