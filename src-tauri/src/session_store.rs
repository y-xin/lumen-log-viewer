// SessionStore：per-window 的 SessionState 容器 + path 反向索引
// 用 DashMap 让不同窗口的操作互不阻塞（不像单一全局 Mutex 会串行）

use crate::session::SessionState;
use dashmap::DashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Default)]
pub struct SessionStore {
    sessions: DashMap<String, Arc<SessionState>>,
    path_to_label: DashMap<PathBuf, String>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取或新建该 label 的 session（不存在就 default）
    pub fn get_or_create(&self, label: &str) -> Arc<SessionState> {
        self.sessions
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(SessionState::default()))
            .clone()
    }

    /// 取已存在的 session；不存在返回 None
    pub fn get(&self, label: &str) -> Option<Arc<SessionState>> {
        self.sessions.get(label).map(|r| r.clone())
    }

    /// 关闭窗口：drop session（watcher 自动释放）+ 清反向索引
    pub fn close(&self, label: &str) {
        if let Some((_, _session)) = self.sessions.remove(label) {
            self.path_to_label.retain(|_, v| v != label);
        }
    }

    /// 给 path 登记一个 label（cmd_open_file 成功后调）
    pub fn register_path(&self, path: PathBuf, label: String) {
        self.path_to_label.insert(path, label);
    }

    /// 反查：哪个 label 在看这个 path
    pub fn lookup_by_path(&self, path: &Path) -> Option<String> {
        self.path_to_label.get(path).map(|r| r.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_then_lookup_hits() {
        let store = SessionStore::new();
        let _s = store.get_or_create("win-1");
        store.register_path(PathBuf::from("/var/log/a.log"), "win-1".into());
        assert_eq!(store.lookup_by_path(Path::new("/var/log/a.log")), Some("win-1".into()));
    }

    #[test]
    fn lookup_unknown_returns_none() {
        let store = SessionStore::new();
        assert_eq!(store.lookup_by_path(Path::new("/var/log/nope.log")), None);
    }

    #[test]
    fn close_drops_session_and_path_index() {
        let store = SessionStore::new();
        let _s = store.get_or_create("win-1");
        store.register_path(PathBuf::from("/var/log/a.log"), "win-1".into());
        store.close("win-1");
        assert!(store.get("win-1").is_none());
        assert_eq!(store.lookup_by_path(Path::new("/var/log/a.log")), None);
    }

    #[test]
    fn get_after_close_returns_none() {
        let store = SessionStore::new();
        let _s = store.get_or_create("win-1");
        store.close("win-1");
        assert!(store.get("win-1").is_none());
    }

    #[test]
    fn concurrent_get_different_labels_does_not_block() {
        use std::sync::Arc;
        use std::thread;
        use std::time::{Duration, Instant};

        let store = Arc::new(SessionStore::new());
        let _a = store.get_or_create("win-a");
        let _b = store.get_or_create("win-b");

        // 线程 A 拿 win-a 的 SessionState 锁 100ms
        let store_a = store.clone();
        let h1 = thread::spawn(move || {
            let session = store_a.get("win-a").unwrap();
            let _meta = session.metadata(); // 触发内部 RwLock read，立刻释放
            thread::sleep(Duration::from_millis(100));
        });

        // 线程 B 操作 win-b — 应该立即完成（< 50ms）
        thread::sleep(Duration::from_millis(10));
        let started = Instant::now();
        let session_b = store.get("win-b").unwrap();
        let _ = session_b.metadata();
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_millis(50),
            "win-b operation blocked: {:?}", elapsed);

        h1.join().unwrap();
    }
}
