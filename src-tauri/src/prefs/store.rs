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
}

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
            return Prefs { version: 1, custom_templates: vec![] };
        }
        match fs::read_to_string(&self.path) {
            Ok(s) => match serde_json::from_str::<Prefs>(&s) {
                Ok(p) => p,
                Err(_) => {
                    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                    let bak = self.path.with_extension(format!("json.bak.{}", ts));
                    let _ = fs::rename(&self.path, &bak);
                    Prefs { version: 1, custom_templates: vec![] }
                }
            }
            Err(_) => Prefs { version: 1, custom_templates: vec![] },
        }
    }

    pub fn save(&self, prefs: &Prefs) -> Result<(), AppError> {
        let s = serde_json::to_string_pretty(prefs)
            .map_err(|e| AppError::Internal(format!("序列化 prefs 失败：{e}")))?;
        fs::write(&self.path, s)?;
        Ok(())
    }
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
        let prefs = Prefs { version: 1, custom_templates: vec![sample_template()] };
        store.save(&prefs).unwrap();
        let loaded = store.load();
        assert_eq!(loaded.custom_templates.len(), 1);
        assert_eq!(loaded.custom_templates[0].id, "test");
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
}
