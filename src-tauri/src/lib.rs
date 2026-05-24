// 模块入口，公开给集成测试与 main.rs

pub mod commands;
pub mod error;
pub mod export;
pub mod loader;
pub mod model;
pub mod parser;
pub mod prefs;
pub mod query;
pub mod session;
pub mod session_store;
pub mod stats;

use parser::registry::Registry;
use prefs::PrefsStore;
use session_store::SessionStore;

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
        .manage(SessionStore::new())
        .manage(registry)
        .manage(prefs_store)
        .on_window_event(|window, event| {
            use tauri::WindowEvent;
            use tauri::Manager;
            if let WindowEvent::CloseRequested { .. } = event {
                let store: tauri::State<session_store::SessionStore> = window.state();
                store.close(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::cmd_open_file,
            commands::cmd_query,
            commands::cmd_get_metadata,
            commands::cmd_get_page,
            commands::cmd_list_templates,
            commands::cmd_reparse_with_template,
            commands::cmd_save_custom_template,
            commands::cmd_delete_custom_template,
            commands::cmd_list_custom_templates,
            commands::cmd_get_custom_template,
            commands::cmd_test_template,
            commands::cmd_start_follow,
            commands::cmd_stop_follow,
            commands::cmd_list_recent_files,
            commands::cmd_clear_recent_files,
            commands::cmd_export,
            commands::cmd_list_saved_filters,
            commands::cmd_save_filter,
            commands::cmd_delete_saved_filter,
            commands::cmd_rename_saved_filter,
            commands::cmd_get_neighbor,
            commands::cmd_get_position,
            commands::cmd_get_column_widths,
            commands::cmd_save_column_widths,
            commands::cmd_get_column_visibility,
            commands::cmd_save_column_visibility,
            commands::cmd_get_font_size,
            commands::cmd_save_font_size,
            commands::cmd_get_ui_prefs,
            commands::cmd_save_ui_prefs,
            commands::cmd_open_in_new_window,
            commands::cmd_open_blank_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            {
                use tauri::RunEvent;
                match event {
                    // 关到 0 窗口时 Tauri 触发 ExitRequested — 一律拦下来留 dock
                    // 用户主动退出走 menu bar 的 Quit 项（T4.2 注册）
                    RunEvent::ExitRequested { api, .. } => {
                        api.prevent_exit();
                    }
                    // macOS dock 点击（无可见窗口时触发）→ 弹空白窗
                    RunEvent::Reopen { has_visible_windows: false, .. } => {
                        let app = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = commands::cmd_open_blank_window(app).await;
                        });
                    }
                    _ => {}
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app_handle, event); // 静默 unused warning
            }
        });
}
