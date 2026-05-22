// prefs.json 读写：保存自定义解析模板
// 路径：{config_dir()}/log-viewer/prefs.json
// 损坏时备份为 prefs.json.bak.{ts} 并重置为默认

use crate::error::AppError;
use crate::query::ScopeFilter;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomTemplate {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub start_pattern: String,
    pub time_formats: Vec<String>,
    pub field_map: CustomFieldMap,
    /// "none" | "json_object" | "json_like"
    pub tail_parser: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomFieldMap {
    pub timestamp: Option<String>,
    pub level: Option<String>,
    pub scope: Option<String>,
    pub message: Option<String>,
}

/// 命名保存的筛选器（按文件路径独立）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedFilter {
    /// 前端 crypto.randomUUID() 生成
    pub id: String,
    pub name: String,
    /// ISO 8601 UTC，用于排序
    pub created_at: String,
    pub levels: Option<Vec<String>>,
    pub scope_filter: Option<ScopeFilter>,
    pub text_search: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Prefs {
    pub version: u32,
    pub custom_templates: Vec<CustomTemplate>,
    /// 最近打开过的文件路径，最新的在前，最多保留 MAX_RECENT_FILES 个。
    /// 不存在/不可访问的路径在 list 时由前端忽略，文件内保留。
    #[serde(default)]
    pub recent_files: Vec<String>,
    /// 命名筛选器：key = 文件绝对路径，value = 该文件下保存的筛选器列表
    #[serde(default)]
    pub saved_filters: HashMap<String, Vec<SavedFilter>>,
    /// UI 偏好：列宽（key = "line" | "time" | "level" | "scope"，value = px）
    /// 全局生效，不按文件区分；用户拖一次就记住。
    #[serde(default)]
    pub column_widths: Option<HashMap<String, u32>>,
}

const MAX_RECENT_FILES: usize = 10;

pub struct PrefsStore {
    path: PathBuf,
}

impl PrefsStore {
    pub fn new() -> Result<Self, AppError> {
        let dirs = ProjectDirs::from("dev", "local", "log-viewer")
            .ok_or_else(|| AppError::Internal("无法定位 config_dir".into()))?;
        let dir = dirs.config_dir().to_path_buf();
        fs::create_dir_all(&dir)?;
        let path = dir.join("prefs.json");
        Ok(Self { path })
    }

    /// 仅用于测试：指定路径
    pub fn at(path: PathBuf) -> Self { Self { path } }

    pub fn load(&self) -> Prefs {
        if !self.path.exists() {
            return Prefs::default_v1();
        }
        match fs::read_to_string(&self.path) {
            Ok(s) => match serde_json::from_str::<Prefs>(&s) {
                Ok(p) => p,
                Err(_) => {
                    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                    let bak = self.path.with_extension(format!("json.bak.{}", ts));
                    let _ = fs::rename(&self.path, &bak);
                    Prefs::default_v1()
                }
            }
            Err(_) => Prefs::default_v1(),
        }
    }

    pub fn save(&self, prefs: &Prefs) -> Result<(), AppError> {
        let s = serde_json::to_string_pretty(prefs)
            .map_err(|e| AppError::Internal(format!("序列化 prefs 失败：{e}")))?;
        fs::write(&self.path, s)?;
        Ok(())
    }

    /// 把 path 移到 recent_files 队首，去重并截断到 MAX_RECENT_FILES。
    pub fn record_recent(&self, path: &str) -> Result<(), AppError> {
        let mut prefs = self.load();
        prefs.recent_files.retain(|p| p != path);
        prefs.recent_files.insert(0, path.to_string());
        if prefs.recent_files.len() > MAX_RECENT_FILES {
            prefs.recent_files.truncate(MAX_RECENT_FILES);
        }
        self.save(&prefs)
    }

    pub fn list_recent(&self) -> Vec<String> {
        self.load().recent_files
    }

    pub fn clear_recent(&self) -> Result<(), AppError> {
        let mut prefs = self.load();
        prefs.recent_files.clear();
        self.save(&prefs)
    }

    /// 读列宽偏好；从未保存返回 None
    pub fn get_column_widths(&self) -> Option<HashMap<String, u32>> {
        self.load().column_widths
    }

    /// 写列宽偏好（整张表覆盖）
    pub fn save_column_widths(&self, widths: HashMap<String, u32>) -> Result<(), AppError> {
        let mut prefs = self.load();
        prefs.column_widths = Some(widths);
        self.save(&prefs)
    }

    /// 列出某文件下的所有保存筛选，按 created_at 倒序（最新在前）
    pub fn list_filters(&self, file_path: &str) -> Vec<SavedFilter> {
        let prefs = self.load();
        let mut v = prefs.saved_filters.get(file_path).cloned().unwrap_or_default();
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        v
    }

    /// 追加保存（id 重复时覆盖原条目），返回更新后排序好的列表
    pub fn save_filter(
        &self,
        file_path: &str,
        filter: SavedFilter,
    ) -> Result<Vec<SavedFilter>, AppError> {
        let mut prefs = self.load();
        let v = prefs.saved_filters.entry(file_path.to_string()).or_default();
        v.retain(|f| f.id != filter.id);
        v.push(filter);
        self.save(&prefs)?;
        Ok(self.list_filters(file_path))
    }

    /// 按 id 删除；找不到 id 不报错（幂等）
    pub fn delete_filter(
        &self,
        file_path: &str,
        id: &str,
    ) -> Result<Vec<SavedFilter>, AppError> {
        let mut prefs = self.load();
        if let Some(v) = prefs.saved_filters.get_mut(file_path) {
            v.retain(|f| f.id != id);
        }
        self.save(&prefs)?;
        Ok(self.list_filters(file_path))
    }

    /// 按 id 重命名；找不到返回 Err
    pub fn rename_filter(
        &self,
        file_path: &str,
        id: &str,
        new_name: &str,
    ) -> Result<Vec<SavedFilter>, AppError> {
        let mut prefs = self.load();
        let v = prefs
            .saved_filters
            .get_mut(file_path)
            .ok_or_else(|| AppError::Internal(format!("文件无任何保存筛选：{file_path}")))?;
        let target = v
            .iter_mut()
            .find(|f| f.id == id)
            .ok_or_else(|| AppError::Internal(format!("找不到 saved filter id={id}")))?;
        target.name = new_name.to_string();
        self.save(&prefs)?;
        Ok(self.list_filters(file_path))
    }
}

impl Prefs {
    fn default_v1() -> Self {
        Prefs {
            version: 1,
            custom_templates: vec![],
            recent_files: vec![],
            saved_filters: HashMap::new(),
            column_widths: None,
        }
    }
}

use crate::parser::regex_template::{FieldMap, RegexTemplate};
use crate::parser::tail_parser::TailParserKind;
use regex::Regex;

/// 把持久化的 CustomTemplate 编译为可运行的 RegexTemplate
pub fn compile_custom_template(c: &CustomTemplate) -> Result<RegexTemplate, AppError> {
    let pattern = Regex::new(&c.pattern)
        .map_err(|e| AppError::Parse(format!("pattern 编译失败：{e}")))?;
    let start_pattern = Regex::new(&c.start_pattern)
        .map_err(|e| AppError::Parse(format!("start_pattern 编译失败：{e}")))?;
    let tail = match c.tail_parser.as_str() {
        "none" => None,
        "json_object" => Some(TailParserKind::JsonObject),
        "json_like" => Some(TailParserKind::JsonLike),
        other => return Err(AppError::Parse(format!("未知 tail_parser: {other}"))),
    };
    Ok(RegexTemplate {
        id: c.id.clone(),
        name: c.name.clone(),
        pattern,
        start_pattern,
        time_formats: c.time_formats.clone(),
        field_map: FieldMap {
            timestamp: c.field_map.timestamp.clone(),
            level: c.field_map.level.clone(),
            scope: c.field_map.scope.clone(),
            message: c.field_map.message.clone(),
        },
        tail,
        unwrap_nested: false,   // 自定义模板默认不开启嵌套剥离（避免意外行为）
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_template() -> CustomTemplate {
        CustomTemplate {
            id: "test".into(),
            name: "Test".into(),
            pattern: "^.*$".into(),
            start_pattern: "^.".into(),
            time_formats: vec![],
            field_map: CustomFieldMap {
                timestamp: None, level: None, scope: None, message: Some("msg".into()),
            },
            tail_parser: "none".into(),
        }
    }

    #[test]
    fn load_returns_empty_when_file_absent() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        let p = store.load();
        assert_eq!(p.version, 1);
        assert!(p.custom_templates.is_empty());
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        let prefs = Prefs {
            version: 1,
            custom_templates: vec![sample_template()],
            recent_files: vec![],
            saved_filters: HashMap::new(),
            column_widths: None,
        };
        store.save(&prefs).unwrap();
        let loaded = store.load();
        assert_eq!(loaded.custom_templates.len(), 1);
        assert_eq!(loaded.custom_templates[0].id, "test");
    }

    #[test]
    fn record_recent_dedupes_and_moves_to_front() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        store.record_recent("/a.log").unwrap();
        store.record_recent("/b.log").unwrap();
        store.record_recent("/c.log").unwrap();
        store.record_recent("/a.log").unwrap();   // 再开 /a.log → 移到队首
        let r = store.list_recent();
        assert_eq!(r, vec!["/a.log".to_string(), "/c.log".to_string(), "/b.log".to_string()]);
    }

    #[test]
    fn record_recent_truncates_to_max() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        for i in 0..15 {
            store.record_recent(&format!("/f{}.log", i)).unwrap();
        }
        let r = store.list_recent();
        assert_eq!(r.len(), MAX_RECENT_FILES);
        // 最新的在前
        assert_eq!(r[0], "/f14.log");
    }

    #[test]
    fn clear_recent_empties_list() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        store.record_recent("/a.log").unwrap();
        store.clear_recent().unwrap();
        assert!(store.list_recent().is_empty());
    }

    #[test]
    fn corrupted_file_is_backed_up_and_reset() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        fs::write(&path, "not valid json").unwrap();
        let store = PrefsStore::at(path.clone());
        let p = store.load();
        assert!(p.custom_templates.is_empty());
        let entries: Vec<_> = fs::read_dir(dir.path()).unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.iter().any(|n| n.starts_with("prefs.json.bak.")));
    }

    #[test]
    fn compile_custom_template_ok() {
        let c = CustomTemplate {
            id: "x".into(),
            name: "X".into(),
            pattern: r"^(?P<msg>.*)$".into(),
            start_pattern: "^.".into(),
            time_formats: vec![],
            field_map: CustomFieldMap {
                timestamp: None, level: None, scope: None, message: Some("msg".into()),
            },
            tail_parser: "json_like".into(),
        };
        let rt = compile_custom_template(&c).unwrap();
        assert_eq!(rt.id, "x");
        assert!(rt.tail.is_some());
    }

    #[test]
    fn compile_custom_template_rejects_bad_regex() {
        let c = CustomTemplate {
            id: "x".into(), name: "X".into(),
            pattern: "[invalid".into(),
            start_pattern: "^".into(),
            time_formats: vec![],
            field_map: CustomFieldMap { timestamp: None, level: None, scope: None, message: None },
            tail_parser: "none".into(),
        };
        let r = compile_custom_template(&c);
        assert!(matches!(r, Err(AppError::Parse(_))));
    }

    use crate::query::{MatchMode, ScopeFilter as QScopeFilter};

    fn sample_filter(id: &str, name: &str, created: &str) -> SavedFilter {
        SavedFilter {
            id: id.into(),
            name: name.into(),
            created_at: created.into(),
            levels: Some(vec!["error".into()]),
            scope_filter: Some(QScopeFilter {
                field_name: "scope".into(),
                pattern: "auth.*".into(),
                mode: MatchMode::Glob,
            }),
            text_search: None,
        }
    }

    #[test]
    fn save_filter_and_list_roundtrip() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        let f = sample_filter("id1", "f1", "2026-05-22T10:00:00Z");
        let updated = store.save_filter("/a.log", f).unwrap();
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].id, "id1");
        let listed = store.list_filters("/a.log");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "f1");
    }

    #[test]
    fn save_filter_two_for_same_path_returns_sorted_desc_by_created_at() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        store
            .save_filter("/a.log", sample_filter("a", "old", "2026-05-22T08:00:00Z"))
            .unwrap();
        let v = store
            .save_filter("/a.log", sample_filter("b", "new", "2026-05-22T10:00:00Z"))
            .unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].id, "b"); // 新的在前
        assert_eq!(v[1].id, "a");
    }

    #[test]
    fn delete_filter_is_idempotent_on_missing_id() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        store
            .save_filter("/a.log", sample_filter("keep", "k", "2026-05-22T10:00:00Z"))
            .unwrap();
        let v = store.delete_filter("/a.log", "doesnotexist").unwrap();
        assert_eq!(v.len(), 1); // 原条目仍在
        let v2 = store.delete_filter("/a.log", "keep").unwrap();
        assert!(v2.is_empty());
    }

    #[test]
    fn rename_filter_errors_when_id_missing() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        store
            .save_filter("/a.log", sample_filter("x", "old", "2026-05-22T10:00:00Z"))
            .unwrap();
        let r = store.rename_filter("/a.log", "wrongid", "newname");
        assert!(matches!(r, Err(AppError::Internal(_))));
        // 原 name 没变
        let v = store.list_filters("/a.log");
        assert_eq!(v[0].name, "old");
    }

    #[test]
    fn filters_on_different_paths_are_isolated() {
        let dir = tempdir().unwrap();
        let store = PrefsStore::at(dir.path().join("prefs.json"));
        store
            .save_filter("/a.log", sample_filter("a", "fa", "2026-05-22T10:00:00Z"))
            .unwrap();
        store
            .save_filter("/b.log", sample_filter("b", "fb", "2026-05-22T10:00:00Z"))
            .unwrap();
        let va = store.list_filters("/a.log");
        let vb = store.list_filters("/b.log");
        assert_eq!(va.len(), 1);
        assert_eq!(vb.len(), 1);
        assert_eq!(va[0].id, "a");
        assert_eq!(vb[0].id, "b");
    }
}
