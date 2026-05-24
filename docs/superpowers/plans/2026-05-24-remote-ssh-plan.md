# Remote SSH Log v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Lumen 能通过 SSH 看远程 Linux 服务器上的日志文件（tail -F），体验等同本地，凭据安全（passphrase 仅内存）。

**Architecture:** 后端新增 `remote/` 模块封装 `russh` 客户端 + `RemoteReader` 句柄（与 `FileWatcher` 平行），通过 `SourceReader` 枚举透明替换。`LogSource::{Local,Remote}` 抽象 + URI 形式（`file://` / `ssh://`）做 prefs key。前端 `OpenRemoteDialog` 收集凭据 + `HostKeyDialog` 做 TOFU；多窗口集成通过 `SessionStore::pending_connections` 把 secret 从 URL 路径里排除。

**Tech Stack:** russh 0.49 + russh-keys 0.49 + shell-escape 0.1（新增 Rust deps）；前端 React + zustand + Tauri invoke / listen（无新增前端 dep）。

**Spec:** [2026-05-24-remote-ssh-design.md](../specs/2026-05-24-remote-ssh-design.md)

---

## 文件结构

```
src-tauri/src/
├── error.rs                     (修改：加 4 个 ssh 相关 variant)
├── lib.rs                       (修改：注册 8 个新 cmd)
├── commands.rs                  (修改：加 8 个 cmd + emit ssh events)
├── session_store.rs             (修改：path key → String/URI；加 pending_connections)
├── session/state.rs             (修改：watcher 字段类型 FileWatcher → SourceReader)
├── prefs/store.rs               (修改：Prefs.ssh_hosts + 3 个 CRUD 方法 + URI migration)
├── model/
│   ├── mod.rs                   (修改：导出 LogSource)
│   └── source.rs                (新：LogSource enum + URI parse/format)
└── remote/                      (新模块)
    ├── mod.rs                   (导出公共类型)
    ├── known_hosts.rs           (~/.ssh/known_hosts lookup + TOFU 写入)
    ├── ssh_session.rs           (russh Client 封装：connect + auth + exec)
    └── reader.rs                (RemoteReader 句柄，与 FileWatcher 平行)

src-tauri/tests/
└── remote_ssh.rs                (新：集成测试，#[ignore]，需 docker)

src/
├── App.tsx                      (修改：监听 lv:host-key-unknown / lv:remote-disconnected；mount 时 take_pending)
├── api/
│   ├── commands.ts              (修改：导出 8 个新 invoke 封装 — 通过 re-export)
│   └── remote.ts                (新：8 个 invoke 封装)
├── components/
│   ├── OpenFileMenu.tsx         (修改：加"打开远程文件…"入口)
│   ├── OpenRemoteDialog.tsx     (新：连接表单 + 测试连接 + 连接)
│   ├── HostKeyDialog.tsx        (新：unknown host TOFU 弹窗)
│   └── SettingsDialog.tsx       (修改：加"远程" tab)
├── hooks/
│   └── usePrefsSync.ts          (修改：PrefsKind 加 ssh_hosts → noop lazy-load)
├── state/
│   └── remoteSession.ts         (新：zustand 短期 passphrase 缓存)
└── types/
    └── log.ts                   (修改：加 LogSource type + URI helper)

README.md                        (修改：新增"远程日志"章节)
```

---

## Phase 1：依赖与基础抽象

### Task 1.1：加 Cargo 依赖

**Files:** Modify `src-tauri/Cargo.toml`

- [ ] **Step 1: 添加 3 个 dep**

在 `[dependencies]` 末尾追加：

```toml
russh = "0.49"
russh-keys = "0.49"
shell-escape = "0.1"
```

- [ ] **Step 2: 编译验证依赖能 resolve**

Run: `cd src-tauri && cargo build 2>&1 | tail -10`
Expected: `Compiling russh v0.49.x` 出现且最终 `Finished` 无错误（首次可能 1-3 分钟）

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "deps(rust): add russh 0.49 + russh-keys + shell-escape"
```

### Task 1.2：LogSource enum + URI parse/format

**Files:**
- Create: `src-tauri/src/model/source.rs`
- Modify: `src-tauri/src/model/mod.rs`

- [ ] **Step 1: 写失败测试**

新建 `src-tauri/src/model/source.rs`：

```rust
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
```

- [ ] **Step 2: 导出**

在 `src-tauri/src/model/mod.rs` 末尾加：

```rust
pub mod source;
pub use source::LogSource;
```

- [ ] **Step 3: 验证测试 PASS**

Run: `cd src-tauri && cargo test --lib model::source 2>&1 | tail -5`
Expected: `test result: ok. 7 passed; 0 failed`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/model/source.rs src-tauri/src/model/mod.rs
git commit -m "feat(model): LogSource URI 抽象 (file:// / ssh://)"
```

### Task 1.3：AppError 新增 4 个 SSH variant

**Files:** Modify `src-tauri/src/error.rs`

- [ ] **Step 1: 加 variant**

在 `pub enum AppError {` 末尾、最后一个 variant 之后添加：

```rust
    #[error("未知主机指纹：{host}:{port} ({fingerprint})")]
    HostKeyUnknown { host: String, port: u16, fingerprint: String },

    #[error("主机指纹已变化：{host}:{port}（已存 {expected}，实际 {actual}）")]
    HostKeyMismatch { host: String, port: u16, expected: String, actual: String },

    #[error("SSH 认证失败：{0}")]
    SshAuthFailed(String),

    #[error("SSH 网络错误：{0}")]
    SshNetwork(String),
```

- [ ] **Step 2: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误（serde 已正确 derive，新 variant 自动序列化为 `{kind:"HostKeyUnknown", message:{...}}`）

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/error.rs
git commit -m "feat(error): AppError 加 4 个 SSH 相关 variant"
```

### Task 1.4：Prefs.ssh_hosts + URI migration

**Files:** Modify `src-tauri/src/prefs/store.rs`

- [ ] **Step 1: 加 SshHostConfig + Prefs 字段**

在 `pub struct Prefs {` 之前插入：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshHostConfig {
    pub user: String,
    pub key_path: std::path::PathBuf,
    #[serde(default)]
    pub last_path: Option<String>,
    // 注意：不存 passphrase / password — 安全红线
}
```

在 `pub struct Prefs {` 末尾（最后一个字段之后）加：

```rust
    #[serde(default)]
    pub ssh_hosts: HashMap<String, SshHostConfig>,
```

- [ ] **Step 2: 加 3 个 CRUD 方法**

在 `impl PrefsStore {` 末尾加：

```rust
    pub fn list_ssh_hosts(&self) -> HashMap<String, SshHostConfig> {
        self.load().ssh_hosts
    }

    pub fn save_ssh_host(&self, key: String, cfg: SshHostConfig) -> Result<(), AppError> {
        let mut p = self.load();
        p.ssh_hosts.insert(key, cfg);
        self.save(&p)
    }

    pub fn delete_ssh_host(&self, key: &str) -> Result<(), AppError> {
        let mut p = self.load();
        p.ssh_hosts.remove(key);
        self.save(&p)
    }
```

- [ ] **Step 3: 写迁移函数 + 测试**

在 `impl PrefsStore {` 内 `load(&self)` 函数末尾、`prefs` 返回之前，加：

```rust
        // 一次性迁移：旧裸路径 key → file:// URI
        Self::migrate_legacy_path_keys(&mut prefs);
```

在 `impl PrefsStore` 之外定义：

```rust
impl PrefsStore {
    fn migrate_legacy_path_keys(prefs: &mut Prefs) {
        // recent_files：String list，每项若不带 scheme 就加 file://
        for entry in prefs.recent_files.iter_mut() {
            if !entry.starts_with("file://") && !entry.starts_with("ssh://") {
                *entry = format!("file://{}", entry);
            }
        }
        // saved_filters / column_widths / column_visibility：HashMap<String, _> key 同样升级
        Self::migrate_keys(&mut prefs.saved_filters);
        if let Some(m) = &mut prefs.column_widths { Self::migrate_keys(m); }
        if let Some(m) = &mut prefs.column_visibility { Self::migrate_keys(m); }
    }

    fn migrate_keys<V>(map: &mut HashMap<String, V>) {
        let old_keys: Vec<String> = map.keys()
            .filter(|k| !k.starts_with("file://") && !k.starts_with("ssh://"))
            .cloned()
            .collect();
        for k in old_keys {
            if let Some(v) = map.remove(&k) {
                map.insert(format!("file://{k}"), v);
            }
        }
    }
}
```

在 `mod tests {` 里加：

```rust
    #[test]
    fn migrate_legacy_recent_files_to_file_uri() {
        let mut prefs = Prefs::default();
        prefs.recent_files = vec!["/var/log/a".into(), "file:///var/log/b".into()];
        PrefsStore::migrate_legacy_path_keys(&mut prefs);
        assert_eq!(prefs.recent_files, vec!["file:///var/log/a", "file:///var/log/b"]);
    }

    #[test]
    fn migrate_legacy_saved_filters_keys() {
        let mut prefs = Prefs::default();
        prefs.saved_filters.insert("/old/path".into(), vec![]);
        PrefsStore::migrate_legacy_path_keys(&mut prefs);
        assert!(prefs.saved_filters.contains_key("file:///old/path"));
        assert!(!prefs.saved_filters.contains_key("/old/path"));
    }

    #[test]
    fn ssh_host_crud_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = PrefsStore::at(tmp.path().join("prefs.json"));
        let cfg = SshHostConfig {
            user: "kim".into(),
            key_path: "/Users/kim/.ssh/id_ed25519".into(),
            last_path: Some("/var/log/app.log".into()),
        };
        store.save_ssh_host("prod-1:22".into(), cfg.clone()).unwrap();
        let all = store.list_ssh_hosts();
        assert_eq!(all.get("prod-1:22").unwrap().user, "kim");
        store.delete_ssh_host("prod-1:22").unwrap();
        assert!(store.list_ssh_hosts().is_empty());
    }
```

- [ ] **Step 4: 验证测试 PASS**

Run: `cd src-tauri && cargo test --lib prefs:: 2>&1 | tail -5`
Expected: 全部 PASS（包括新加的 3 个 + 已有的）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/prefs/store.rs
git commit -m "feat(prefs): ssh_hosts CRUD + 旧路径 key 自动迁移到 file:// URI"
```

### Task 1.5：前端 LogSource TS 类型 + URI helper + 测试

**Files:**
- Modify: `src/types/log.ts`
- Create: `src/types/log.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `src/types/log.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { logSourceToUri, logSourceFromUri, type LogSource } from './log';

describe('LogSource URI', () => {
  it('local roundtrip', () => {
    const s: LogSource = { kind: 'local', path: '/var/log/a.log' };
    expect(logSourceToUri(s)).toBe('file:///var/log/a.log');
    expect(logSourceFromUri('file:///var/log/a.log')).toEqual(s);
  });

  it('remote default port omitted', () => {
    const s: LogSource = { kind: 'remote', host: 'prod-1', user: 'kim', port: 22, path: '/var/log/x' };
    expect(logSourceToUri(s)).toBe('ssh://kim@prod-1/var/log/x');
    expect(logSourceFromUri('ssh://kim@prod-1/var/log/x')).toEqual(s);
  });

  it('remote non-default port', () => {
    const s: LogSource = { kind: 'remote', host: 'p', user: 'k', port: 2222, path: '/a' };
    expect(logSourceToUri(s)).toBe('ssh://k@p:2222/a');
    expect(logSourceFromUri('ssh://k@p:2222/a')).toEqual(s);
  });

  it('legacy bare path treated as local', () => {
    expect(logSourceFromUri('/var/log/old', { allowLegacyPath: true }))
      .toEqual({ kind: 'local', path: '/var/log/old' });
  });
});
```

- [ ] **Step 2: 在 `src/types/log.ts` 末尾加类型 + helper**

```ts
// === Log source (multi-source: local / remote ssh) ===

export type LogSource =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; host: string; user: string; port: number; path: string };

export function logSourceToUri(s: LogSource): string {
  if (s.kind === 'local') return `file://${s.path}`;
  const portSuffix = s.port === 22 ? '' : `:${s.port}`;
  const path = s.path.startsWith('/') ? s.path : `/${s.path}`;
  return `ssh://${s.user}@${s.host}${portSuffix}${path}`;
}

export function logSourceFromUri(
  uri: string,
  opts: { allowLegacyPath?: boolean } = {},
): LogSource {
  if (uri.startsWith('file://')) {
    return { kind: 'local', path: uri.slice('file://'.length) };
  }
  if (uri.startsWith('ssh://')) {
    const rest = uri.slice('ssh://'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) throw new Error(`ssh URI 缺路径：${uri}`);
    const userHost = rest.slice(0, slash);
    const path = rest.slice(slash);
    const at = userHost.indexOf('@');
    if (at < 0) throw new Error(`ssh URI 缺 user：${uri}`);
    const user = userHost.slice(0, at);
    const hostPort = userHost.slice(at + 1);
    const colon = hostPort.lastIndexOf(':');
    if (colon < 0) {
      return { kind: 'remote', host: hostPort, user, port: 22, path };
    }
    const portStr = hostPort.slice(colon + 1);
    const port = Number(portStr);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`ssh URI port 非法：${portStr}`);
    }
    return { kind: 'remote', host: hostPort.slice(0, colon), user, port, path };
  }
  if (opts.allowLegacyPath) {
    return { kind: 'local', path: uri };
  }
  throw new Error(`未识别的 URI scheme：${uri}`);
}

export function logSourceDisplayName(s: LogSource): string {
  const filename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
  if (s.kind === 'local') return filename(s.path);
  return `${filename(s.path)} (${s.user}@${s.host})`;
}
```

- [ ] **Step 3: 验证测试 PASS**

Run: `npx vitest run src/types/log.test.ts 2>&1 | tail -5`
Expected: `Tests 4 passed`

- [ ] **Step 4: Commit**

```bash
git add src/types/log.ts src/types/log.test.ts
git commit -m "feat(fe): LogSource TS type + URI helpers"
```

---

## Phase 2：known_hosts 模块

### Task 2.1：known_hosts loader / lookup

**Files:**
- Create: `src-tauri/src/remote/mod.rs`
- Create: `src-tauri/src/remote/known_hosts.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败测试**

新建 `src-tauri/src/remote/mod.rs`：

```rust
pub mod known_hosts;
```

新建 `src-tauri/src/remote/known_hosts.rs`：

```rust
// ~/.ssh/known_hosts 加载与 TOFU 写入。
// MVP：用 russh-keys 的 known_hosts API；不支持时降级 plaintext lookup。

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
    dirs::home_dir()
        .map(|h| h.join(".ssh").join("known_hosts"))
        .unwrap_or_else(|| PathBuf::from(".ssh/known_hosts"))
}

/// 查 host:port 的指纹是否记录。
/// `fingerprint` 是 base64 编码的 server pubkey hash（SHA256）。
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
```

- [ ] **Step 2: 在 lib.rs 注册 remote 模块**

`src-tauri/src/lib.rs` 在 `pub mod commands;` 那行下加：

```rust
pub mod remote;
```

- [ ] **Step 3: 加 tempfile dep（dev-only）**

`src-tauri/Cargo.toml` 加：

```toml
[dev-dependencies]
tempfile = "3"
```
（若已存在则跳过。）

- [ ] **Step 4: 验证测试 PASS**

Run: `cd src-tauri && cargo test --lib remote::known_hosts 2>&1 | tail -5`
Expected: `test result: ok. 6 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/remote/ src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(remote): known_hosts lookup + TOFU append（不解析 hashed 条目）"
```

---

## Phase 3：SshSession（russh 客户端封装）

### Task 3.1：SshSession::connect 公钥认证 + 集成测试 fixture

**Files:**
- Create: `src-tauri/src/remote/ssh_session.rs`
- Modify: `src-tauri/src/remote/mod.rs`

- [ ] **Step 1: 加模块声明**

`src-tauri/src/remote/mod.rs` 末尾加：

```rust
pub mod ssh_session;
pub use ssh_session::{SshSession, SshConnectionParams, Credential};
```

- [ ] **Step 2: 写 SshSession 骨架**

新建 `src-tauri/src/remote/ssh_session.rs`：

```rust
// russh::Client 封装：负责 TCP 连接 + 认证 + 命令执行
// known_hosts 校验由调用方处理（先 InsecureNoCheck，下一 task 加）

use std::path::PathBuf;
use std::sync::Arc;
use russh::client::{self, Handle, Handler};
use russh::keys::PublicKey;
use russh::{ChannelMsg, Disconnect};
use crate::error::AppError;
use crate::remote::known_hosts::{self, KnownHostsLookup};

#[derive(Clone)]
pub struct SshConnectionParams {
    pub host: String,
    pub user: String,
    pub port: u16,
    pub credential: Credential,
}

#[derive(Clone)]
pub enum Credential {
    KeyFile { path: PathBuf, passphrase: Option<String> },
    Password(String),
}

// 屏蔽 passphrase / password 不进 Debug 输出
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Credential::KeyFile { path, .. } => f.debug_struct("KeyFile")
                .field("path", path)
                .field("passphrase", &"<redacted>")
                .finish(),
            Credential::Password(_) => f.write_str("Password(<redacted>)"),
        }
    }
}

impl std::fmt::Debug for SshConnectionParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshConnectionParams")
            .field("host", &self.host).field("user", &self.user).field("port", &self.port)
            .field("credential", &self.credential)
            .finish()
    }
}

/// known_hosts 校验策略：函数指针风格便于 mock
type KhCheck = Arc<dyn Fn(&str, u16, &PublicKey) -> Result<(), AppError> + Send + Sync>;

struct ClientHandler { kh_check: KhCheck, host: String, port: u16 }

#[async_trait::async_trait]
impl Handler for ClientHandler {
    type Error = AppError;

    async fn check_server_key(&mut self, server_public_key: &PublicKey)
        -> Result<bool, AppError>
    {
        (self.kh_check)(&self.host, self.port, server_public_key)?;
        Ok(true)
    }
}

pub struct SshSession {
    handle: Handle<ClientHandler>,
}

impl SshSession {
    pub async fn connect(
        params: &SshConnectionParams,
        kh_check: KhCheck,
    ) -> Result<Self, AppError> {
        let config = Arc::new(client::Config::default());
        let handler = ClientHandler {
            kh_check, host: params.host.clone(), port: params.port,
        };
        let mut handle = client::connect(config, (params.host.as_str(), params.port), handler)
            .await
            .map_err(|e| AppError::SshNetwork(format!("connect 失败：{e}")))?;

        match &params.credential {
            Credential::KeyFile { path, passphrase } => {
                let key = russh::keys::load_secret_key(path, passphrase.as_deref())
                    .map_err(|e| AppError::SshAuthFailed(format!("加载密钥 {} 失败：{e}", path.display())))?;
                let auth = handle.authenticate_publickey(
                    &params.user,
                    russh::keys::PrivateKeyWithHashAlg::new(
                        Arc::new(key),
                        handle.best_supported_rsa_hash().await.ok().flatten(),
                    ),
                ).await.map_err(|e| AppError::SshAuthFailed(format!("publickey 失败：{e}")))?;
                if !auth.success() {
                    return Err(AppError::SshAuthFailed("publickey 被拒绝".into()));
                }
            }
            Credential::Password(p) => {
                let auth = handle.authenticate_password(&params.user, p).await
                    .map_err(|e| AppError::SshAuthFailed(format!("password 失败：{e}")))?;
                if !auth.success() {
                    return Err(AppError::SshAuthFailed("密码被拒绝".into()));
                }
            }
        }

        Ok(SshSession { handle })
    }

    /// 干净断开连接
    pub async fn disconnect(self) {
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "").await;
    }

    /// Borrow handle 供 exec 用
    pub(crate) fn handle(&self) -> &Handle<ClientHandler> { &self.handle }
}

/// 默认 known_hosts 检查（生产用）
pub fn default_kh_check() -> KhCheck {
    Arc::new(|host, port, pk| {
        let path = known_hosts::default_path();
        // pubkey 转 base64 字符串（known_hosts 格式）
        let fp_b64 = russh::keys::ssh_encoding::EncodePem::to_pem(pk, russh::keys::LineEnding::LF)
            .map(|s| s.lines().filter(|l| !l.starts_with("---")).collect::<String>())
            .unwrap_or_default();
        match known_hosts::lookup(&path, host, port, &fp_b64) {
            KnownHostsLookup::Match => Ok(()),
            KnownHostsLookup::Unknown => Err(AppError::HostKeyUnknown {
                host: host.into(), port, fingerprint: fp_b64,
            }),
            KnownHostsLookup::Mismatch { expected } => Err(AppError::HostKeyMismatch {
                host: host.into(), port, expected, actual: fp_b64,
            }),
        }
    })
}
```

`src-tauri/Cargo.toml` 加：

```toml
async-trait = "0.1"
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -10`
Expected: 无错误（warning 关于未使用代码可忽略）。
如果 russh API 跟 spec 写的略有出入（比如 `PrivateKeyWithHashAlg`），按编译器提示调整方法名 — 整体结构不变。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/remote/ssh_session.rs src-tauri/src/remote/mod.rs src-tauri/Cargo.toml
git commit -m "feat(remote): SshSession::connect (publickey + password) + redacted Debug"
```

### Task 3.2：SshSession::exec_tail 流式 stdout

**Files:** Modify `src-tauri/src/remote/ssh_session.rs`

- [ ] **Step 1: 加 exec_tail 方法**

在 `impl SshSession {` 内加：

```rust
    /// 跑 `tail -n {n} -F {path}`，返回一个 mpsc Receiver 流式接收 stdout chunks
    pub async fn exec_tail(
        &self,
        remote_path: &str,
        tail_lines: usize,
    ) -> Result<tokio::sync::mpsc::Receiver<TailEvent>, AppError> {
        let cmd = format!(
            "tail -n {} -F {}",
            tail_lines,
            shell_escape::unix::escape(remote_path.into()),
        );
        let mut channel = self.handle.channel_open_session().await
            .map_err(|e| AppError::SshNetwork(format!("open channel 失败：{e}")))?;
        channel.exec(true, cmd.as_bytes()).await
            .map_err(|e| AppError::SshNetwork(format!("exec 失败：{e}")))?;

        let (tx, rx) = tokio::sync::mpsc::channel(64);
        tokio::spawn(async move {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        let s = String::from_utf8_lossy(&data).to_string();
                        if tx.send(TailEvent::Chunk(s)).await.is_err() { break; }
                    }
                    Some(ChannelMsg::ExtendedData { data, ext }) if ext == 1 => {
                        // stderr — 一般是 tail 的 'has been replaced' 提示
                        let s = String::from_utf8_lossy(&data).to_string();
                        let _ = tx.send(TailEvent::Stderr(s)).await;
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        let _ = tx.send(TailEvent::Closed).await;
                        break;
                    }
                    _ => {} // 其他消息（如 ExitStatus）忽略
                }
            }
        });
        Ok(rx)
    }
```

在文件末尾加：

```rust
#[derive(Debug)]
pub enum TailEvent {
    Chunk(String),
    Stderr(String),
    Closed,
}
```

- [ ] **Step 2: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/remote/ssh_session.rs
git commit -m "feat(remote): SshSession::exec_tail 流式 stdout via mpsc"
```

### Task 3.3：SshSession::test_only 仅握手 + 认证（给 cmd_test_ssh_connection 用）

**Files:** Modify `src-tauri/src/remote/ssh_session.rs`

- [ ] **Step 1: 加 test_only**

在 `impl SshSession {` 内加（在 connect 之后）：

```rust
    /// 测试连接：完成握手 + 认证后立即 disconnect。不开 channel。
    pub async fn test_only(
        params: &SshConnectionParams,
        kh_check: KhCheck,
    ) -> Result<(), AppError> {
        let s = Self::connect(params, kh_check).await?;
        s.disconnect().await;
        Ok(())
    }
```

- [ ] **Step 2: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/remote/ssh_session.rs
git commit -m "feat(remote): SshSession::test_only 仅握手+认证"
```

---

## Phase 4：RemoteReader（与 FileWatcher 平行的句柄）

### Task 4.1：RemoteReader::start 单连接 + 回调

**Files:**
- Create: `src-tauri/src/remote/reader.rs`
- Modify: `src-tauri/src/remote/mod.rs`

- [ ] **Step 1: 加模块声明**

`src-tauri/src/remote/mod.rs` 末尾加：

```rust
pub mod reader;
pub use reader::{RemoteReader, DisconnectReason};
```

- [ ] **Step 2: 写 RemoteReader**

新建 `src-tauri/src/remote/reader.rs`：

```rust
// RemoteReader：与 FileWatcher 平行的句柄
// Drop 时停止 tokio 任务 + disconnect SSH

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::task::JoinHandle;
use crate::error::AppError;
use crate::remote::ssh_session::{SshSession, SshConnectionParams, TailEvent, default_kh_check};

pub struct RemoteReader {
    abort: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone)]
pub enum DisconnectReason {
    Network(String),
    Auth(String),
    HostKeyChanged,
    ServerClosed,
}

impl RemoteReader {
    pub fn start(
        params: SshConnectionParams,
        remote_path: String,
        tail_lines: usize,
        on_chunk: Arc<dyn Fn(String) + Send + Sync>,
        on_disconnect: Arc<dyn Fn(DisconnectReason) + Send + Sync>,
    ) -> Result<Self, AppError> {
        let abort = Arc::new(AtomicBool::new(false));
        let abort_clone = abort.clone();

        let handle = tokio::spawn(async move {
            // MVP：单次连接 — 退避重连留给 Task 4.2
            let session = match SshSession::connect(&params, default_kh_check()).await {
                Ok(s) => s,
                Err(AppError::SshAuthFailed(m)) => { on_disconnect(DisconnectReason::Auth(m)); return; }
                Err(AppError::HostKeyMismatch { .. }) => { on_disconnect(DisconnectReason::HostKeyChanged); return; }
                Err(AppError::HostKeyUnknown { .. }) => {
                    on_disconnect(DisconnectReason::Auth("未信任主机指纹".into()));
                    return;
                }
                Err(e) => { on_disconnect(DisconnectReason::Network(e.to_string())); return; }
            };

            let mut rx = match session.exec_tail(&remote_path, tail_lines).await {
                Ok(r) => r,
                Err(e) => { on_disconnect(DisconnectReason::Network(e.to_string())); return; }
            };
            loop {
                if abort_clone.load(Ordering::Relaxed) { break; }
                match rx.recv().await {
                    Some(TailEvent::Chunk(s)) => on_chunk(s),
                    Some(TailEvent::Stderr(_)) => {} // 暂忽略 / 后续可前端 emit hint
                    Some(TailEvent::Closed) | None => {
                        on_disconnect(DisconnectReason::ServerClosed);
                        break;
                    }
                }
            }
            session.disconnect().await;
        });

        Ok(RemoteReader { abort, handle: Some(handle) })
    }

    pub fn stop(&self) {
        self.abort.store(true, Ordering::Relaxed);
    }
}

impl Drop for RemoteReader {
    fn drop(&mut self) {
        self.stop();
        if let Some(h) = self.handle.take() {
            h.abort();
        }
    }
}
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/remote/reader.rs src-tauri/src/remote/mod.rs
git commit -m "feat(remote): RemoteReader 句柄（与 FileWatcher 平行，Drop 释放）"
```

### Task 4.2：RemoteReader 加退避重连

**Files:** Modify `src-tauri/src/remote/reader.rs`

- [ ] **Step 1: 把 connect+tail loop 包成可重试**

替换 `tokio::spawn(async move {` 整个块为：

```rust
        let handle = tokio::spawn(async move {
            const BACKOFF_MS: [u64; 3] = [1000, 2000, 4000];
            let mut attempt = 0usize;
            loop {
                if abort_clone.load(Ordering::Relaxed) { return; }

                let connect_result = SshSession::connect(&params, default_kh_check()).await;
                let session = match connect_result {
                    Ok(s) => { attempt = 0; s }  // 连接成功重置 backoff
                    Err(AppError::SshAuthFailed(m)) => {
                        on_disconnect(DisconnectReason::Auth(m));
                        return; // 认证失败不重试
                    }
                    Err(AppError::HostKeyMismatch { .. }) => {
                        on_disconnect(DisconnectReason::HostKeyChanged);
                        return;
                    }
                    Err(AppError::HostKeyUnknown { .. }) => {
                        on_disconnect(DisconnectReason::Auth("未信任主机指纹".into()));
                        return;
                    }
                    Err(e) => {
                        // 网络错 → 退避重试
                        if attempt >= BACKOFF_MS.len() {
                            on_disconnect(DisconnectReason::Network(format!("重连放弃：{e}")));
                            return;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_MS[attempt])).await;
                        attempt += 1;
                        continue;
                    }
                };

                let mut rx = match session.exec_tail(&remote_path, tail_lines).await {
                    Ok(r) => r,
                    Err(e) => {
                        on_disconnect(DisconnectReason::Network(e.to_string()));
                        session.disconnect().await;
                        return;
                    }
                };
                loop {
                    if abort_clone.load(Ordering::Relaxed) {
                        session.disconnect().await;
                        return;
                    }
                    match rx.recv().await {
                        Some(TailEvent::Chunk(s)) => on_chunk(s),
                        Some(TailEvent::Stderr(_)) => {}
                        Some(TailEvent::Closed) | None => break, // 内层 break → 外层重试连接
                    }
                }
                session.disconnect().await;
                // 走到这里说明 tail 流断了，外层 loop 会重新 connect（attempt 不增，因为前一次连接成功过）
            }
        });
```

- [ ] **Step 2: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/remote/reader.rs
git commit -m "feat(remote): RemoteReader 网络断开退避重连 (1s/2s/4s，认证错不重试)"
```

---

## Phase 5：SessionState / SessionStore 扩展

### Task 5.1：SourceReader enum + SessionInner.watcher 类型迁移

**Files:** Modify `src-tauri/src/session/state.rs`

- [ ] **Step 1: 在 state.rs 顶部加 SourceReader**

在 `pub struct SessionState(...)` 之前加：

```rust
pub enum SourceReader {
    File(crate::loader::watcher::FileWatcher),
    Ssh(crate::remote::RemoteReader),
}
```

- [ ] **Step 2: 改 SessionInner.watcher 字段类型**

找到 `pub watcher: Option<crate::loader::watcher::FileWatcher>,` 改为：

```rust
    pub watcher: Option<SourceReader>,
```

- [ ] **Step 3: 改 install_watcher 签名**

找到 `pub fn install_watcher(`，把 `watcher: crate::loader::watcher::FileWatcher,` 改为：

```rust
        watcher: SourceReader,
```

`inner.watcher = Some(watcher);` 一行无需改。

- [ ] **Step 4: 修复 commands.rs 的调用方**

`src-tauri/src/commands.rs` 找到 `install_watcher` 调用处（cmd_start_follow 内），把 `FileWatcher::start(...)` 的返回值包成 `SourceReader::File(...)`：

```rust
    let watcher = FileWatcher::start(path, initial, on_append, on_rotation)?;
    state.install_watcher(SourceReader::File(watcher))?;
```

文件顶部 `use crate::loader::...` 行后加：

```rust
use crate::session::state::SourceReader;
```

- [ ] **Step 5: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/session/state.rs src-tauri/src/commands.rs
git commit -m "refactor(session): watcher 字段类型 → SourceReader 枚举（透明替换）"
```

### Task 5.2：SessionStore.path_to_label key 改 String + pending_connections

**Files:** Modify `src-tauri/src/session_store.rs`

- [ ] **Step 1: 改 path_to_label key 类型**

把 `path_to_label: DashMap<PathBuf, String>,` 改为：

```rust
    path_to_label: DashMap<String, String>,  // key = LogSource::to_uri()
```

把 `register_path(&self, path: PathBuf, label: String)` 签名改为：

```rust
    pub fn register_path(&self, source_uri: String, label: String) {
```

并把内部 `self.path_to_label.insert(path, label);` 改为：

```rust
        self.path_to_label.insert(source_uri, label);
```

把 `lookup_by_path(&self, path: &Path) -> Option<String>` 签名改为：

```rust
    pub fn lookup_by_uri(&self, uri: &str) -> Option<String> {
        self.path_to_label.get(uri).map(|v| v.clone())
    }
```

`close(label)` 内部找 path_to_label 反向删除的逻辑：把按 PathBuf 删的代码改成按 String 删。如果原来代码是：

```rust
        self.path_to_label.retain(|_, v| v != label);
```

则保留即可（值匹配 label，不依赖 key 类型）。

- [ ] **Step 2: 加 pending_connections 字段**

`pub struct SessionStore {` 内加：

```rust
    pending_connections: DashMap<String, PendingConnection>,
```

`impl SessionStore { pub fn new() ... }` 内 `Self { ... }` 初始化加：

```rust
            pending_connections: DashMap::new(),
```

文件顶部 `use std::path::{Path, PathBuf};` 改为：

```rust
use std::path::PathBuf;
```

（去掉未使用的 `Path`）

文件末尾加：

```rust
use std::time::Instant;
use crate::remote::ssh_session::SshConnectionParams;

pub struct PendingConnection {
    pub params: SshConnectionParams,
    pub path: String,
    pub tail_lines: usize,
    pub created_at: Instant,
}

impl SessionStore {
    pub fn put_pending(&self, label: String, pending: PendingConnection) {
        self.pending_connections.insert(label, pending);
    }

    pub fn take_pending(&self, label: &str) -> Option<PendingConnection> {
        self.pending_connections.remove(label).map(|(_, v)| v)
    }

    /// 清理超过 5 秒未消费的 pending
    pub fn sweep_stale_pending(&self) {
        let now = Instant::now();
        self.pending_connections.retain(|_, v| now.duration_since(v.created_at).as_secs() < 5);
    }
}
```

- [ ] **Step 3: 修复 commands.rs 调用方**

`commands.rs` 找到 `register_path(path, label)` / `lookup_by_path(&path)` 调用处，全部改成传 URI 字符串。最简方案：在 cmd_open_file 里把当前 `path: String` 包成 `LogSource::Local { path }.to_uri()` 后传入。

```rust
    // 原：store.register_path(path.clone(), window.label().to_string());
    let uri = crate::model::LogSource::Local { path: PathBuf::from(&path) }.to_uri();
    store.register_path(uri, window.label().to_string());
```

```rust
    // 原：if let Some(existing) = store.lookup_by_path(Path::new(&path)) {
    let uri = crate::model::LogSource::Local { path: PathBuf::from(&path) }.to_uri();
    if let Some(existing) = store.lookup_by_uri(&uri) {
```

- [ ] **Step 4: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 5: 启动 cleanup task（在 lib.rs run() 里）**

`src-tauri/src/lib.rs` 在 `tauri::Builder::default()` 之前加：

```rust
    let session_store = std::sync::Arc::new(crate::session_store::SessionStore::new());
    {
        let s = session_store.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                s.sweep_stale_pending();
            }
        });
    }
```

把 `.manage(SessionState::default())` 那条改为（multi-window v1 已经走 SessionStore；如果不存在 `manage(SessionState::default())` 那条就跳过这一步）：

```rust
    .manage(session_store.clone())
```

- [ ] **Step 6: 编译 + 全测验证**

Run: `cd src-tauri && cargo test --lib 2>&1 | tail -5`
Expected: 所有现有测试 PASS。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/session_store.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(store): path_to_label key → URI; pending_connections 5s 自清"
```

---

## Phase 6：后端 cmd

### Task 6.1：cmd_test_ssh_connection

**Files:** Modify `src-tauri/src/commands.rs`

- [ ] **Step 1: 加 cmd**

文件末尾加：

```rust
use crate::remote::ssh_session::{SshSession, SshConnectionParams, default_kh_check};

#[tauri::command]
pub async fn cmd_test_ssh_connection(params: SshConnectionParams) -> Result<(), AppError> {
    SshSession::test_only(&params, default_kh_check()).await
}
```

注意 `SshConnectionParams` 必须 derive `Deserialize`。回到 `ssh_session.rs` 把：

```rust
#[derive(Clone)]
pub struct SshConnectionParams { ... }
```

改为：

```rust
#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct SshConnectionParams { ... }
```

`Credential` 同样：

```rust
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Credential { ... }
```

- [ ] **Step 2: 在 lib.rs invoke_handler 注册**

`src-tauri/src/lib.rs` 的 `tauri::generate_handler![ ... ]` 末尾加：

```rust
            commands::cmd_test_ssh_connection,
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/remote/ssh_session.rs src-tauri/src/lib.rs
git commit -m "feat(cmd): cmd_test_ssh_connection — 仅握手+认证"
```

### Task 6.2：cmd_open_remote_file

**Files:** Modify `src-tauri/src/commands.rs`

- [ ] **Step 1: 加 cmd**

```rust
use crate::remote::reader::{RemoteReader, DisconnectReason};
use crate::loader::incremental::IncrementalParser;
use crate::session::state::SourceReader;
use crate::parser::registry::Registry;
use tauri::Emitter;

#[tauri::command]
pub async fn cmd_open_remote_file(
    window: tauri::Window,
    app: tauri::AppHandle,
    store: tauri::State<'_, std::sync::Arc<crate::session_store::SessionStore>>,
    registry: tauri::State<'_, Registry>,
    params: SshConnectionParams,
    path: String,
    tail_lines: usize,
) -> Result<crate::model::FileMetadata, AppError> {
    // 1. 创建 session（如果已存在则复用）
    let session = store.get_or_create(window.label());

    // 2. 用 LogSource URI 做 path_to_label 索引
    let source = crate::model::LogSource::Remote {
        host: params.host.clone(), user: params.user.clone(),
        port: params.port, path: path.clone(),
    };
    let uri = source.to_uri();
    store.register_path(uri.clone(), window.label().to_string());

    // 3. metadata（远程没真 inode/size — 给占位值）
    //    注：以 src-tauri/src/model/ 下 FileMetadata 实际字段为准；
    //    若字段名 / 类型不同（如 size 是 u64 / sniff_kind 是 enum），按编译错调整。
    let metadata = crate::model::FileMetadata {
        path: uri.clone(),
        size: 0, inode: 0,
        sniff_kind: "remote".into(),
        sniff_confidence: 0.0,
    };
    session.load_with_lines(metadata.clone(), Vec::new(), Vec::new());

    // 4. 启动 RemoteReader 把 chunks 喂给 IncrementalParser
    let registry_arc = std::sync::Arc::new(registry.inner().clone());
    let tpl = registry_arc.get_default()
        .ok_or_else(|| AppError::Internal("无默认解析模板".into()))?;
    let session_for_chunk = session.clone();
    let tpl_for_chunk = tpl.clone();
    let app_for_chunk = app.clone();
    let label_for_chunk = window.label().to_string();

    let on_chunk: std::sync::Arc<dyn Fn(String) + Send + Sync> = std::sync::Arc::new(move |chunk| {
        let new_entries = session_for_chunk.feed_chunk(tpl_for_chunk.as_ref(), &chunk).unwrap_or_default();
        if !new_entries.is_empty() {
            let _ = app_for_chunk.emit_to(&label_for_chunk, "lv:tail-appended", new_entries.len());
        }
    });

    let app_for_disc = app.clone();
    let label_for_disc = window.label().to_string();
    let on_disc: std::sync::Arc<dyn Fn(DisconnectReason) + Send + Sync> = std::sync::Arc::new(move |reason| {
        let payload = match reason {
            DisconnectReason::Network(m) => ("network", m, true),
            DisconnectReason::Auth(m) => ("auth", m, false),
            DisconnectReason::HostKeyChanged => ("host-key-changed", "".into(), false),
            DisconnectReason::ServerClosed => ("server-closed", "".into(), true),
        };
        let _ = app_for_disc.emit_to(&label_for_disc, "lv:remote-disconnected",
            serde_json::json!({"reason": payload.0, "message": payload.1, "will_retry": payload.2}));
    });

    let reader = RemoteReader::start(params, path, tail_lines, on_chunk, on_disc)?;
    session.install_watcher(SourceReader::Ssh(reader))?;

    let _ = app.emit_to(window.label(), "lv:remote-connected", &uri);

    Ok(metadata)
}
```

> 注：`session.feed_chunk` 现有签名要确认接受 `&dyn ParserTemplate`，已是。

- [ ] **Step 2: 在 lib.rs 注册**

`invoke_handler![ ... ]` 加：

```rust
            commands::cmd_open_remote_file,
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误（若 `Registry` 没实现 `Clone`，则改用 `Arc<Registry>` 已是 manage 的形式拿）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(cmd): cmd_open_remote_file — 远程 tail + IncrementalParser 复用"
```

### Task 6.3：cmd_open_remote_in_new_window + cmd_take_pending_connection

**Files:** Modify `src-tauri/src/commands.rs`

- [ ] **Step 1: 加两个 cmd**

```rust
use crate::session_store::PendingConnection;
use tauri::WebviewWindowBuilder;

#[tauri::command]
pub async fn cmd_open_remote_in_new_window(
    app: tauri::AppHandle,
    store: tauri::State<'_, std::sync::Arc<crate::session_store::SessionStore>>,
    params: SshConnectionParams,
    path: String,
    tail_lines: usize,
) -> Result<(), AppError> {
    // 1. 检查同 URI 是否已有窗口 — 有则聚焦
    let source = crate::model::LogSource::Remote {
        host: params.host.clone(), user: params.user.clone(),
        port: params.port, path: path.clone(),
    };
    let uri = source.to_uri();
    if let Some(existing_label) = store.lookup_by_uri(&uri) {
        if let Some(w) = app.get_webview_window(&existing_label) {
            let _ = w.set_focus();
            return Ok(());
        }
    }

    // 2. 创建新 label + 缓存 pending（passphrase 留在内存里仅 5s）
    let new_label = format!("win-{}", uuid::Uuid::new_v4());
    store.put_pending(new_label.clone(), PendingConnection {
        params, path, tail_lines,
        created_at: std::time::Instant::now(),
    });

    // 3. spawn 新窗口，URL 只装 ?pending=label（无 secret）
    let url = format!("index.html?pending={new_label}");
    WebviewWindowBuilder::new(&app, &new_label,
        tauri::WebviewUrl::App(url.into()))
        .title("Lumen")
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| AppError::Internal(format!("创建窗口失败：{e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_take_pending_connection(
    window: tauri::Window,
    store: tauri::State<'_, std::sync::Arc<crate::session_store::SessionStore>>,
) -> Result<Option<PendingConnectionPayload>, AppError> {
    Ok(store.take_pending(window.label()).map(Into::into))
}

#[derive(serde::Serialize)]
pub struct PendingConnectionPayload {
    pub params: SshConnectionParams,
    pub path: String,
    pub tail_lines: usize,
}

impl From<PendingConnection> for PendingConnectionPayload {
    fn from(p: PendingConnection) -> Self {
        Self { params: p.params, path: p.path, tail_lines: p.tail_lines }
    }
}
```

`Cargo.toml` 若没 `uuid`：

```toml
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 2: lib.rs 注册**

```rust
            commands::cmd_open_remote_in_new_window,
            commands::cmd_take_pending_connection,
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(cmd): open_remote_in_new_window + take_pending — secret 不入 URL"
```

### Task 6.4：cmd_confirm_host_key

**Files:** Modify `src-tauri/src/commands.rs`

- [ ] **Step 1: 加 cmd**

```rust
use crate::remote::known_hosts;

#[tauri::command]
pub async fn cmd_confirm_host_key(
    host: String,
    port: u16,
    fingerprint: String,
    action: String, // "trust" | "session-only"
) -> Result<(), AppError> {
    if action == "trust" {
        let path = known_hosts::default_path();
        // MVP：默认 key_type ed25519；实际类型应该从原始 PublicKey 拿，但接口里只有 fingerprint
        // 简化：把 known_hosts 行格式为 'host ssh-ed25519 <b64>'（适用绝大多数现代 server）
        known_hosts::append(&path, &host, port, "ssh-ed25519", &fingerprint)?;
    }
    // "session-only" → 不做事；上层连接逻辑会在本次会话内 bypass kh_check
    Ok(())
}
```

> 注：MVP 简化处理 — 信任并保存时假设 ed25519 key type；这覆盖 90% 现代 server。Risk 已在 spec §9 列出。

- [ ] **Step 2: lib.rs 注册**

```rust
            commands::cmd_confirm_host_key,
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(cmd): cmd_confirm_host_key — TOFU 追加 known_hosts"
```

### Task 6.5：cmd_list/save/delete_ssh_host

**Files:** Modify `src-tauri/src/commands.rs`

- [ ] **Step 1: 加 3 个 cmd**

```rust
use crate::prefs::store::SshHostConfig;

#[tauri::command]
pub fn cmd_list_ssh_hosts(
    prefs_store: tauri::State<'_, crate::prefs::PrefsStore>,
) -> std::collections::HashMap<String, SshHostConfig> {
    prefs_store.list_ssh_hosts()
}

#[tauri::command]
pub fn cmd_save_ssh_host(
    app: tauri::AppHandle,
    prefs_store: tauri::State<'_, crate::prefs::PrefsStore>,
    key: String,
    cfg: SshHostConfig,
) -> Result<(), AppError> {
    prefs_store.save_ssh_host(key, cfg)?;
    let _ = app.emit("lv:prefs-changed", "ssh_hosts");
    Ok(())
}

#[tauri::command]
pub fn cmd_delete_ssh_host(
    app: tauri::AppHandle,
    prefs_store: tauri::State<'_, crate::prefs::PrefsStore>,
    key: String,
) -> Result<(), AppError> {
    prefs_store.delete_ssh_host(&key)?;
    let _ = app.emit("lv:prefs-changed", "ssh_hosts");
    Ok(())
}
```

- [ ] **Step 2: lib.rs 注册**

```rust
            commands::cmd_list_ssh_hosts,
            commands::cmd_save_ssh_host,
            commands::cmd_delete_ssh_host,
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(cmd): ssh_hosts CRUD 3 个 cmd + prefs-changed 广播"
```

---

## Phase 7：前端 API + 状态

### Task 7.1：src/api/remote.ts 8 个 invoke 封装

**Files:** Create `src/api/remote.ts`

- [ ] **Step 1: 新建文件**

```ts
// 8 个远程 SSH 相关 invoke 封装

import { invoke } from '@tauri-apps/api/core';
import type { FileMetadata } from '../types/log';

export type Credential =
  | { type: 'key_file'; path: string; passphrase: string | null }
  | { type: 'password'; password: string };

export interface SshConnectionParams {
  host: string;
  user: string;
  port: number;
  credential: Credential;
}

export interface SshHostConfig {
  user: string;
  key_path: string;
  last_path: string | null;
}

export interface PendingConnectionPayload {
  params: SshConnectionParams;
  path: string;
  tail_lines: number;
}

export async function testSshConnection(params: SshConnectionParams): Promise<void> {
  return invoke('cmd_test_ssh_connection', { params });
}

export async function openRemoteFile(
  params: SshConnectionParams, path: string, tailLines: number,
): Promise<FileMetadata> {
  return invoke('cmd_open_remote_file', { params, path, tailLines });
}

export async function openRemoteInNewWindow(
  params: SshConnectionParams, path: string, tailLines: number,
): Promise<void> {
  return invoke('cmd_open_remote_in_new_window', { params, path, tailLines });
}

export async function takePendingConnection(): Promise<PendingConnectionPayload | null> {
  return invoke('cmd_take_pending_connection');
}

export async function confirmHostKey(
  host: string, port: number, fingerprint: string, action: 'trust' | 'session-only',
): Promise<void> {
  return invoke('cmd_confirm_host_key', { host, port, fingerprint, action });
}

export async function listSshHosts(): Promise<Record<string, SshHostConfig>> {
  return invoke('cmd_list_ssh_hosts');
}

export async function saveSshHost(key: string, cfg: SshHostConfig): Promise<void> {
  return invoke('cmd_save_ssh_host', { key, cfg });
}

export async function deleteSshHost(key: string): Promise<void> {
  return invoke('cmd_delete_ssh_host', { key });
}
```

- [ ] **Step 2: tsc 验证**

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误。

- [ ] **Step 3: Commit**

```bash
git add src/api/remote.ts
git commit -m "feat(fe): src/api/remote.ts — 8 个 SSH invoke 封装"
```

### Task 7.2：src/state/remoteSession.ts（短期 passphrase 缓存）

**Files:** Create `src/state/remoteSession.ts`

- [ ] **Step 1: 新建文件**

```ts
// 短期内存：保存用户勾选"本次会话记住"的 passphrase
// 关窗 / 刷新即丢失（zustand store 在 webview 内）
// 永不持久化

import { create } from 'zustand';

interface State {
  rememberedSecrets: Map<string, string>;  // key = "host:port:user"，value = passphrase / password
  remember(hostKey: string, secret: string): void;
  recall(hostKey: string): string | undefined;
  forget(hostKey: string): void;
  clear(): void;
}

export const useRemoteSession = create<State>((set, get) => ({
  rememberedSecrets: new Map(),
  remember(hostKey, secret) {
    set((s) => {
      const next = new Map(s.rememberedSecrets);
      next.set(hostKey, secret);
      return { rememberedSecrets: next };
    });
  },
  recall(hostKey) {
    return get().rememberedSecrets.get(hostKey);
  },
  forget(hostKey) {
    set((s) => {
      const next = new Map(s.rememberedSecrets);
      next.delete(hostKey);
      return { rememberedSecrets: next };
    });
  },
  clear() { set({ rememberedSecrets: new Map() }); },
}));
```

- [ ] **Step 2: tsc 验证**

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误。

- [ ] **Step 3: Commit**

```bash
git add src/state/remoteSession.ts
git commit -m "feat(fe): remoteSession zustand — 短期 passphrase 缓存（仅内存）"
```

---

## Phase 8：前端 UI

### Task 8.1：OpenRemoteDialog 字段 + 校验

**Files:** Create `src/components/OpenRemoteDialog.tsx`

- [ ] **Step 1: 写基础结构**

```tsx
import { useState, useEffect } from 'react';
import { useRemoteSession } from '../state/remoteSession';
import { listSshHosts, type SshHostConfig, type SshConnectionParams }
  from '../api/remote';

interface Props {
  onClose: () => void;
  onSubmit: (params: SshConnectionParams, path: string, tailLines: number) => void;
  onTest: (params: SshConnectionParams) => Promise<{ ok: boolean; error?: string }>;
}

export function OpenRemoteDialog({ onClose, onSubmit, onTest }: Props) {
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [port, setPort] = useState(22);
  const [remotePath, setRemotePath] = useState('');
  const [authKind, setAuthKind] = useState<'key' | 'password'>('key');
  const [keyPath, setKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [tailLines, setTailLines] = useState(5000);
  const [testResult, setTestResult] = useState<string | null>(null);

  // 自动 prefill：host 变化时查 ssh_hosts
  useEffect(() => {
    if (!host) return;
    listSshHosts().then((hosts) => {
      const cfg = hosts[`${host}:${port}`];
      if (cfg) {
        setUser((u) => u || cfg.user);
        setKeyPath((k) => k || cfg.key_path);
        setRemotePath((p) => p || cfg.last_path || '');
      }
    });
  }, [host, port]);

  const buildParams = (): SshConnectionParams => ({
    host, user, port,
    credential: authKind === 'key'
      ? { type: 'key_file', path: keyPath, passphrase: passphrase || null }
      : { type: 'password', password },
  });

  const valid = host.trim() && user.trim() && remotePath.startsWith('/')
    && port >= 1 && port <= 65535
    && (authKind === 'key' ? keyPath.trim() : password);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
         onClick={onClose}>
      <div className="bg-white rounded shadow-xl p-5 w-[480px]" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold mb-3">打开远程日志文件 (SSH)</h3>

        <Row label="Host">
          <input className="input-ctl flex-1" value={host} onChange={(e) => setHost(e.target.value)}
                 placeholder="prod-1.example.com" autoFocus />
        </Row>
        <Row label="User / Port">
          <input className="input-ctl flex-1" value={user} onChange={(e) => setUser(e.target.value)}
                 placeholder="kim" />
          <input className="input-ctl w-20" type="number" value={port}
                 onChange={(e) => setPort(Number(e.target.value))} />
        </Row>
        <Row label="远程路径">
          <input className="input-ctl flex-1" value={remotePath}
                 onChange={(e) => setRemotePath(e.target.value)}
                 placeholder="/var/log/app.log" />
        </Row>
        <Row label="认证">
          <label className="flex items-center gap-1"><input type="radio" checked={authKind === 'key'}
                 onChange={() => setAuthKind('key')} />私钥</label>
          <label className="flex items-center gap-1"><input type="radio" checked={authKind === 'password'}
                 onChange={() => setAuthKind('password')} />密码</label>
        </Row>
        {authKind === 'key' ? (
          <>
            <Row label="私钥路径">
              <input className="input-ctl flex-1" value={keyPath}
                     onChange={(e) => setKeyPath(e.target.value)}
                     placeholder="~/.ssh/id_ed25519" />
            </Row>
            <Row label="Passphrase">
              <input className="input-ctl flex-1" type="password" value={passphrase}
                     onChange={(e) => setPassphrase(e.target.value)} />
            </Row>
          </>
        ) : (
          <Row label="密码">
            <input className="input-ctl flex-1" type="password" value={password}
                   onChange={(e) => setPassword(e.target.value)} />
          </Row>
        )}
        <Row label="初始拉取">
          <select className="select-ctl" value={tailLines}
                  onChange={(e) => setTailLines(Number(e.target.value))}>
            <option value={1000}>末尾 1000 行</option>
            <option value={5000}>末尾 5000 行</option>
            <option value={20000}>末尾 20000 行</option>
            <option value={-1}>全部</option>
          </select>
        </Row>
        <label className="block text-xs text-slate-500 mb-3 pl-20">
          <input type="checkbox" checked={remember}
                 onChange={(e) => setRemember(e.target.checked)} className="mr-1" />
          本次会话记住 passphrase / 密码
        </label>

        {testResult && (
          <div className={`text-xs px-2 py-1 rounded mb-2 ${
            testResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
          }`}>{testResult}</div>
        )}

        <div className="flex justify-between">
          <button className="ctl" disabled={!valid} onClick={async () => {
            const r = await onTest(buildParams());
            setTestResult(r.ok ? '✅ 连接成功' : `❌ ${r.error}`);
          }}>测试连接</button>
          <div className="flex gap-2">
            <button className="ctl" onClick={onClose}>取消</button>
            <button className="ctl ctl-primary" disabled={!valid} onClick={() => {
              if (remember) {
                useRemoteSession.getState().remember(
                  `${host}:${port}:${user}`,
                  authKind === 'key' ? passphrase : password,
                );
              }
              onSubmit(buildParams(), remotePath, tailLines);
            }}>连接</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <label className="text-xs text-slate-600 w-16 flex-shrink-0">{label}</label>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: tsc 验证**

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误。

- [ ] **Step 3: Commit**

```bash
git add src/components/OpenRemoteDialog.tsx
git commit -m "feat(fe): OpenRemoteDialog 表单 — 字段 + 校验 + ssh_hosts prefill"
```

### Task 8.2：在 OpenFileMenu 加"打开远程文件…"+ 连接逻辑

**Files:** Modify `src/components/OpenFileMenu.tsx`

- [ ] **Step 1: 在 OpenFileMenu 头部加 state + handler**

文件顶部 import 加：

```tsx
import { useState } from 'react';
import { OpenRemoteDialog } from './OpenRemoteDialog';
import { testSshConnection, openRemoteInNewWindow } from '../api/remote';
```

在组件 `function OpenFileMenu(...)` 顶部加：

```tsx
const [showRemote, setShowRemote] = useState(false);
```

在菜单 JSX 里 "打开文件…" 那项下方加：

```tsx
<button className="dropdown-item" onClick={() => { setOpen(false); setShowRemote(true); }}>
  🌐 打开远程文件…
</button>
```

（如果项目里没有 `dropdown-item` class，复用 "打开文件…" 同款 className。）

在组件 JSX 末尾（return 内最外层 fragment）加：

```tsx
{showRemote && (
  <OpenRemoteDialog
    onClose={() => setShowRemote(false)}
    onTest={async (params) => {
      try { await testSshConnection(params); return { ok: true }; }
      catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
    }}
    onSubmit={async (params, path, tailLines) => {
      try {
        await openRemoteInNewWindow(params, path, tailLines);
        setShowRemote(false);
      } catch (e) { console.error(e); }
    }}
  />
)}
```

- [ ] **Step 2: tsc + 跑 vitest 不破坏现有**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -5`
Expected: 0 tsc 错误，所有测试 PASS。

- [ ] **Step 3: Commit**

```bash
git add src/components/OpenFileMenu.tsx
git commit -m "feat(fe): OpenFileMenu 加「打开远程文件…」入口"
```

### Task 8.3：HostKeyDialog 组件

**Files:** Create `src/components/HostKeyDialog.tsx`

- [ ] **Step 1: 新建组件**

```tsx
import { confirmHostKey } from '../api/remote';

interface Props {
  host: string;
  port: number;
  fingerprint: string;
  onClose: () => void;
}

export function HostKeyDialog({ host, port, fingerprint, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded shadow-xl p-5 max-w-md">
        <h3 className="text-sm font-semibold text-amber-700 mb-2">⚠ 未知主机指纹</h3>
        <p className="text-xs text-slate-600 mb-2">
          <code className="bg-slate-100 px-1 rounded">{host}:{port}</code> 不在 known_hosts
        </p>
        <div className="bg-slate-50 border rounded p-2 mb-3 font-mono text-[11px] break-all">
          {fingerprint}
        </div>
        <p className="text-xs text-slate-600 mb-3">是否信任并保存？</p>
        <div className="flex gap-2 justify-end">
          <button className="ctl" onClick={onClose}>拒绝</button>
          <button className="ctl" onClick={async () => {
            await confirmHostKey(host, port, fingerprint, 'session-only');
            onClose();
          }}>仅本次</button>
          <button className="ctl ctl-primary" onClick={async () => {
            await confirmHostKey(host, port, fingerprint, 'trust');
            onClose();
          }}>信任并保存</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: tsc 验证**

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误。

- [ ] **Step 3: Commit**

```bash
git add src/components/HostKeyDialog.tsx
git commit -m "feat(fe): HostKeyDialog — TOFU unknown host 三选 (拒绝/仅本次/信任并保存)"
```

### Task 8.4：App.tsx 监听 ssh events + pending mount

**Files:** Modify `src/App.tsx`

- [ ] **Step 1: 加 listen + take_pending 逻辑**

文件顶部 import 加：

```tsx
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { takePendingConnection, openRemoteFile } from './api/remote';
import { HostKeyDialog } from './components/HostKeyDialog';
```

在 `App()` 顶部加：

```tsx
const [hostKeyDialog, setHostKeyDialog] = useState<
  { host: string; port: number; fingerprint: string } | null>(null);

useEffect(() => {
  // mount 时尝试消费 pending connection（cmd_open_remote_in_new_window 流程）
  takePendingConnection().then(async (pending) => {
    if (!pending) return;
    try {
      await openRemoteFile(pending.params, pending.path, pending.tail_lines);
    } catch (e: any) {
      // HostKeyUnknown / Mismatch 等错误以 AppError 形式抛出
      const err = e as { kind?: string; message?: any };
      if (err.kind === 'HostKeyUnknown') {
        setHostKeyDialog({
          host: err.message.host, port: err.message.port,
          fingerprint: err.message.fingerprint,
        });
      } else {
        console.error('open remote failed', e);
      }
    }
  });
}, []);

useEffect(() => {
  const unlisten = listen<{ host: string; port: number; fingerprint: string }>(
    'lv:host-key-unknown',
    ({ payload }) => setHostKeyDialog(payload)
  );
  return () => { unlisten.then((f) => f()); };
}, []);
```

在 JSX 末尾加：

```tsx
{hostKeyDialog && (
  <HostKeyDialog
    host={hostKeyDialog.host}
    port={hostKeyDialog.port}
    fingerprint={hostKeyDialog.fingerprint}
    onClose={() => setHostKeyDialog(null)}
  />
)}
```

- [ ] **Step 2: tsc + 测试**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -5`
Expected: 全 PASS。

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(fe): App.tsx 监听 host-key-unknown + mount 消费 pending connection"
```

### Task 8.5：SettingsDialog 加 "远程" tab

**Files:** Modify `src/components/SettingsDialog.tsx`

- [ ] **Step 1: 加 tab + 实现**

在 `type SettingsTab` （或类似 union 类型）加 `'remote'`。

在 SettingsDialog 的 tab 列表 JSX 渲染处加：

```tsx
<button className={tab === 'remote' ? 'tab-active' : 'tab'}
        onClick={() => setTab('remote')}>远程</button>
```

在 tab 内容 switch 处加：

```tsx
{tab === 'remote' && <RemoteSettingsTab />}
```

文件末尾加组件：

```tsx
import { useEffect, useState } from 'react';
import { listSshHosts, deleteSshHost, type SshHostConfig } from '../api/remote';

function RemoteSettingsTab() {
  const [hosts, setHosts] = useState<Record<string, SshHostConfig>>({});
  const refetch = () => listSshHosts().then(setHosts);
  useEffect(() => { refetch(); }, []);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        管理 SSH host 默认配置（user / 私钥路径）。passphrase 永不持久化。
      </p>
      <div className="border rounded divide-y">
        {Object.entries(hosts).length === 0 && (
          <div className="px-3 py-2 text-xs text-slate-400">暂无 host 配置</div>
        )}
        {Object.entries(hosts).map(([key, cfg]) => (
          <div key={key} className="px-3 py-2 flex items-center text-xs">
            <div className="flex-1">
              <div className="font-medium">{key}</div>
              <div className="text-slate-500 mt-0.5">
                {cfg.user} · {cfg.key_path}
                {cfg.last_path && <span className="ml-2 text-slate-400">↳ {cfg.last_path}</span>}
              </div>
            </div>
            <button className="ctl text-red-600" onClick={async () => {
              if (confirm(`删除 ${key} 的配置？`)) {
                await deleteSshHost(key);
                refetch();
              }
            }}>删除</button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: tsc 验证**

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误。

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsDialog.tsx
git commit -m "feat(fe): SettingsDialog 加「远程」tab — ssh_hosts 列表 + 删除"
```

---

## Phase 9：usePrefsSync 集成 ssh_hosts

### Task 9.1：PrefsKind 加 ssh_hosts → lazy-load

**Files:** Modify `src/hooks/usePrefsSync.ts`

- [ ] **Step 1: 加 case**

在 `switch (payload)` 内加：

```ts
        case 'ssh_hosts': break; // lazy-load — Settings 远程 tab 打开时重读
```

- [ ] **Step 2: tsc 验证**

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误。

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePrefsSync.ts
git commit -m "feat(fe): usePrefsSync 处理 ssh_hosts kind（lazy-load 模式）"
```

---

## Phase 10：集成测试 + 文档 + 验收

### Task 10.1：Docker openssh-server fixture + 集成测试骨架

**Files:**
- Create: `src-tauri/tests/remote_ssh.rs`
- Create: `src-tauri/tests/fixtures/docker-compose.yml`

- [ ] **Step 1: 写 docker compose fixture**

`src-tauri/tests/fixtures/docker-compose.yml`：

```yaml
version: '3'
services:
  sshd:
    image: linuxserver/openssh-server:latest
    container_name: lumen-test-sshd
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - USER_NAME=test
      - USER_PASSWORD=testpass
      - PASSWORD_ACCESS=true
    ports:
      - "12222:2222"
```

- [ ] **Step 2: 写集成测试**

新建 `src-tauri/tests/remote_ssh.rs`：

```rust
// 远程 SSH 端到端集成测试 — 需 docker，CI 跳过 (#[ignore])
// 跑前：cd src-tauri/tests/fixtures && docker compose up -d
// 跑：cargo test --test remote_ssh -- --ignored --nocapture
// 跑后：docker compose down

use log_viewer::remote::ssh_session::{SshSession, SshConnectionParams, Credential};
use std::sync::Arc;

fn local_params() -> SshConnectionParams {
    SshConnectionParams {
        host: "127.0.0.1".into(),
        user: "test".into(),
        port: 12222,
        credential: Credential::Password("testpass".into()),
    }
}

#[tokio::test]
#[ignore]
async fn connect_and_tail_local_docker() {
    let params = local_params();
    // MVP：测试时跳过 known_hosts 校验
    let no_check: Arc<dyn Fn(&str, u16, &russh::keys::PublicKey) -> Result<(), log_viewer::error::AppError> + Send + Sync>
        = Arc::new(|_, _, _| Ok(()));
    let session = SshSession::connect(&params, no_check.clone()).await
        .expect("connect 应成功");
    // 在 server 端写文件，本地读
    // ... 略：实际可 exec 'echo hello > /tmp/x' 然后 exec tail
    session.disconnect().await;
}
```

- [ ] **Step 3: 验证测试编译**

Run: `cd src-tauri && cargo test --test remote_ssh --no-run 2>&1 | tail -3`
Expected: 编译通过（即便 #[ignore] 不跑也要能编）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/remote_ssh.rs src-tauri/tests/fixtures/docker-compose.yml
git commit -m "test(remote): SSH 集成测试骨架 + docker openssh fixture (#[ignore])"
```

### Task 10.2：README 更新

**Files:** Modify `README.md`

- [ ] **Step 1: 加章节**

在现有"核心能力"列表加一项：

```markdown
- **远程日志 (SSH tail)**：通过 SSH 看远程 Linux 服务器日志文件，支持私钥 / 密码认证，known_hosts TOFU，自动退避重连
```

文件末尾"未实现"章节之前插入：

```markdown
## 远程日志（SSH tail）

通过 SSH 在 Lumen 里看远程 Linux 服务器上的日志文件，体验和本地完全一致：解析模板 / 筛选 / saved filters / 详情抽屉 / 跨页跳行全部可用。

### 入口

OpenFileMenu → **🌐 打开远程文件…** → 弹 OpenRemoteDialog 填：

| 字段 | 说明 |
|---|---|
| Host / User / Port | 22 默认；可填 IP 或域名 |
| 远程路径 | 绝对路径，例 `/var/log/nginx/access.log` |
| 认证 | 私钥 / 密码二选一 |
| 私钥路径 | 自动探测 `~/.ssh/id_ed25519` → `~/.ssh/id_rsa` → `~/.ssh/id_ecdsa` |
| Passphrase | 仅内存；勾选"本次会话记住"可缓存到关窗 |
| 初始拉取 | 末尾 1k/5k/20k/全部 行 |

### known_hosts TOFU

- 主机已在 `~/.ssh/known_hosts` → 直接连
- 未知主机 → 弹 HostKeyDialog 显示指纹 → 信任并保存 / 仅本次 / 拒绝
- 指纹变化 → 拒绝连接（安全红线，需手动改 known_hosts）

### Settings → 远程

管理 host 默认配置（user / 私钥路径 / 上次路径），下次同 host prefill。

### 已知限制（MVP）

- 不支持 ssh-agent / 1Password agent（v2）
- 不支持 ProxyJump / Bastion host（v2）
- 不支持 SFTP 远程文件树浏览（v2）
- 不支持历史反向 backfill（想看更早重连选更大 N）
- 不支持 Windows 平台
- 远程 server 假设是 Linux + GNU coreutils 的 `tail -F`
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): remote SSH 章节 + 已知限制"
```

### Task 10.3：全测试 + tsc + Production build 验证

- [ ] **Step 1: 跑全测试**

Run: `cd src-tauri && cargo test 2>&1 | grep "test result" | tail -10`
Expected: 全 PASS。

Run: `cd /Users/kimyeung/Personal\ Projects/log-viewer && npx vitest run 2>&1 | tail -5`
Expected: 全 PASS。

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: 0 错误。

- [ ] **Step 2: Production build**

Run: `npm run tauri build -- --bundles app 2>&1 | tail -15`
Expected: `Built application at: .../Lumen.app` 出现，无错误。

- [ ] **Step 3: 手动验收清单**

逐项跑：

- [ ] Mac 上开 sshd（System Preferences → Sharing → Remote Login）后用 `kim@localhost:22` + `~/Library/Logs/system.log` 测连接
- [ ] known_hosts 三种 host key 状态（首次 / 已存在 / 指纹变化）UX 都对
- [ ] 关 wifi → 看到 disconnected event → 恢复 wifi → tail 继续（重连成功）
- [ ] 同 URI 第二次"打开远程文件" → 已有窗口聚焦
- [ ] 关窗 → `lsof -i :22 | grep Lumen` 无残留 TCP 连接
- [ ] 勾选"本次会话记住" → 同窗口内再次打开同 host 不再询问 passphrase
- [ ] Settings → 远程 tab 看到 host 列表 + 删除可用
- [ ] passphrase / 密码 / 私钥内容**从不**出现在 `prefs.json`、`console.log`、Tauri devtools network panel

如清单全过，准备进入 finishing-a-development-branch。
