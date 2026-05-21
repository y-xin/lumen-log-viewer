// AppError：统一错误类型，便于在 Tauri command 中序列化返回前端

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("文件 IO 错误：{0}")]
    Io(String),

    #[error("文件未打开")]
    NoSession,

    #[error("解析错误：{0}")]
    Parse(String),

    #[error("内部错误：{0}")]
    Internal(String),
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_io_error_as_tagged_json() {
        let e = AppError::Io("nope".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#"{"kind":"Io","message":"nope"}"#);
    }

    #[test]
    fn from_std_io_error_maps_to_io_variant() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "x");
        let app_err: AppError = io_err.into();
        assert!(matches!(app_err, AppError::Io(_)));
    }
}
