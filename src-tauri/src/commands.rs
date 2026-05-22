// Tauri command 层：薄壳，仅协调 loader / parser / query / stats / session

use crate::error::AppError;
use crate::loader::reader;
use crate::model::{FileMetadata, LogEntry, Stats};
use crate::parser;
use crate::parser::registry::Registry;
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

#[derive(Serialize)]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub builtin: bool,
}

const BUILTIN_IDS: &[&str] = &[
    "json-lines", "bracket-electron", "bracket-common",
    "python-default", "nginx-combined", "logfmt",
];

#[tauri::command]
pub fn cmd_open_file(
    path: String,
    state: State<'_, SessionState>,
    registry: State<'_, Registry>,
) -> Result<FileMetadata, AppError> {
    let lines = reader::read_all_lines(Path::new(&path))?;
    let (entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    let metadata = parser::compute_metadata(&path, &entries, &template_id);
    state.load_with_lines(metadata.clone(), entries, lines);
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

#[tauri::command]
pub fn cmd_list_templates(registry: State<'_, Registry>) -> Vec<TemplateInfo> {
    registry.all().iter().map(|t| {
        let id = t.as_parser().id().to_string();
        let builtin = BUILTIN_IDS.contains(&id.as_str());
        TemplateInfo {
            id: id.clone(),
            name: t.as_parser().name().to_string(),
            builtin,
        }
    }).collect()
}

#[tauri::command]
pub fn cmd_reparse_with_template(
    template_id: String,
    state: State<'_, SessionState>,
    registry: State<'_, Registry>,
) -> Result<FileMetadata, AppError> {
    let lines = state.lines()?;
    let tpl = registry.find(&template_id)
        .ok_or_else(|| AppError::Internal(format!("模板未找到：{template_id}")))?;
    let entries = parser::parse_with_template(tpl.as_parser(), &lines);
    let old_meta = state.metadata()?;
    let metadata = parser::compute_metadata(&old_meta.path, &entries, &template_id);
    state.load_with_lines(metadata.clone(), entries, lines.to_vec());
    Ok(metadata)
}
