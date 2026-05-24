// RemoteReader：与 FileWatcher 平行的句柄
// 内部 tokio 任务持续 ssh tail；Drop 时 abort + disconnect

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
    Network(String),     // 会触发 4.2 退避重连
    Auth(String),        // 不重连
    HostKeyChanged,      // 不重连，安全红线
    ServerClosed,        // 服务端关闭（tail 进程退出）
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
                // 走到这里说明 tail 流断了（服务端 EOF），外层 loop 会重新 connect
                // attempt 不增，因为前一次连接是成功的（只是流断了，可能是 server 重启之类）
            }
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
