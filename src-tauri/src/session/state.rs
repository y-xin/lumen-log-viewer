// SessionState：进程级单例（通过 Tauri State 注入）
// 保存当前打开文件的所有 LogEntry + 元数据 + 查询缓存 + watcher 句柄

use crate::error::AppError;
use crate::loader::reader::{self};
use crate::model::{FileMetadata, LogEntry};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Default)]
pub struct SessionState(RwLock<Option<SessionInner>>);

pub struct SessionInner {
    pub metadata: FileMetadata,
    pub entries: Arc<RwLock<Vec<LogEntry>>>,
    pub cache: HashMap<u64, Arc<Vec<u32>>>,
    pub lines: Arc<Vec<String>>,
    pub watcher: Option<crate::loader::watcher::FileWatcher>,
    pub incremental: Option<crate::loader::incremental::IncrementalParser>,
    pub last_offset: u64,
    pub last_inode: u64,
}

impl SessionState {
    pub fn load_with_lines(&self, metadata: FileMetadata, entries: Vec<LogEntry>, lines: Vec<String>) {
        let initial_meta = reader::file_meta(std::path::Path::new(&metadata.path))
            .unwrap_or(reader::FileMeta { size: 0, inode: 0 });
        let mut w = self.0.write();
        *w = Some(SessionInner {
            metadata,
            entries: Arc::new(RwLock::new(entries)),
            cache: HashMap::new(),
            lines: Arc::new(lines),
            watcher: None,
            incremental: None,
            last_offset: initial_meta.size,
            last_inode: initial_meta.inode,
        });
    }

    pub fn load(&self, metadata: FileMetadata, entries: Vec<LogEntry>) {
        self.load_with_lines(metadata, entries, vec![]);
    }

    pub fn with_entries<F, R>(&self, f: F) -> Result<R, AppError>
    where F: FnOnce(&[LogEntry]) -> R {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        let entries = inner.entries.read();
        Ok(f(&entries))
    }

    pub fn metadata(&self) -> Result<FileMetadata, AppError> {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        Ok(inner.metadata.clone())
    }

    pub fn lines(&self) -> Result<Arc<Vec<String>>, AppError> {
        let r = self.0.read();
        let inner = r.as_ref().ok_or(AppError::NoSession)?;
        Ok(inner.lines.clone())
    }

    pub fn cached_or_compute<F>(&self, key: u64, compute: F) -> Result<Arc<Vec<u32>>, AppError>
    where F: FnOnce(&[LogEntry]) -> Vec<u32> {
        {
            let r = self.0.read();
            let inner = r.as_ref().ok_or(AppError::NoSession)?;
            if let Some(hit) = inner.cache.get(&key) {
                return Ok(hit.clone());
            }
        }
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        if let Some(hit) = inner.cache.get(&key) {
            return Ok(hit.clone());
        }
        let result = {
            let entries = inner.entries.read();
            Arc::new(compute(&entries))
        };
        inner.cache.insert(key, result.clone());
        Ok(result)
    }

    pub fn install_watcher(
        &self,
        watcher: crate::loader::watcher::FileWatcher,
        incremental: crate::loader::incremental::IncrementalParser,
    ) -> Result<(), AppError> {
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        inner.watcher = Some(watcher);
        inner.incremental = Some(incremental);
        Ok(())
    }

    pub fn remove_watcher(&self) -> Result<(), AppError> {
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        inner.watcher = None;
        inner.incremental = None;
        Ok(())
    }

    pub fn is_following(&self) -> bool {
        let r = self.0.read();
        r.as_ref().map(|i| i.watcher.is_some()).unwrap_or(false)
    }

    /// 给 watcher 回调用的：拿 incremental 处理 chunk + 追加结果。
    /// 内部分两次 write lock 避免借用冲突（incremental.as_mut() 与 entries.write() 同时持有会失败）。
    pub fn feed_chunk<T: crate::parser::template::ParserTemplate + ?Sized + Sync>(
        &self,
        tpl: &T,
        chunk: &str,
    ) -> Result<Vec<LogEntry>, AppError> {
        let new_entries = {
            let mut w = self.0.write();
            let inner = w.as_mut().ok_or(AppError::NoSession)?;
            let inc = inner.incremental.as_mut()
                .ok_or_else(|| AppError::Internal("watcher 未启动".into()))?;
            inc.feed(tpl, chunk)
        };
        self.append_internal(&new_entries)?;
        Ok(new_entries)
    }

    pub fn flush_incremental<T: crate::parser::template::ParserTemplate + ?Sized + Sync>(
        &self,
        tpl: &T,
    ) -> Result<Vec<LogEntry>, AppError> {
        let new_entries = {
            let mut w = self.0.write();
            let inner = w.as_mut().ok_or(AppError::NoSession)?;
            let inc = inner.incremental.as_mut()
                .ok_or_else(|| AppError::Internal("watcher 未启动".into()))?;
            inc.flush(tpl)
        };
        self.append_internal(&new_entries)?;
        Ok(new_entries)
    }

    fn append_internal(&self, new_entries: &[LogEntry]) -> Result<(), AppError> {
        if new_entries.is_empty() { return Ok(()); }
        let mut w = self.0.write();
        let inner = w.as_mut().ok_or(AppError::NoSession)?;
        {
            let mut entries = inner.entries.write();
            entries.extend(new_entries.iter().cloned());
        }
        inner.cache.clear();
        let new_total = inner.entries.read().len() as u32;
        inner.metadata.total = new_total;
        Ok(())
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
            line_count: 1,
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
            scope_counts: HashMap::new(),
            template_id: "json-lines".into(),
            sniff_kind: None,
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
