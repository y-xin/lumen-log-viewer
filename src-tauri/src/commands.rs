// Tauri command 层：薄壳，仅协调 loader / parser / query / stats / session

use crate::error::AppError;
use crate::loader::reader;
use crate::model::{FileMetadata, LogEntry, Stats};
use crate::parser;
use crate::query::{self, QuerySpec};
use crate::session::SessionState;
use crate::stats;
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Serialize)]
pub struct QueryResponse {
    pub total_matched: u32,
    pub page_entries: Vec<LogEntry>,
    pub stats: Stats,
}

#[tauri::command]
pub fn cmd_open_file(
    path: String,
    state: State<'_, SessionState>,
) -> Result<FileMetadata, AppError> {
    let lines = reader::read_all_lines(Path::new(&path))?;
    let entries = parser::parse_lines(&lines);
    let metadata = parser::compute_metadata(&path, &entries);
    state.load(metadata.clone(), entries);
    Ok(metadata)
}

#[tauri::command]
pub fn cmd_get_metadata(state: State<'_, SessionState>) -> Result<FileMetadata, AppError> {
    state.metadata()
}

#[tauri::command]
pub fn cmd_query(
    spec: QuerySpec,
    page: u32,
    page_size: u32,
    state: State<'_, SessionState>,
) -> Result<QueryResponse, AppError> {
    let matched = query::run_query(&state, &spec)?;
    let stats = state.with_entries(|entries| stats::aggregate(entries, &matched))?;
    let page_entries = state.with_entries(|entries| {
        let start = (page * page_size) as usize;
        let end = ((page + 1) * page_size) as usize;
        matched
            .iter()
            .skip(start).take(end - start)
            .filter_map(|&i| entries.get(i as usize).cloned())
            .collect::<Vec<LogEntry>>()
    })?;
    Ok(QueryResponse { total_matched: matched.len() as u32, page_entries, stats })
}

/// 单独翻页：相同 spec 下高频调用，复用缓存
#[tauri::command]
pub fn cmd_get_page(
    spec: QuerySpec,
    page: u32,
    page_size: u32,
    state: State<'_, SessionState>,
) -> Result<Vec<LogEntry>, AppError> {
    let matched = query::run_query(&state, &spec)?;
    state.with_entries(|entries| {
        let start = (page * page_size) as usize;
        let end = ((page + 1) * page_size) as usize;
        matched.iter().skip(start).take(end - start)
            .filter_map(|&i| entries.get(i as usize).cloned())
            .collect()
    })
}
