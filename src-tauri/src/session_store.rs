// SessionStore：per-window 的 SessionState 容器 + path 反向索引
// 用 DashMap 让不同窗口的操作互不阻塞（不像单一全局 Mutex 会串行）

use crate::session::SessionState;
use dashmap::DashMap;
use std::sync::Arc;

#[derive(Default)]
pub struct SessionStore {
    sessions: DashMap<String, Arc<SessionState>>,
    path_to_label: DashMap<String, String>,  // key = LogSource::to_uri()
    pending_connections: DashMap<String, PendingConnection>,
    /// "仅本次"接受的主机指纹 — 进程退出即清空；不写盘
    /// key = (host, port), value = base64 fingerprint
    session_bypasses: DashMap<(String, u16), String>,
}

impl SessionStore {
    pub fn new() -> Self {
        let store = Self::default();
        store.start_cleanup_task();
        store
    }

    /// 内部启动清理线程：每 2s 扫描过期 pending（clone DashMap Arc，线程 'static safe）
    fn start_cleanup_task(&self) {
        let pending = self.pending_connections.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let now = std::time::Instant::now();
                pending.retain(|_, v| now.duration_since(v.created_at).as_secs() < 5);
            }
        });
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

    /// 给 URI 登记一个 label（cmd_open_file 成功后调）
    pub fn register_path(&self, source_uri: String, label: String) {
        self.path_to_label.insert(source_uri, label);
    }

    /// 反查：哪个 label 在看这个 URI
    pub fn lookup_by_uri(&self, uri: &str) -> Option<String> {
        self.path_to_label.get(uri).map(|v| v.clone())
    }

    /// 存入 pending connection（新窗口 spawn 时缓存，等窗口 mount 后取出）
    pub fn put_pending(&self, label: String, pending: PendingConnection) {
        self.pending_connections.insert(label, pending);
    }

    /// 取出并消费 pending connection
    pub fn take_pending(&self, label: &str) -> Option<PendingConnection> {
        self.pending_connections.remove(label).map(|(_, v)| v)
    }

    /// 清理超过 5 秒未消费的 pending — 由内部 cleanup task 周期调用
    pub fn sweep_stale_pending(&self) {
        let now = std::time::Instant::now();
        self.pending_connections.retain(|_, v| now.duration_since(v.created_at).as_secs() < 5);
    }

    /// "仅本次"信任：记录 (host, port) → fingerprint 到内存。
    /// 只对本次进程生命周期有效，绝不落盘。
    pub fn add_session_bypass(&self, host: String, port: u16, fingerprint: String) {
        self.session_bypasses.insert((host, port), fingerprint);
    }

    /// 查 (host, port, fingerprint) 是否已被"仅本次"接受。
    /// 必须三元组完全匹配才返回 true — 防止 fingerprint 漂移后误放行。
    pub fn is_bypassed(&self, host: &str, port: u16, fingerprint: &str) -> bool {
        self.session_bypasses
            .get(&(host.to_string(), port))
            .map(|fp| fp.as_str() == fingerprint)
            .unwrap_or(false)
    }
}

use crate::remote::ssh_session::SshConnectionParams;

#[derive(Debug, Clone)]
pub struct PendingConnection {
    pub params: SshConnectionParams,
    pub path: String,
    pub tail_lines: usize,
    pub created_at: std::time::Instant,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn open_then_lookup_hits() {
        let store = SessionStore::new();
        let _s = store.get_or_create("win-1");
        let uri = crate::model::LogSource::Local { path: PathBuf::from("/var/log/a.log") }.to_uri();
        store.register_path(uri.clone(), "win-1".into());
        assert_eq!(store.lookup_by_uri(&uri), Some("win-1".into()));
    }

    #[test]
    fn lookup_unknown_returns_none() {
        let store = SessionStore::new();
        let uri = crate::model::LogSource::Local { path: PathBuf::from("/var/log/nope.log") }.to_uri();
        assert_eq!(store.lookup_by_uri(&uri), None);
    }

    #[test]
    fn close_drops_session_and_path_index() {
        let store = SessionStore::new();
        let _s = store.get_or_create("win-1");
        let uri = crate::model::LogSource::Local { path: PathBuf::from("/var/log/a.log") }.to_uri();
        store.register_path(uri.clone(), "win-1".into());
        store.close("win-1");
        assert!(store.get("win-1").is_none());
        assert_eq!(store.lookup_by_uri(&uri), None);
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

        // 线程 B 操作 win-b — 应该立即完成
        thread::sleep(Duration::from_millis(10));
        let started = Instant::now();
        let session_b = store.get("win-b").unwrap();
        let _ = session_b.metadata();
        let elapsed = started.elapsed();
        // 200ms 留足缓冲（实测 <1ms，但慢机器/CI 调度有抖动）
        assert!(elapsed < Duration::from_millis(200),
            "win-b operation blocked: {:?}", elapsed);

        h1.join().unwrap();
    }

    #[test]
    fn session_bypass_matches_only_on_exact_tuple() {
        let store = SessionStore::new();
        store.add_session_bypass("h".into(), 22, "FP".into());
        assert!(store.is_bypassed("h", 22, "FP"));
        assert!(!store.is_bypassed("h", 22, "OTHER"));
        assert!(!store.is_bypassed("h", 23, "FP"));
        assert!(!store.is_bypassed("h2", 22, "FP"));
    }

    #[test]
    fn pending_put_take_roundtrip() {
        use crate::remote::ssh_session::{SshConnectionParams, Credential};
        let store = SessionStore::new();
        let params = SshConnectionParams {
            host: "host".into(),
            port: 22,
            user: "user".into(),
            credential: Credential::Password("secret".into()),
        };
        let pending = PendingConnection {
            params,
            path: "/var/log/app.log".into(),
            tail_lines: 200,
            created_at: std::time::Instant::now(),
        };
        store.put_pending("win-ssh".into(), pending);
        let taken = store.take_pending("win-ssh");
        assert!(taken.is_some());
        assert_eq!(taken.unwrap().path, "/var/log/app.log");
        // 第二次 take 应为 None
        assert!(store.take_pending("win-ssh").is_none());
    }
}
