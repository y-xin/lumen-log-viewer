// 多窗口集成测试 — 验证 SessionStore 在 cmd 层面的语义
// 不依赖真实 Tauri Window；构造 SessionStore + 调 session API 直接验证

use log_viewer_lib::model::FileMetadata;
use log_viewer_lib::session_store::SessionStore;
use std::collections::HashMap;
use std::path::PathBuf;

fn make_dummy_metadata(path: &str) -> FileMetadata {
    FileMetadata {
        path: path.into(),
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
fn two_windows_have_independent_sessions() {
    // 两个窗口加载不同文件，元数据应互不干扰
    let store = SessionStore::new();
    let a = store.get_or_create("win-a");
    let b = store.get_or_create("win-b");
    a.load(make_dummy_metadata("/a.log"), vec![]);
    b.load(make_dummy_metadata("/b.log"), vec![]);
    assert_eq!(a.metadata().unwrap().path, "/a.log");
    assert_eq!(b.metadata().unwrap().path, "/b.log");
}

#[test]
fn closing_one_window_leaves_other_alive() {
    // 关闭 win-a 不影响 win-b 的 session 存活
    let store = SessionStore::new();
    let _a = store.get_or_create("win-a");
    let b = store.get_or_create("win-b");
    b.load(make_dummy_metadata("/b.log"), vec![]);
    store.close("win-a");
    assert!(store.get("win-a").is_none());
    let b_again = store.get("win-b").unwrap();
    assert_eq!(b_again.metadata().unwrap().path, "/b.log");
}

#[test]
fn lookup_by_uri_returns_existing_label() {
    // 注册 URI → label 后可反查；close 后索引被清理
    // (Task 5.2 后 register_path 接 URI 字符串而非 PathBuf；lookup_by_path → lookup_by_uri)
    let store = SessionStore::new();
    let _a = store.get_or_create("win-a");
    store.register_path("file:///tmp/a.log".into(), "win-a".into());
    assert_eq!(
        store.lookup_by_uri("file:///tmp/a.log"),
        Some("win-a".into())
    );
    // 不同路径应返回 None
    assert_eq!(store.lookup_by_uri("file:///tmp/b.log"), None);
    // close 后反向索引应被清理
    store.close("win-a");
    assert_eq!(store.lookup_by_uri("file:///tmp/a.log"), None);
}
