// ~/.ssh/known_hosts 加载与 TOFU 写入。
// MVP：plaintext lookup；hashed host (|1|salt|hash) 当作 Unknown，走 TOFU 重新接受。

use std::path::PathBuf;
use crate::error::AppError;

#[derive(Debug, PartialEq, Eq)]
pub enum KnownHostsLookup {
    /// 主机在表里且指纹匹配
    Match,
    /// 主机不在表里 — 走 TOFU 流程
    Unknown,
    /// 主机在表里但指纹不同 — 拒绝（不自动覆盖）
    Mismatch { expected: String },
}

pub fn default_path() -> PathBuf {
    std::env::home_dir()
        .map(|h| h.join(".ssh").join("known_hosts"))
        .unwrap_or_else(|| PathBuf::from(".ssh/known_hosts"))
}

/// 查 host:port 的指纹是否记录。
/// `fingerprint` 是 base64 编码的 server pubkey hash。
pub fn lookup(path: &std::path::Path, host: &str, port: u16, fingerprint: &str) -> KnownHostsLookup {
    if !path.exists() {
        return KnownHostsLookup::Unknown;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return KnownHostsLookup::Unknown,
    };
    let host_entry = if port == 22 { host.to_string() } else { format!("[{host}]:{port}") };

    let mut found_match = None;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        // Hashed host (|1|salt|hash) 暂不解析 — 当作 Unknown
        if line.starts_with("|1|") { continue; }
        let mut parts = line.split_whitespace();
        let hosts_field = match parts.next() { Some(h) => h, None => continue };
        let _key_type = parts.next();
        let key_b64 = match parts.next() { Some(k) => k, None => continue };

        // hosts_field 可能是逗号分隔（host1,host2,[host3]:port）
        let matched = hosts_field.split(',').any(|h| h.trim() == host_entry);
        if matched {
            found_match = Some(key_b64.to_string());
            break;
        }
    }
    match found_match {
        None => KnownHostsLookup::Unknown,
        Some(stored) if stored == fingerprint => KnownHostsLookup::Match,
        Some(stored) => KnownHostsLookup::Mismatch { expected: stored },
    }
}

/// TOFU 追加：在 known_hosts 末尾加一行
pub fn append(path: &std::path::Path, host: &str, port: u16, key_type: &str, fingerprint: &str)
    -> Result<(), AppError>
{
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Io(format!("known_hosts 父目录创建失败：{e}")))?;
    }
    let host_entry = if port == 22 { host.to_string() } else { format!("[{host}]:{port}") };
    let line = format!("{host_entry} {key_type} {fingerprint}\n");
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)
        .map_err(|e| AppError::Io(format!("known_hosts 打开失败：{e}")))?;
    f.write_all(line.as_bytes())
        .map_err(|e| AppError::Io(format!("known_hosts 写入失败：{e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(content: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        write!(f, "{content}").unwrap();
        f
    }

    #[test]
    fn match_existing_default_port() {
        let f = fixture("prod-1 ssh-ed25519 AAAA-base64-key\n");
        assert_eq!(lookup(f.path(), "prod-1", 22, "AAAA-base64-key"), KnownHostsLookup::Match);
    }

    #[test]
    fn unknown_when_not_in_file() {
        let f = fixture("other ssh-ed25519 zzz\n");
        assert_eq!(lookup(f.path(), "prod-1", 22, "AAAA"), KnownHostsLookup::Unknown);
    }

    #[test]
    fn mismatch_when_fingerprint_differs() {
        let f = fixture("prod-1 ssh-ed25519 OLD-key\n");
        assert_eq!(
            lookup(f.path(), "prod-1", 22, "NEW-key"),
            KnownHostsLookup::Mismatch { expected: "OLD-key".into() }
        );
    }

    #[test]
    fn non_default_port_uses_bracket_syntax() {
        let f = fixture("[prod-1]:2222 ssh-ed25519 KEY\n");
        assert_eq!(lookup(f.path(), "prod-1", 2222, "KEY"), KnownHostsLookup::Match);
    }

    #[test]
    fn hashed_host_treated_as_unknown() {
        let f = fixture("|1|salt|hash ssh-ed25519 KEY\n");
        assert_eq!(lookup(f.path(), "prod-1", 22, "KEY"), KnownHostsLookup::Unknown);
    }

    #[test]
    fn append_creates_file_if_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested/known_hosts");
        append(&path, "h", 22, "ssh-ed25519", "AAAA").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "h ssh-ed25519 AAAA\n");
    }
}
