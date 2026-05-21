pub mod spec;
pub mod filter;

pub use spec::{MatchMode, QuerySpec, ScopeFilter};

use crate::error::AppError;
use crate::model::LogEntry;
use crate::session::SessionState;
use rayon::prelude::*;
use std::sync::Arc;

/// 在 SessionState 上跑 query，返回匹配的行号数组（u32 = LogEntry.line_no 的索引，
/// 这里直接用 Vec 索引 = entries 中的位置）
pub fn run_query(session: &SessionState, spec: &QuerySpec) -> Result<Arc<Vec<u32>>, AppError> {
    let key = spec.cache_key();
    let scope_re = filter::compile_scope_regex(spec);
    session.cached_or_compute(key, |entries: &Arc<Vec<LogEntry>>| {
        entries.par_iter()
            .enumerate()
            .filter(|(_, e)| filter::matches(e, spec, &scope_re))
            .map(|(i, _)| i as u32)
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FileMetadata, LogEntry, LogLevel};
    use std::collections::{HashMap, HashSet};

    fn e(level: LogLevel, scope: Option<&str>, msg: &str) -> LogEntry {
        LogEntry {
            line_no: 0, timestamp: None, level, scope: scope.map(String::from),
            message: msg.into(), fields: HashMap::new(), raw: msg.into(),
        }
    }

    #[test]
    fn returns_indices_of_matching_entries() {
        let s = SessionState::default();
        let meta = FileMetadata {
            path: "/x".into(), total: 3, time_range: None,
            level_counts: HashMap::new(), scopes: vec![], template_id: "json-lines".into(),
        };
        s.load(meta, vec![
            e(LogLevel::Info, None, "a"),
            e(LogLevel::Error, None, "b"),
            e(LogLevel::Info, None, "c"),
        ]);
        let mut levels = HashSet::new();
        levels.insert(LogLevel::Error);
        let spec = QuerySpec { levels: Some(levels), ..Default::default() };
        let r = run_query(&s, &spec).unwrap();
        assert_eq!(*r, vec![1u32]);
    }
}
