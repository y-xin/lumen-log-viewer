// prefs.json 读写：保存自定义解析模板
// 路径：{config_dir()}/log-viewer/prefs.json
// 损坏时备份为 prefs.json.bak.{ts} 并重置为默认

use crate::error::AppError;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Prefs {
    pub version: u32,
    pub custom_templates: Vec<CustomTemplate>,
    /// 最近打开过的文件路径，最新的在前，最多保留 MAX_RECENT_FILES 个。
    /// 不存在/不可访问的路径在 list 时由前端忽略，文件内保留。
    #[serde(default)]
    pub recent_files: Vec<String>,
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
}

impl Prefs {
    fn default_v1() -> Self {
        Prefs { version: 1, custom_templates: vec![], recent_files: vec![] }
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
}
