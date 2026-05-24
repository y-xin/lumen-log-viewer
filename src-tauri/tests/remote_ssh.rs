// 远程 SSH 端到端集成测试 — 需 docker，CI 跳过 (#[ignore])
// 本地跑步骤：
//   cd src-tauri/tests/fixtures && docker compose up -d
//   cd src-tauri && cargo test --test remote_ssh -- --ignored --nocapture
//   cd src-tauri/tests/fixtures && docker compose down

use log_viewer_lib::remote::ssh_session::{SshSession, SshConnectionParams, Credential};
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
async fn connect_succeeds_against_local_docker() {
    let params = local_params();
    // 测试时跳过 known_hosts 校验
    let no_check: Arc<dyn Fn(&str, u16, &russh::keys::PublicKey)
        -> Result<(), log_viewer_lib::error::AppError> + Send + Sync>
        = Arc::new(|_, _, _| Ok(()));
    let session = SshSession::connect(&params, no_check).await
        .expect("connect 应成功");
    session.disconnect().await;
}

#[tokio::test]
#[ignore]
async fn test_only_works() {
    let params = local_params();
    let no_check: Arc<dyn Fn(&str, u16, &russh::keys::PublicKey)
        -> Result<(), log_viewer_lib::error::AppError> + Send + Sync>
        = Arc::new(|_, _, _| Ok(()));
    SshSession::test_only(&params, no_check).await
        .expect("test_only 应成功");
}
