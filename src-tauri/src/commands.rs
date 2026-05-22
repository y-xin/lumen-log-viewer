// Tauri command 层：薄壳，仅协调 loader / parser / query / stats / session

use crate::error::AppError;
use crate::loader::reader;
use crate::loader::{incremental::IncrementalParser, watcher::{FileWatcher, RotationEvent}};
use crate::model::{FileMetadata, LogEntry, Stats};
use crate::parser;
use crate::parser::registry::Registry;
use crate::prefs::{CustomTemplate, PrefsStore, SavedFilter};
use crate::query::{self, QuerySpec};
use crate::query::neighbor::{NeighborDir, NeighborResponse, PositionResponse};
use crate::session::SessionState;
use crate::stats;
use serde::{Deserialize, Serialize};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

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

#[derive(Serialize, Clone)]
pub struct EntriesAppendedPayload {
    pub entries: Vec<LogEntry>,
    pub total: u32,
}

#[derive(Serialize, Clone)]
pub struct FileRotatedPayload {
    pub kind: String,    // "Truncated" / "InodeChanged" / "Removed"
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Jsonl,
    JsonArray,
}

#[derive(Serialize)]
pub struct ExportResult {
    pub count: u32,
    pub bytes_written: u64,
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
    prefs_store: State<'_, PrefsStore>,
) -> Result<FileMetadata, AppError> {
    let lines = reader::read_all_lines(Path::new(&path))?;
    let (entries, template_id) = parser::parse_with_sniff(&registry, &lines);
    let metadata = parser::compute_metadata(&path, &entries, &template_id);
    state.load_with_lines(metadata.clone(), entries, lines);
    // 成功后记录到最近文件（失败不阻塞）
    let _ = prefs_store.record_recent(&path);
    Ok(metadata)
}

#[tauri::command]
pub fn cmd_list_recent_files(prefs_store: State<'_, PrefsStore>) -> Vec<String> {
    prefs_store.list_recent()
}

#[tauri::command]
pub fn cmd_clear_recent_files(prefs_store: State<'_, PrefsStore>) -> Result<(), AppError> {
    prefs_store.clear_recent()
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
    let meta = state.metadata()?;
    let stats = state.with_entries(|entries| {
        let mut s = stats::aggregate(entries, &matched);
        // 时间窗口：用 spec.time_range（若有）否则用文件整体 time_range
        let range = spec.time_range.or(meta.time_range);
        if let Some((from, to)) = range {
            s.time_buckets = stats::time_buckets(entries, &matched, (from, to), stats::DEFAULT_BUCKET_COUNT);
        }
        s
    })?;
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

#[tauri::command]
pub fn cmd_save_custom_template(
    tpl: CustomTemplate,
    registry: State<'_, Registry>,
    prefs_store: State<'_, PrefsStore>,
) -> Result<(), AppError> {
    // 1. 编译验证
    let rt = crate::prefs::store::compile_custom_template(&tpl)?;
    // 2. 不允许覆盖内置 id
    if BUILTIN_IDS.contains(&tpl.id.as_str()) {
        return Err(AppError::Parse(format!("不能使用内置 ID：{}", tpl.id)));
    }
    // 3. 注册表：先 remove 同 id（如果是更新），再 add
    registry.remove(&tpl.id);
    registry.add(crate::parser::registry::Tpl::Regex(rt));
    // 4. 持久化
    let mut prefs = prefs_store.load();
    prefs.custom_templates.retain(|t| t.id != tpl.id);
    prefs.custom_templates.push(tpl);
    prefs_store.save(&prefs)?;
    Ok(())
}

#[tauri::command]
pub fn cmd_delete_custom_template(
    id: String,
    registry: State<'_, Registry>,
    prefs_store: State<'_, PrefsStore>,
) -> Result<(), AppError> {
    if BUILTIN_IDS.contains(&id.as_str()) {
        return Err(AppError::Parse(format!("不能删除内置模板：{}", id)));
    }
    registry.remove(&id);
    let mut prefs = prefs_store.load();
    prefs.custom_templates.retain(|t| t.id != id);
    prefs_store.save(&prefs)?;
    Ok(())
}

#[derive(Serialize)]
pub struct TestSample {
    pub line_no: u32,
    pub line_count: u32,
    pub raw: String,
    pub ok: bool,
    pub message: Option<String>,
    pub level: Option<String>,
    pub scope: Option<String>,
    pub fields_count: u32,
}

#[derive(Serialize)]
pub struct TestResult {
    pub samples: Vec<TestSample>,
    pub hit_rate: f32,
    pub field_completeness: f32,
}

#[tauri::command]
pub fn cmd_test_template(
    tpl: CustomTemplate,
    limit: u32,
    state: State<'_, SessionState>,
) -> Result<TestResult, AppError> {
    let rt = crate::prefs::store::compile_custom_template(&tpl)?;
    let lines = state.lines()?;
    let sample_limit = (limit as usize).max(1).min(lines.len());
    let sample = &lines[..sample_limit];

    let records = crate::parser::grouping::group_records(&rt, sample);
    let display_count = records.len().min(limit as usize);

    let mut samples = Vec::new();
    let mut parsed_ok = 0u32;
    let mut field_sum = 0f32;
    for r in records.iter().take(display_count) {
        let raw_joined = r.lines.join("\n");
        let line_count = r.lines.len() as u32;
        let parsed = <crate::parser::regex_template::RegexTemplate as crate::parser::template::ParserTemplate>::parse_record(&rt, &r.lines);
        match parsed {
            Some(p) => {
                parsed_ok += 1;
                let filled = [
                    p.timestamp.is_some(),
                    !matches!(p.level, crate::model::LogLevel::Unknown),
                    p.scope.is_some(),
                    !p.message.is_empty(),
                ];
                let count: u8 = filled.iter().map(|b| *b as u8).sum();
                field_sum += (count as f32) / 4.0;
                samples.push(TestSample {
                    line_no: r.start_line,
                    line_count,
                    raw: raw_joined,
                    ok: true,
                    message: Some(p.message),
                    level: Some(format!("{:?}", p.level)),
                    scope: p.scope,
                    fields_count: p.fields.len() as u32,
                });
            }
            None => {
                samples.push(TestSample {
                    line_no: r.start_line,
                    line_count,
                    raw: raw_joined,
                    ok: false,
                    message: None,
                    level: None,
                    scope: None,
                    fields_count: 0,
                });
            }
        }
    }

    let total = records.len().max(1) as f32;
    Ok(TestResult {
        samples,
        hit_rate: (parsed_ok as f32) / total,
        field_completeness: if parsed_ok > 0 { field_sum / (parsed_ok as f32) } else { 0.0 },
    })
}

#[tauri::command]
pub fn cmd_start_follow(
    app: AppHandle,
    state: State<'_, SessionState>,
    registry: State<'_, Registry>,
) -> Result<(), AppError> {
    if state.is_following() { return Ok(()); }
    let meta = state.metadata()?;
    let path: std::path::PathBuf = meta.path.clone().into();
    let template_id = meta.template_id.clone();
    let tpl_arc = registry.find(&template_id)
        .ok_or_else(|| AppError::Internal(format!("模板未找到：{template_id}")))?;

    let initial = crate::loader::reader::file_meta(&path)?;
    let next_line_no = meta.total + 1;
    let incremental = IncrementalParser::new(next_line_no);

    let app_for_append = app.clone();
    let app_for_rotation = app.clone();
    let tpl_arc_for_append = tpl_arc.clone();

    let on_append = Arc::new(move |chunk: String| {
        let session: State<'_, SessionState> = app_for_append.state();
        if let Ok(new) = session.feed_chunk(tpl_arc_for_append.as_parser(), &chunk) {
            if !new.is_empty() {
                let total = session.metadata().map(|m| m.total).unwrap_or(0);
                let _ = app_for_append.emit("entries_appended", EntriesAppendedPayload { entries: new, total });
            }
        }
    });
    let on_rotation = Arc::new(move |ev: RotationEvent| {
        let kind = format!("{:?}", ev);
        let _ = app_for_rotation.emit("file_rotated", FileRotatedPayload { kind });
    });

    let watcher = FileWatcher::start(path, initial, on_append, on_rotation)?;
    state.install_watcher(watcher, incremental)?;
    Ok(())
}

#[tauri::command]
pub fn cmd_stop_follow(
    state: State<'_, SessionState>,
    registry: State<'_, Registry>,
) -> Result<(), AppError> {
    if !state.is_following() { return Ok(()); }
    let meta = state.metadata()?;
    if let Some(tpl_arc) = registry.find(&meta.template_id) {
        let _ = state.flush_incremental(tpl_arc.as_parser());
    }
    state.remove_watcher()
}

#[tauri::command]
pub fn cmd_export(
    spec: QuerySpec,
    format: ExportFormat,
    path: String,
    state: State<'_, SessionState>,
) -> Result<ExportResult, AppError> {
    let matched = query::run_query(&state, &spec)?;
    let file = std::fs::File::create(&path)
        .map_err(|e| AppError::Io(format!("创建导出文件失败：{e}")))?;
    let mut w = BufWriter::new(file);
    state.with_entries(|entries| -> std::io::Result<()> {
        match format {
            ExportFormat::Csv       => crate::export::export_csv(entries, &matched, &mut w),
            ExportFormat::Jsonl     => crate::export::export_jsonl(entries, &matched, &mut w),
            ExportFormat::JsonArray => crate::export::export_json_array(entries, &matched, &mut w),
        }
    })?.map_err(|e| AppError::Io(format!("写入导出文件失败：{e}")))?;
    w.flush().map_err(|e| AppError::Io(format!("flush 失败：{e}")))?;
    let bytes_written = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportResult { count: matched.len() as u32, bytes_written })
}

// ─── Saved Filters ───

#[tauri::command]
pub fn cmd_list_saved_filters(
    prefs_store: State<'_, PrefsStore>,
    file_path: String,
) -> Vec<SavedFilter> {
    prefs_store.list_filters(&file_path)
}

#[tauri::command]
pub fn cmd_save_filter(
    prefs_store: State<'_, PrefsStore>,
    file_path: String,
    filter: SavedFilter,
) -> Result<Vec<SavedFilter>, AppError> {
    prefs_store.save_filter(&file_path, filter)
}

#[tauri::command]
pub fn cmd_delete_saved_filter(
    prefs_store: State<'_, PrefsStore>,
    file_path: String,
    id: String,
) -> Result<Vec<SavedFilter>, AppError> {
    prefs_store.delete_filter(&file_path, &id)
}

#[tauri::command]
pub fn cmd_rename_saved_filter(
    prefs_store: State<'_, PrefsStore>,
    file_path: String,
    id: String,
    new_name: String,
) -> Result<Vec<SavedFilter>, AppError> {
    prefs_store.rename_filter(&file_path, &id, &new_name)
}

// ─── Cross-page Detail Nav ───

#[tauri::command]
pub fn cmd_get_neighbor(
    spec: QuerySpec,
    line_no: u32,
    dir: NeighborDir,
    state: State<'_, SessionState>,
) -> Result<Option<NeighborResponse>, AppError> {
    query::neighbor::neighbor(&state, &spec, line_no, dir)
}

#[tauri::command]
pub fn cmd_get_position(
    spec: QuerySpec,
    line_no: u32,
    state: State<'_, SessionState>,
) -> Result<Option<PositionResponse>, AppError> {
    query::neighbor::position(&state, &spec, line_no)
}

// ─── UI 偏好（列宽持久化）───

#[tauri::command]
pub fn cmd_get_column_widths(
    prefs_store: State<'_, PrefsStore>,
) -> Option<std::collections::HashMap<String, u32>> {
    prefs_store.get_column_widths()
}

#[tauri::command]
pub fn cmd_save_column_widths(
    prefs_store: State<'_, PrefsStore>,
    widths: std::collections::HashMap<String, u32>,
) -> Result<(), AppError> {
    prefs_store.save_column_widths(widths)
}
