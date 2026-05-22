// 模块入口，公开给集成测试与 main.rs

pub mod commands;
pub mod error;
pub mod loader;
pub mod model;
pub mod parser;
pub mod prefs;
pub mod query;
pub mod session;
pub mod stats;

use parser::registry::Registry;
use prefs::PrefsStore;
use session::SessionState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let prefs_store = PrefsStore::new().expect("初始化 prefs 失败");
    let registry = Registry::new_with_builtins();
    let prefs = prefs_store.load();
    for tpl_cfg in &prefs.custom_templates {
        if let Ok(rt) = prefs::store::compile_custom_template(tpl_cfg) {
            registry.add(parser::registry::Tpl::Regex(rt));
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionState::default())
        .manage(registry)
        .manage(prefs_store)
        .invoke_handler(tauri::generate_handler![
            commands::cmd_open_file,
            commands::cmd_query,
            commands::cmd_get_metadata,
            commands::cmd_get_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
