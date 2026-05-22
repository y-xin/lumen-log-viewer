// 跨页详情导航：在 spec 的 matched 列表里按 line_no 定位 ±1
// 复用 query::run_query 的 matched 索引（cache 命中时几乎零成本）

use crate::error::AppError;
use crate::model::LogEntry;
use crate::query::{self, QuerySpec};
use crate::session::SessionState;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct NeighborResponse {
    pub entry: LogEntry,
    pub position: u32,   // 1-based
    pub total: u32,
}

#[derive(Serialize)]
pub struct PositionResponse {
    pub position: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NeighborDir { Prev, Next }

/// 在 matched 列表里找指定 line_no 的位置（None = 不在列表里）
fn find_index(matched: &[u32], entries: &[LogEntry], line_no: u32) -> Option<usize> {
    matched.iter().position(|&i| entries.get(i as usize).map(|e| e.line_no) == Some(line_no))
}

/// 找邻居 entry + 它的位置信息；line_no 不在 matched 或越界 → None
pub fn neighbor(
    state: &SessionState,
    spec: &QuerySpec,
    line_no: u32,
    dir: NeighborDir,
) -> Result<Option<NeighborResponse>, AppError> {
    let matched = query::run_query(state, spec)?;
    state.with_entries(|entries| {
        let cur = find_index(&matched, entries, line_no)?;
        let next_idx = match dir {
            NeighborDir::Prev => if cur == 0 { return None; } else { cur - 1 },
            NeighborDir::Next => if cur + 1 >= matched.len() { return None; } else { cur + 1 },
        };
        let entry_idx = matched[next_idx] as usize;
        let entry = entries.get(entry_idx)?.clone();
        Some(NeighborResponse {
            entry,
            position: (next_idx + 1) as u32,
            total: matched.len() as u32,
        })
    })
}

/// 当前 line_no 在 matched 中的位置（drawer 首次打开用）
pub fn position(
    state: &SessionState,
    spec: &QuerySpec,
    line_no: u32,
) -> Result<Option<PositionResponse>, AppError> {
    let matched = query::run_query(state, spec)?;
    let total = matched.len() as u32;
    let pos = state.with_entries(|entries| find_index(&matched, entries, line_no))?;
    Ok(pos.map(|p| PositionResponse { position: (p + 1) as u32, total }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FileMetadata, LogEntry, LogLevel};
    use std::collections::HashMap;

    fn e(line_no: u32, level: LogLevel, msg: &str) -> LogEntry {
        LogEntry {
            line_no, line_count: 1, timestamp: None, level,
            scope: None, message: msg.into(), fields: HashMap::new(), raw: msg.into(),
        }
    }

    fn fixture() -> SessionState {
        let s = SessionState::default();
        let entries = vec![
            e(1, LogLevel::Info,  "a"),
            e(2, LogLevel::Error, "b"),  // matched
            e(3, LogLevel::Error, "c"),  // matched
            e(4, LogLevel::Info,  "d"),
            e(5, LogLevel::Error, "e"),  // matched
        ];
        let md = FileMetadata {
            path: "/x".into(), total: entries.len() as u32, time_range: None,
            level_counts: HashMap::new(), scopes: vec![],
            scope_counts: HashMap::new(), template_id: "x".into(),
        };
        s.load(md, entries);
        s
    }

    fn err_spec() -> QuerySpec {
        QuerySpec { levels: Some([LogLevel::Error].into_iter().collect()), ..Default::default() }
    }

    #[test]
    fn next_from_middle_returns_next() {
        let s = fixture();
        let r = neighbor(&s, &err_spec(), 2, NeighborDir::Next).unwrap().unwrap();
        assert_eq!(r.entry.line_no, 3);
        assert_eq!(r.position, 2);
        assert_eq!(r.total, 3);
    }

    #[test]
    fn prev_from_middle_returns_prev() {
        let s = fixture();
        let r = neighbor(&s, &err_spec(), 3, NeighborDir::Prev).unwrap().unwrap();
        assert_eq!(r.entry.line_no, 2);
        assert_eq!(r.position, 1);
    }

    #[test]
    fn next_from_last_returns_none() {
        let s = fixture();
        let r = neighbor(&s, &err_spec(), 5, NeighborDir::Next).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn prev_from_first_returns_none() {
        let s = fixture();
        let r = neighbor(&s, &err_spec(), 2, NeighborDir::Prev).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn line_no_not_in_matched_returns_none() {
        let s = fixture();
        let r = neighbor(&s, &err_spec(), 4, NeighborDir::Next).unwrap();
        assert!(r.is_none());
        let p = position(&s, &err_spec(), 4).unwrap();
        assert!(p.is_none());
    }
}
