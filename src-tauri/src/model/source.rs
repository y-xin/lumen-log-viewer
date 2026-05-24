// LogSource：日志来源抽象 — 本地路径 or 远程 SSH
// URI 形式：file:///abs/path 或 ssh://user@host[:port]/path
// 用作 prefs / session_store 的索引 key

use std::path::PathBuf;
use serde::{Serialize, Deserialize};
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LogSource {
    Local { path: PathBuf },
    Remote {
        host: String,
        user: String,
        #[serde(default = "default_ssh_port")]
        port: u16,
        path: String,
    },
}

fn default_ssh_port() -> u16 { 22 }

impl LogSource {
    /// 稳定字符串：用作 prefs key / 持久化 / 显示
    pub fn to_uri(&self) -> String {
        match self {
            LogSource::Local { path } => {
                format!("file://{}", path.display())
            }
            LogSource::Remote { host, user, port, path } => {
                if *port == 22 {
                    format!("ssh://{}@{}{}", user, host, ensure_leading_slash(path))
                } else {
                    format!("ssh://{}@{}:{}{}", user, host, port, ensure_leading_slash(path))
                }
            }
        }
    }

    /// 反解：仅支持 file:// 和 ssh:// 两种 scheme
    pub fn from_uri(s: &str) -> Result<Self, AppError> {
        if let Some(rest) = s.strip_prefix("file://") {
            return Ok(LogSource::Local { path: PathBuf::from(rest) });
        }
        if let Some(rest) = s.strip_prefix("ssh://") {
            // user@host[:port]/path
            let (user_host, path) = rest.split_once('/')
                .ok_or_else(|| AppError::Internal(format!("ssh URI 缺路径：{s}")))?;
            let (user, host_port) = user_host.split_once('@')
                .ok_or_else(|| AppError::Internal(format!("ssh URI 缺 user：{s}")))?;
            let (host, port) = match host_port.rsplit_once(':') {
                Some((h, p)) => (h.to_string(), p.parse::<u16>()
                    .map_err(|_| AppError::Internal(format!("ssh URI port 非法：{p}")))?),
                None => (host_port.to_string(), 22u16),
            };
            return Ok(LogSource::Remote {
                host, user: user.to_string(), port,
                path: format!("/{path}"),
            });
        }
        Err(AppError::Internal(format!("未识别的 URI scheme：{s}")))
    }

    /// 兼容性：旧 prefs 里裸的绝对路径自动当作本地
    pub fn from_uri_or_legacy_path(s: &str) -> Result<Self, AppError> {
        if s.starts_with("file://") || s.starts_with("ssh://") {
            Self::from_uri(s)
        } else {
            // 旧格式：裸绝对路径 → Local
            Ok(LogSource::Local { path: PathBuf::from(s) })
        }
    }

    /// 显示用：本地是文件名；远程是 "filename (user@host)"
    pub fn display_name(&self) -> String {
        match self {
            LogSource::Local { path } => path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path.display().to_string()),
            LogSource::Remote { host, user, path, .. } => {
                let filename = std::path::Path::new(path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone());
                format!("{filename} ({user}@{host})")
            }
        }
    }
}

fn ensure_leading_slash(p: &str) -> String {
    if p.starts_with('/') { p.to_string() } else { format!("/{p}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_roundtrip() {
        let s = LogSource::Local { path: PathBuf::from("/var/log/foo.log") };
        let uri = s.to_uri();
        assert_eq!(uri, "file:///var/log/foo.log");
        assert_eq!(LogSource::from_uri(&uri).unwrap(), s);
    }

    #[test]
    fn remote_default_port_omitted() {
        let s = LogSource::Remote {
            host: "prod-1".into(), user: "kim".into(), port: 22,
            path: "/var/log/app.log".into(),
        };
        assert_eq!(s.to_uri(), "ssh://kim@prod-1/var/log/app.log");
        assert_eq!(LogSource::from_uri(&s.to_uri()).unwrap(), s);
    }

    #[test]
    fn remote_non_default_port() {
        let s = LogSource::Remote {
            host: "prod-1".into(), user: "kim".into(), port: 2222,
            path: "/var/log/app.log".into(),
        };
        assert_eq!(s.to_uri(), "ssh://kim@prod-1:2222/var/log/app.log");
        assert_eq!(LogSource::from_uri(&s.to_uri()).unwrap(), s);
    }

    #[test]
    fn legacy_bare_path_treated_as_local() {
        let s = LogSource::from_uri_or_legacy_path("/var/log/old.log").unwrap();
        assert_eq!(s, LogSource::Local { path: PathBuf::from("/var/log/old.log") });
    }

    #[test]
    fn display_name_local_is_filename() {
        let s = LogSource::Local { path: PathBuf::from("/var/log/app.log") };
        assert_eq!(s.display_name(), "app.log");
    }

    #[test]
    fn display_name_remote_includes_user_host() {
        let s = LogSource::Remote {
            host: "prod-1".into(), user: "kim".into(), port: 22,
            path: "/var/log/app.log".into(),
        };
        assert_eq!(s.display_name(), "app.log (kim@prod-1)");
    }

    #[test]
    fn from_uri_rejects_unknown_scheme() {
        assert!(LogSource::from_uri("http://x/y").is_err());
        assert!(LogSource::from_uri("ftp://x/y").is_err());
    }
}
