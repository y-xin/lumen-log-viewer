// russh::client 封装：TCP 连接 + known_hosts 校验 + 公钥/密码认证
// known_hosts 校验通过 KhCheck 闭包注入，方便 Task 8 TOFU 流程跳过

use std::path::PathBuf;
use std::sync::Arc;

use russh::client::{self, Handle, Handler};
use russh::keys::{key::PrivateKeyWithHashAlg, PublicKey, PublicKeyBase64};
use russh::Disconnect;

use crate::error::AppError;
use crate::remote::known_hosts::{self, KnownHostsLookup};

// ─── 公开类型定义 ─────────────────────────────────────────────────────────────

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct SshConnectionParams {
    pub host: String,
    pub user: String,
    pub port: u16,
    pub credential: Credential,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Credential {
    KeyFile { path: PathBuf, passphrase: Option<String> },
    Password(String),
}

// 屏蔽 passphrase / password 不进 Debug 输出（安全红线）
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Credential::KeyFile { path, .. } => f
                .debug_struct("KeyFile")
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
            .field("host", &self.host)
            .field("user", &self.user)
            .field("port", &self.port)
            .field("credential", &self.credential)
            .finish()
    }
}

// ─── known_hosts 校验策略（闭包注入） ──────────────────────────────────────────

/// known_hosts 校验回调：host、port、server pubkey → Ok(()) 或 Err(AppError)
pub type KhCheck = Arc<dyn Fn(&str, u16, &PublicKey) -> Result<(), AppError> + Send + Sync>;

// ─── russh Handler 实现 ────────────────────────────────────────────────────────

pub(crate) struct ClientHandler {
    kh_check: KhCheck,
    host: String,
    port: u16,
}

impl Handler for ClientHandler {
    type Error = AppError;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        // 捕获为 owned 值再 async move，避免借用 &mut self 跨 await
        let result = (self.kh_check)(&self.host, self.port, server_public_key);
        async move {
            result?;
            Ok(true)
        }
    }
}

// ─── SshSession ──────────────────────────────────────────────────────────────

pub struct SshSession {
    handle: Handle<ClientHandler>,
}

impl SshSession {
    /// 建立 SSH 连接并完成认证。
    /// kh_check 由调用方提供，生产使用 `default_kh_check()`；
    /// TOFU 确认后可传入 session-only 放行闭包。
    pub async fn connect(
        params: &SshConnectionParams,
        kh_check: KhCheck,
    ) -> Result<Self, AppError> {
        let config = Arc::new(client::Config::default());
        let handler = ClientHandler {
            kh_check,
            host: params.host.clone(),
            port: params.port,
        };

        let mut handle = client::connect(config, (params.host.as_str(), params.port), handler)
            .await
            .map_err(|e| AppError::SshNetwork(format!("TCP 连接失败：{e}")))?;

        // 认证
        match &params.credential {
            Credential::KeyFile { path, passphrase } => {
                let key =
                    russh::keys::load_secret_key(path, passphrase.as_deref()).map_err(|e| {
                        AppError::SshAuthFailed(format!(
                            "加载密钥 {} 失败：{e}",
                            path.display()
                        ))
                    })?;

                // 对 RSA 密钥查询服务端支持的最佳哈希算法；其他算法忽略返回值
                let hash_alg = handle
                    .best_supported_rsa_hash()
                    .await
                    .ok()
                    .flatten()
                    .flatten();

                let key_with_alg =
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);

                let auth = handle
                    .authenticate_publickey(&params.user, key_with_alg)
                    .await
                    .map_err(|e| AppError::SshAuthFailed(format!("publickey 认证失败：{e}")))?;

                if !auth.success() {
                    return Err(AppError::SshAuthFailed("服务端拒绝公钥认证".into()));
                }
            }
            Credential::Password(pw) => {
                let auth = handle
                    .authenticate_password(&params.user, pw)
                    .await
                    .map_err(|e| AppError::SshAuthFailed(format!("密码认证失败：{e}")))?;

                if !auth.success() {
                    return Err(AppError::SshAuthFailed("服务端拒绝密码认证".into()));
                }
            }
        }

        Ok(SshSession { handle })
    }

    /// 测试连接：完成握手 + 认证后立即 disconnect。不开 channel。
    /// 给 cmd_test_ssh_connection 用 — 用户在 OpenRemoteDialog 点 [测试连接] 时调
    pub async fn test_only(
        params: &SshConnectionParams,
        kh_check: KhCheck,
    ) -> Result<(), AppError> {
        let s = Self::connect(params, kh_check).await?;
        s.disconnect().await;
        Ok(())
    }

    /// 优雅断开连接（忽略错误，drop 前调用）
    pub async fn disconnect(self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "")
            .await;
    }

    /// 借出底层 Handle，Task 3.2 exec_tail 用
    #[allow(dead_code)]
    pub(crate) fn handle(&self) -> &Handle<ClientHandler> {
        &self.handle
    }

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
                    Some(russh::ChannelMsg::Data { data }) => {
                        let s = String::from_utf8_lossy(&data).to_string();
                        if tx.send(TailEvent::Chunk(s)).await.is_err() { break; }
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, ext }) if ext == 1 => {
                        // stderr — 一般是 tail 的 'has been replaced' 提示
                        let s = String::from_utf8_lossy(&data).to_string();
                        let _ = tx.send(TailEvent::Stderr(s)).await;
                    }
                    Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => {
                        let _ = tx.send(TailEvent::Closed).await;
                        break;
                    }
                    _ => {} // 其他消息（如 ExitStatus）忽略
                }
            }
        });
        Ok(rx)
    }
}

// ─── TailEvent ────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum TailEvent {
    /// 收到一段 stdout 文本
    Chunk(String),
    /// 收到 stderr（如 tail 的文件轮换提示）
    Stderr(String),
    /// 远端关闭了 channel
    Closed,
}

// ─── 生产用 known_hosts 检查 ──────────────────────────────────────────────────

/// 生产环境 known_hosts 校验：读取 ~/.ssh/known_hosts 对比 base64 指纹。
/// 未知主机 → HostKeyUnknown（由前端弹 TOFU 确认）
/// 指纹变化 → HostKeyMismatch（直接拒绝）
pub fn default_kh_check() -> KhCheck {
    Arc::new(|host, port, pk| {
        let path = known_hosts::default_path();
        // PublicKeyBase64 trait 提供 public_key_base64() 方法
        let fp_b64 = pk.public_key_base64();
        if fp_b64.is_empty() {
            return Err(AppError::Internal("无法读取服务端公钥".into()));
        }
        match known_hosts::lookup(&path, host, port, &fp_b64) {
            KnownHostsLookup::Match => Ok(()),
            KnownHostsLookup::Unknown => Err(AppError::HostKeyUnknown {
                host: host.into(),
                port,
                fingerprint: fp_b64,
            }),
            KnownHostsLookup::Mismatch { expected } => Err(AppError::HostKeyMismatch {
                host: host.into(),
                port,
                expected,
                actual: fp_b64,
            }),
        }
    })
}

// ─── 单元测试 ─────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_debug_redacts_password() {
        let c = Credential::Password("s3cr3t".into());
        let s = format!("{c:?}");
        assert!(!s.contains("s3cr3t"), "密码不应出现在 Debug 输出中");
        assert!(s.contains("<redacted>"));
    }

    #[test]
    fn credential_debug_redacts_passphrase() {
        let c = Credential::KeyFile {
            path: PathBuf::from("/home/user/.ssh/id_ed25519"),
            passphrase: Some("mypass".into()),
        };
        let s = format!("{c:?}");
        assert!(!s.contains("mypass"), "passphrase 不应出现在 Debug 输出中");
        assert!(s.contains("<redacted>"));
        assert!(s.contains("id_ed25519"));
    }

    #[test]
    fn credential_debug_keyfile_no_passphrase() {
        let c = Credential::KeyFile {
            path: PathBuf::from("/id_rsa"),
            passphrase: None,
        };
        let s = format!("{c:?}");
        assert!(s.contains("<redacted>"));
    }

    #[test]
    fn params_debug_redacts_credential() {
        let p = SshConnectionParams {
            host: "example.com".into(),
            user: "admin".into(),
            port: 22,
            credential: Credential::Password("topsecret".into()),
        };
        let s = format!("{p:?}");
        assert!(!s.contains("topsecret"));
        assert!(s.contains("example.com"));
        assert!(s.contains("admin"));
    }
}
