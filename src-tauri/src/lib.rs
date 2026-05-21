// 模块入口，公开给集成测试与 main.rs

pub mod commands;
pub mod error;
pub mod loader;
pub mod model;
pub mod parser;
pub mod query;
pub mod session;
pub mod stats;

use session::SessionState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionState::default())
        .invoke_handler(tauri::generate_handler![
            commands::cmd_open_file,
            commands::cmd_query,
            commands::cmd_get_metadata,
            commands::cmd_get_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
