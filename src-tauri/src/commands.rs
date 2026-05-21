// 占位，Phase 7 实现
#[tauri::command]
pub fn cmd_open_file(_path: String) -> Result<(), String> {
    Err("not implemented".into())
}

#[tauri::command]
pub fn cmd_query() -> Result<(), String> {
    Err("not implemented".into())
}

#[tauri::command]
pub fn cmd_get_metadata() -> Result<(), String> {
    Err("not implemented".into())
}

#[tauri::command]
pub fn cmd_get_page() -> Result<(), String> {
    Err("not implemented".into())
}
