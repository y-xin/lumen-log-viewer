// Tauri command 层：薄壳，仅协调 loader / parser / query / stats / session

use crate::error::AppError;
use crate::loader::reader;
use crate::loader::{incremental::IncrementalParser, watcher::{FileWatcher, RotationEvent}};
use crate::session::state::SourceReader;
use crate::model::{FileMetadata, LogEntry, Stats};
use crate::parser;
use crate::parser::registry::Registry;
use crate::prefs::{CustomTemplate, PrefsStore, SavedFilter, UiPrefs};
use crate::query::{self, QuerySpec};
use crate::query::neighbor::{NeighborDir, NeighborResponse, PositionResponse};
use crate::session_store::SessionStore;
use crate::stats;
use serde::{Deserialize, Serialize};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

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
    window: tauri::Window,
    path: String,
    store: State<'_, SessionStore>,
    registry: State<'_, Registry>,
    prefs_store: State<'_, PrefsStore>,
    app: tauri::AppHandle,
) -> Result<FileMetadata, AppError> {
    let lines = reader::read_all_lines(Path::new(&path))?;
    let (entries, template_id, sniff_kind) = parser::parse_with_sniff(&registry, &lines);
    let mut metadata = parser::compute_metadata(&path, &entries, &template_id);
    metadata.sniff_kind = Some(sniff_kind);

    let session = store.get_or_create(window.label());
    session.load_with_lines(metadata.clone(), entries, lines);

    // 注册路径反向索引（用 canonical 路径转 URI，便于 lookup_by_uri 命中）
    // canonicalize 失败（如网络盘 / 软链断）时 fallback 原 path，保证聚焦功能能用
    let canonical_key = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let uri = crate::model::LogSource::Local { path: canonical_key }.to_uri();
    store.register_path(uri, window.label().to_string());

    // 设置窗口标题
    let title = Path::new(&path).file_name()
        .map(|n| format!("{} — Lumen", n.to_string_lossy()))
        .unwrap_or_else(|| "Lumen".to_string());
    let _ = window.set_title(&title);

    // 成功后记录到最近文件（失败不阻塞）+ 广播
    let _ = prefs_store.record_recent(&path);
    let _ = app.emit("lv:prefs-changed", "recent_files");

    Ok(metadata)
}

#[tauri::command]
pub fn cmd_list_recent_files(prefs_store: State<'_, PrefsStore>) -> Vec<String> {
    prefs_store.list_recent()
}

#[tauri::command]
pub fn cmd_clear_recent_files(
    app: tauri::AppHandle,
    prefs_store: State<'_, PrefsStore>,
) -> Result<(), AppError> {
    prefs_store.clear_recent()?;
    let _ = app.emit("lv:prefs-changed", "recent_files");
    Ok(())
}

#[tauri::command]
pub fn cmd_get_metadata(
    window: tauri::Window,
    store: State<'_, SessionStore>,
) -> Result<FileMetadata, AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    session.metadata()
}

#[tauri::command]
pub fn cmd_query(
    window: tauri::Window,
    spec: QuerySpec,
    page: u32,
    page_size: u32,
    store: State<'_, SessionStore>,
) -> Result<QueryResponse, AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    let matched = query::run_query(&session, &spec)?;
    let meta = session.metadata()?;
    let stats = session.with_entries(|entries| {
        let mut s = stats::aggregate(entries, &matched);
        // 时间窗口：用 spec.time_range（若有）否则用文件整体 time_range
        let range = spec.time_range.or(meta.time_range);
        if let Some((from, to)) = range {
            s.time_buckets = stats::time_buckets(entries, &matched, (from, to), stats::DEFAULT_BUCKET_COUNT);
        }
        s
    })?;
    let page_entries = session.with_entries(|entries| {
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
    window: tauri::Window,
    spec: QuerySpec,
    page: u32,
    page_size: u32,
    store: State<'_, SessionStore>,
) -> Result<Vec<LogEntry>, AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    let matched = query::run_query(&session, &spec)?;
    session.with_entries(|entries| {
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
    window: tauri::Window,
    template_id: String,
    store: State<'_, SessionStore>,
    registry: State<'_, Registry>,
) -> Result<FileMetadata, AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    let lines = session.lines()?;
    let tpl = registry.find(&template_id)
        .ok_or_else(|| AppError::Internal(format!("模板未找到：{template_id}")))?;
    let entries = parser::parse_with_template(tpl.as_parser(), &lines);
    let old_meta = session.metadata()?;
    let metadata = parser::compute_metadata(&old_meta.path, &entries, &template_id);
    session.load_with_lines(metadata.clone(), entries, lines.to_vec());
    Ok(metadata)
}

#[tauri::command]
pub fn cmd_save_custom_template(
    app: tauri::AppHandle,
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
    let _ = app.emit("lv:prefs-changed", "templates");
    Ok(())
}

/// 列出所有自定义模板（完整数据，供导出 / 编辑前置数据加载）
#[tauri::command]
pub fn cmd_list_custom_templates(prefs_store: State<'_, PrefsStore>) -> Vec<CustomTemplate> {
    prefs_store.load().custom_templates
}

/// 按 id 查单个自定义模板（编辑对话框预填用）
#[tauri::command]
pub fn cmd_get_custom_template(
    id: String,
    prefs_store: State<'_, PrefsStore>,
) -> Option<CustomTemplate> {
    prefs_store.load().custom_templates.into_iter().find(|t| t.id == id)
}

#[tauri::command]
pub fn cmd_delete_custom_template(
    app: tauri::AppHandle,
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
    let _ = app.emit("lv:prefs-changed", "templates");
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
    window: tauri::Window,
    tpl: CustomTemplate,
    limit: u32,
    store: State<'_, SessionStore>,
) -> Result<TestResult, AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    let rt = crate::prefs::store::compile_custom_template(&tpl)?;
    let lines = session.lines()?;
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
    window: tauri::Window,
    app: AppHandle,
    store: State<'_, SessionStore>,
    registry: State<'_, Registry>,
) -> Result<(), AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    if session.is_following() { return Ok(()); }
    let meta = session.metadata()?;
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
    // 闭包中需要持有 session Arc，避免再走 store 查找
    let session_for_append = session.clone();

    let on_append = Arc::new(move |chunk: String| {
        if let Ok(new) = session_for_append.feed_chunk(tpl_arc_for_append.as_parser(), &chunk) {
            if !new.is_empty() {
                let total = session_for_append.metadata().map(|m| m.total).unwrap_or(0);
                let _ = app_for_append.emit("entries_appended", EntriesAppendedPayload { entries: new, total });
            }
        }
    });
    let on_rotation = Arc::new(move |ev: RotationEvent| {
        let kind = format!("{:?}", ev);
        let _ = app_for_rotation.emit("file_rotated", FileRotatedPayload { kind });
    });

    let watcher = FileWatcher::start(path, initial, on_append, on_rotation)?;
    session.install_watcher(SourceReader::File(watcher), incremental)?;
    Ok(())
}

#[tauri::command]
pub fn cmd_stop_follow(
    window: tauri::Window,
    store: State<'_, SessionStore>,
    registry: State<'_, Registry>,
) -> Result<(), AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    if !session.is_following() { return Ok(()); }
    let meta = session.metadata()?;
    if let Some(tpl_arc) = registry.find(&meta.template_id) {
        let _ = session.flush_incremental(tpl_arc.as_parser());
    }
    session.remove_watcher()
}

#[tauri::command]
pub fn cmd_export(
    window: tauri::Window,
    spec: QuerySpec,
    format: ExportFormat,
    path: String,
    store: State<'_, SessionStore>,
) -> Result<ExportResult, AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    let matched = query::run_query(&session, &spec)?;
    let file = std::fs::File::create(&path)
        .map_err(|e| AppError::Io(format!("创建导出文件失败：{e}")))?;
    let mut w = BufWriter::new(file);
    session.with_entries(|entries| -> std::io::Result<()> {
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
    app: tauri::AppHandle,
    prefs_store: State<'_, PrefsStore>,
    file_path: String,
    filter: SavedFilter,
) -> Result<Vec<SavedFilter>, AppError> {
    let result = prefs_store.save_filter(&file_path, filter)?;
    let _ = app.emit("lv:prefs-changed", "saved_filters");
    Ok(result)
}

#[tauri::command]
pub fn cmd_delete_saved_filter(
    app: tauri::AppHandle,
    prefs_store: State<'_, PrefsStore>,
    file_path: String,
    id: String,
) -> Result<Vec<SavedFilter>, AppError> {
    let result = prefs_store.delete_filter(&file_path, &id)?;
    let _ = app.emit("lv:prefs-changed", "saved_filters");
    Ok(result)
}

#[tauri::command]
pub fn cmd_rename_saved_filter(
    app: tauri::AppHandle,
    prefs_store: State<'_, PrefsStore>,
    file_path: String,
    id: String,
    new_name: String,
) -> Result<Vec<SavedFilter>, AppError> {
    let result = prefs_store.rename_filter(&file_path, &id, &new_name)?;
    let _ = app.emit("lv:prefs-changed", "saved_filters");
    Ok(result)
}

// ─── Cross-page Detail Nav ───

#[tauri::command]
pub fn cmd_get_neighbor(
    window: tauri::Window,
    spec: QuerySpec,
    line_no: u32,
    dir: NeighborDir,
    store: State<'_, SessionStore>,
) -> Result<Option<NeighborResponse>, AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    query::neighbor::neighbor(&session, &spec, line_no, dir)
}

#[tauri::command]
pub fn cmd_get_position(
    window: tauri::Window,
    spec: QuerySpec,
    line_no: u32,
    store: State<'_, SessionStore>,
) -> Result<Option<PositionResponse>, AppError> {
    let session = store.get(window.label()).ok_or(AppError::NoSession)?;
    query::neighbor::position(&session, &spec, line_no)
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
    app: tauri::AppHandle,
    prefs_store: State<'_, PrefsStore>,
    widths: std::collections::HashMap<String, u32>,
) -> Result<(), AppError> {
    prefs_store.save_column_widths(widths)?;
    let _ = app.emit("lv:prefs-changed", "column_prefs");
    Ok(())
}

#[tauri::command]
pub fn cmd_get_column_visibility(
    prefs_store: State<'_, PrefsStore>,
) -> Option<std::collections::HashMap<String, bool>> {
    prefs_store.get_column_visibility()
}

#[tauri::command]
pub fn cmd_save_column_visibility(
    app: tauri::AppHandle,
    prefs_store: State<'_, PrefsStore>,
    visibility: std::collections::HashMap<String, bool>,
) -> Result<(), AppError> {
    prefs_store.save_column_visibility(visibility)?;
    let _ = app.emit("lv:prefs-changed", "column_prefs");
    Ok(())
}

#[tauri::command]
pub fn cmd_get_font_size(prefs_store: State<'_, PrefsStore>) -> Option<u32> {
    prefs_store.get_font_size()
}

#[tauri::command]
pub fn cmd_save_font_size(
    app: tauri::AppHandle,
    prefs_store: State<'_, PrefsStore>,
    size: u32,
) -> Result<(), AppError> {
    prefs_store.save_font_size(size)?;
    let _ = app.emit("lv:prefs-changed", "font_size");
    Ok(())
}

#[tauri::command]
pub fn cmd_get_ui_prefs(prefs_store: State<'_, PrefsStore>) -> UiPrefs {
    prefs_store.get_ui_prefs()
}

#[tauri::command]
pub fn cmd_save_ui_prefs(
    prefs_store: State<'_, PrefsStore>,
    app: tauri::AppHandle,
    ui_prefs: UiPrefs,
) -> Result<(), AppError> {
    prefs_store.save_ui_prefs(ui_prefs)?;
    let _ = app.emit("lv:prefs-changed", "ui");
    Ok(())
}

/// 统一"打开文件"入口：同路径聚焦已有窗口，否则创建新窗口
#[tauri::command]
pub async fn cmd_open_in_new_window(
    app: tauri::AppHandle,
    store: State<'_, SessionStore>,
    path: String,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder, Manager};

    // 规范化路径（canonicalize 失败时 fallback 原 path，与 cmd_open_file 行为一致）
    let canonical = std::fs::canonicalize(&path)
        .unwrap_or_else(|_| PathBuf::from(&path));
    let uri = crate::model::LogSource::Local { path: canonical.clone() }.to_uri();

    // 查反向索引：已打开就聚焦
    if let Some(existing_label) = store.lookup_by_uri(&uri) {
        if let Some(w) = app.get_webview_window(&existing_label) {
            let _ = w.set_focus();
            return Ok(());
        }
        // label 在反向索引里但窗口已销毁 — 清理后走 fallthrough 开新窗
        store.close(&existing_label);
    }

    // 创建新窗口
    let label = format!("win-{}", uuid::Uuid::new_v4().simple());
    let canonical_str = canonical.to_string_lossy().into_owned();
    let encoded_path = urlencoding::encode(&canonical_str);
    let url = format!("/?path={}", encoded_path);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Lumen")
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;

    Ok(())
}

/// 弹空白窗口（⌘N / macOS dock reopen）
#[tauri::command]
pub async fn cmd_open_blank_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let label = format!("win-{}", uuid::Uuid::new_v4().simple());
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("/".into()))
        .title("Lumen")
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;
    Ok(())
}
