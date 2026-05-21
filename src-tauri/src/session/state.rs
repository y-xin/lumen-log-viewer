// SessionState：进程级单例（通过 Tauri State 注入）
// 保存当前打开文件的所有 LogEntry + 元数据 + 查询缓存

use crate::error::AppError;
use crate::model::{FileMetadata, LogEntry};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Default)]
pub struct SessionState(RwLock<Option<SessionInner>>);

pub struct SessionInner {
    pub metadata: FileMetadata,
    pub entries: Arc<Vec<LogEntry>>,
    pub cache: HashMap<u64, Arc<Vec<u32>>>, // QuerySpec hash → matched line indices
}

impl SessionState {
    pub fn load(&self, metadata: FileMetadata, entries: Vec<LogEntry>) {
        let mut w = self.0.write();
        *w = Some(SessionInner {
            metadata,
            entries: Arc::new(entries),
            cache: HashMap::new(),
        });
    }

    pub fn with_entries<F, R>(&self, f: F) -> Result<R, AppError>
    where F: FnOnce(&Arc<Vec<LogEntry>>) -> R {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        Ok(f(&inner.entries))
    }

    pub fn metadata(&self) -> Result<FileMetadata, AppError> {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        Ok(inner.metadata.clone())
    }

    /// 查询缓存：命中返回索引数组；未命中调用 compute 算并写回
    pub fn cached_or_compute<F>(&self, key: u64, compute: F) -> Result<Arc<Vec<u32>>, AppError>
    where F: FnOnce(&Arc<Vec<LogEntry>>) -> Vec<u32> {
        // 读：命中直接返回
        {
            let r = self.0.read();
            let inner = r.as_ref().ok_or(AppError::NoSession)?;
            if let Some(hit) = inner.cache.get(&key) {
                return Ok(hit.clone());
            }
        }
        // 未命中：写锁下计算
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        if let Some(hit) = inner.cache.get(&key) {
            return Ok(hit.clone()); // double-check
        }
        let result = Arc::new(compute(&inner.entries));
        inner.cache.insert(key, result.clone());
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LogEntry, LogLevel};
    use std::collections::HashMap;

    fn dummy_entry(line: u32) -> LogEntry {
        LogEntry {
            line_no: line,
            timestamp: None,
            level: LogLevel::Info,
            scope: None,
            message: String::new(),
            fields: HashMap::new(),
            raw: String::new(),
        }
    }

    fn dummy_meta() -> FileMetadata {
        FileMetadata {
            path: "/x".into(),
            total: 0,
            time_range: None,
            level_counts: HashMap::new(),
            scopes: vec![],
            template_id: "json-lines".into(),
        }
    }

    #[test]
    fn returns_no_session_before_load() {
        let s = SessionState::default();
        assert!(matches!(s.metadata(), Err(AppError::NoSession)));
    }

    #[test]
    fn caches_compute_result() {
        let s = SessionState::default();
        s.load(dummy_meta(), vec![dummy_entry(1), dummy_entry(2)]);
        let mut hits = 0;
        let _ = s.cached_or_compute(99, |_| { hits += 1; vec![0] }).unwrap();
        let _ = s.cached_or_compute(99, |_| { hits += 1; vec![0] }).unwrap();
        assert_eq!(hits, 1, "第二次应该命中缓存");
    }
}
