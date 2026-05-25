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
    directories::UserDirs::new()
        .map(|d| d.home_dir().join(".ssh").join("known_hosts"))
        .unwrap_or_else(|| PathBuf::from(".ssh/known_hosts"))
}

// ─── 输入校验（C1：防 known_hosts 注入） ──────────────────────────────────────

/// SSH key 类型白名单
const KEY_TYPES: &[&str] = &[
    "ssh-rsa",
    "ssh-dss",
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
];

/// host 字段校验：长度 1-253，仅允许 hostname/IPv4/IPv6 合法字符
/// 拒绝换行、空格、shell metachar — 防止伪造多行 known_hosts entry
fn validate_host(host: &str) -> Result<(), AppError> {
    if host.is_empty() || host.len() > 253 {
        return Err(AppError::Internal("host 长度非法（1-253）".into()));
    }
    if !host.bytes().all(|b| matches!(b,
        b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9'
        | b'.' | b'-' | b'_' | b':' | b'[' | b']'
    )) {
        return Err(AppError::Internal(format!("host 含非法字符：{host:?}")));
    }
    Ok(())
}

/// fingerprint 字段校验：base64 字符集 + 长度上限
fn validate_fingerprint(fp: &str) -> Result<(), AppError> {
    if fp.is_empty() || fp.len() > 1024 {
        return Err(AppError::Internal("fingerprint 长度非法（1-1024）".into()));
    }
    if !fp.bytes().all(|b| matches!(b,
        b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'+' | b'/' | b'='
    )) {
        return Err(AppError::Internal("fingerprint 含非 base64 字符".into()));
    }
    Ok(())
}

/// key_type 字段校验：白名单常见 SSH key 类型
fn validate_key_type(kt: &str) -> Result<(), AppError> {
    if !KEY_TYPES.contains(&kt) {
        return Err(AppError::Internal(format!("不支持的 key_type：{kt:?}")));
    }
    Ok(())
}

/// 查 host:port 的指纹是否记录。
/// `fingerprint` 是 base64 编码的 server pubkey hash。
pub fn lookup(path: &std::path::Path, host: &str, port: u16, fingerprint: &str) -> KnownHostsLookup {
    // 防御性校验：非法 host 直接 Unknown（防绕过 append 校验后从 lookup 走回路径）
    if validate_host(host).is_err() {
        return KnownHostsLookup::Unknown;
    }
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
    // C1：写入前严格校验所有入参，避免 known_hosts 注入
    validate_host(host)?;
    validate_fingerprint(fingerprint)?;
    validate_key_type(key_type)?;
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

    // ─── C1：注入防护测试 ──────────────────────────────────────────────

    #[test]
    fn append_rejects_newline_in_host() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("known_hosts");
        assert!(append(&path, "h\nattacker.com ssh-rsa fake", 22, "ssh-ed25519", "AAAA").is_err());
    }

    #[test]
    fn append_rejects_invalid_fingerprint_chars() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("known_hosts");
        assert!(append(&path, "h", 22, "ssh-ed25519", "fake key with spaces").is_err());
    }

    #[test]
    fn append_rejects_unknown_key_type() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("known_hosts");
        assert!(append(&path, "h", 22, "evil-type-injection\nattacker.com ssh-rsa fake", "AAAA").is_err());
    }

    #[test]
    fn append_rejects_empty_host() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("known_hosts");
        assert!(append(&path, "", 22, "ssh-ed25519", "AAAA").is_err());
    }

    #[test]
    fn append_rejects_overlong_host() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("known_hosts");
        let long = "a".repeat(254);
        assert!(append(&path, &long, 22, "ssh-ed25519", "AAAA").is_err());
    }

    #[test]
    fn append_accepts_ipv6_bracket_notation() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("known_hosts");
        // IPv6 用 [::1]:22 形式（host 字段含 : 和 [ ]）
        assert!(append(&path, "[::1]:2222", 2222, "ssh-ed25519", "AAAA").is_ok());
    }

    #[test]
    fn lookup_rejects_malicious_host() {
        // 即使 known_hosts 里有伪造记录，恶意 host 输入也直接 Unknown
        let f = fixture("evil\nattacker ssh-rsa FAKE\n");
        assert_eq!(
            lookup(f.path(), "evil\nattacker", 22, "FAKE"),
            KnownHostsLookup::Unknown
        );
    }
}
