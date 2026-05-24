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
                    Some(TailEvent::Stderr(_)) => {} // 暂忽略，未来可前端弹 hint
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
