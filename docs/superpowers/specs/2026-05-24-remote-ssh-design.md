# Remote SSH Log v1 设计文档

- **日期**：2026-05-24
- **状态**：设计已认可，待生成实现计划
- **前置**：已实现 Multi-Window v1（per-window SessionState + URI 索引）
- **作用范围**：让 Lumen 能像看本地日志一样，看远程 Linux 服务器上的日志文件（SSH tail）

## 1. 目标

- 用户能通过 SSH 打开远程 Linux 服务器上的日志文件，体验等同本地 tail-follow
- 复用所有现有能力：解析模板、筛选、saved filters、列宽 / 字号偏好、详情抽屉、跨页跳行、导出
- 凭据流程符合 SSH 习惯：自动探测常见私钥位置；known_hosts TOFU；passphrase 仅内存
- 远程文件首次打开 = 末尾 N 行（默认 5000，可调）+ 后续 `tail -F` 跟进新增
- 多窗口下：每个远程文件一个独立窗口，同 URI 再开聚焦已有窗口

## 2. 非目标

- ❌ SFTP 远程文件树浏览（用户手动输路径）
- ❌ ssh-agent / 1Password agent 集成
- ❌ ProxyJump / Bastion / Jump host
- ❌ 历史反向 backfill（"拉更早的 N 行" prepend 到 entries）
- ❌ 多 host 聚合视图（同时跟 N 个 host 的同名文件）
- ❌ 远程文件下载 / 写入（只读 tail）
- ❌ kubectl / docker logs 类容器源（独立设计）
- ❌ Windows 平台（known_hosts 路径 / 私钥约定差异）
- ❌ 远程文件 rotation 的专门弹窗（`tail -F` 已透明处理）

## 3. URI + 数据模型

### 3.1 LogSource 抽象

```rust
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
    /// 持久化 / 显示用的稳定字符串
    pub fn to_uri(&self) -> String;
    /// 解析 `file:///abs/path` / `ssh://user@host[:port]/path`
    pub fn from_uri(s: &str) -> Result<Self, AppError>;
    /// 窗口标题 / recent 列表用：'app.log (kim@prod-1)' / 'app.log'
    pub fn display_name(&self) -> String;
}
```

**注意**：`LogSource::Remote` **不带 credential**。凭据通过单独路径传给 `cmd_open_remote_file`（passphrase 仅本次连接用，绝不进 source）；持久化 host 默认配置走 `Prefs.ssh_hosts`。

### 3.2 现有 `path: String` 字段升级

`FileMetadata` / `SessionState` / `SessionStore::path_to_label` / `Prefs.recent_files` / `Prefs.saved_filters` / `Prefs.column_widths` / `Prefs.column_visibility` —— 所有按 path 索引的地方，key 改用 `LogSource::to_uri()`。

**向后兼容迁移**：旧 prefs.json 里裸的绝对路径 `key = "/var/log/foo"` 一次性 migrate 成 `key = "file:///var/log/foo"`，启动时 `PrefsStore::load` 检测到旧格式自动转写并 save 回去。

### 3.3 Prefs 扩展

```rust
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct Prefs {
    // ...existing fields...
    /// 按 "host:port" 索引的远程 host 默认配置
    #[serde(default)]
    pub ssh_hosts: HashMap<String, SshHostConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshHostConfig {
    pub user: String,
    pub key_path: PathBuf,
    pub last_path: Option<String>,    // 上次该 host 打开的远程路径，下次 prefill
    // 不存 passphrase / password —— 安全红线
}
```

## 4. 后端 — SourceReader + russh

### 4.1 模块布局

```
src-tauri/src/remote/
├── mod.rs              // 公共类型导出
├── known_hosts.rs      // ~/.ssh/known_hosts 加载 + TOFU 决策
├── ssh_session.rs      // russh::Client 封装：连接 + 认证 + exec
└── reader.rs           // RemoteReader 句柄，与 FileWatcher 平行
```

### 4.2 SourceReader 枚举（透明替换 FileWatcher）

```rust
// src-tauri/src/session.rs（修改）
pub enum SourceReader {
    File(FileWatcher),
    Ssh(RemoteReader),
}
// SessionState.watcher 字段类型从 Option<FileWatcher> 改为 Option<SourceReader>
```

`Drop for SourceReader` 自动按变体清理：`File` → 现有 `FileWatcher::Drop`；`Ssh` → `RemoteReader::stop` → abort tokio 任务 + drop `russh::client::Handle`（触发 SSH disconnect）。

### 4.3 SshConnectionParams + Credential

```rust
pub struct SshConnectionParams {
    pub host: String,
    pub user: String,
    pub port: u16,
    pub credential: Credential,
}

pub enum Credential {
    KeyFile { path: PathBuf, passphrase: Option<String> },
    Password(String),
}
```

### 4.4 RemoteReader 接口（与 FileWatcher 完全平行）

```rust
pub struct RemoteReader {
    abort: Arc<AtomicBool>,
    _handle: tokio::task::JoinHandle<()>,
}

impl RemoteReader {
    pub fn start(
        params: SshConnectionParams,
        remote_path: String,
        tail_lines: usize,
        on_chunk: Arc<dyn Fn(String) + Send + Sync>,
        on_disconnect: Arc<dyn Fn(DisconnectReason) + Send + Sync>,
    ) -> Result<Self, AppError>;
    pub fn stop(&self);
}

pub enum DisconnectReason {
    NetworkError(String),    // 会触发自动重连
    AuthFailed(String),      // 不重连
    HostKeyChanged,          // 不重连，红线
    ServerClosed,            // 视情况
}
```

**内部 tokio 任务流程**：

1. `SshSession::connect(&params, known_host_policy)` —— russh 握手 + 认证 + known_hosts 校验
2. 拼命令：`format!("tail -n {} -F {}", tail_lines, shell_escape::unix::escape(path.into()))`
3. `session.exec(cmd)` 拿 channel
4. 循环 `channel.wait().await` → `ChannelMsg::Data { data }` → `String::from_utf8_lossy(&data).to_string()` → `on_chunk(s)`
5. EOF / 错误 → `on_disconnect(reason)`
6. `NetworkError` → 退避重连：`sleep(1s)` / `sleep(2s)` / `sleep(4s)`，3 次失败后放弃 → 最终再 `on_disconnect(reason)`

### 4.5 known_hosts 策略

每次连接时按需读 `~/.ssh/known_hosts`（用 `russh-keys::known_hosts::check_known_hosts_path`）。

| 状态 | 行为 |
|---|---|
| 命中且指纹匹配 | pass |
| 主机不在表里 | 返回 `AppError::HostKeyUnknown { host, port, fingerprint }` → 前端弹"是否信任"对话框 → 用户决定后 `cmd_confirm_host_key` → 写 `~/.ssh/known_hosts`（或仅本次跳过）→ 重试连接 |
| 主机在表里但指纹不同 | 返回 `AppError::HostKeyMismatch { expected, actual }`，**不自动覆盖**（安全红线），提示用户手动改 known_hosts |

**新增 AppError 变体（4.5 + 6.4 用到）**：

```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    // ...existing...
    #[error("未知主机指纹：{host}:{port} ({fingerprint})")]
    HostKeyUnknown { host: String, port: u16, fingerprint: String },
    #[error("主机指纹已变化：{host}:{port}（已存 {expected}，实际 {actual}）")]
    HostKeyMismatch { host: String, port: u16, expected: String, actual: String },
    #[error("SSH 认证失败：{0}")]
    SshAuthFailed(String),
    #[error("SSH 网络错误：{0}")]
    SshNetwork(String),
}
```

**hashed hostname 支持**：

OpenSSH 默认 `HashKnownHosts yes` 写入文件时 host 字段是 `|1|salt|hash` 形态。MVP 行为：
- `russh-keys::known_hosts` 若支持 hashed lookup → 直接复用
- 若不支持 → 降级为 plaintext-only 匹配，无法命中 hashed 条目时按 `HostKeyUnknown` 走 TOFU 流程（用户重新接受一次指纹，新追加条目按 hashed-or-not 看 russh-keys 写入策略）
- 已知限制记入风险表（§9）

## 5. 前端 — OpenRemoteDialog + known_hosts 弹窗

### 5.1 入口（OpenFileMenu 扩展）

```
🗂 打开文件…
🌐 打开远程文件…           ← 新增（调出 OpenRemoteDialog）
──────────────
最近：
  ~/Library/Logs/app.log
  ssh://kim@prod-1:22/var/log/nginx.log   ← URI 形式直接重连
```

点击 recent 里的 ssh URI → 打开 OpenRemoteDialog 字段 prefill（user / key / 上次 path）；需要 passphrase 重输（除非 "本次会话记住" 仍在 zustand 缓存）。

### 5.2 OpenRemoteDialog 组件

`src/components/OpenRemoteDialog.tsx`

**字段**：

| 字段 | 默认 / 探测 |
|---|---|
| Host | recent 选中时 prefill / 否则空 |
| User | `ssh_hosts[host:port].user` ?? `$USER` |
| Port | `ssh_hosts[host:port].port` ?? 22 |
| 远程路径 | `ssh_hosts[host:port].last_path` ?? 空 |
| 认证方式 | radio: 私钥 / 密码 |
| 私钥文件 | `ssh_hosts[host:port].key_path` ?? 探测顺序 `~/.ssh/id_ed25519` → `~/.ssh/id_rsa` → `~/.ssh/id_ecdsa` |
| Passphrase | 仅内存；勾选"本次会话记住"才 zustand 缓存到关窗 |
| 密码（密码认证时） | 仅内存；同上 |
| 初始拉取 | 下拉：1000 / 5000（默认）/ 20000 / 全部 |

**按钮**：

- `[测试连接]` → `cmd_test_ssh_connection(params)`：只走握手 + 认证，不打开文件。成功 → 绿条 "✅ 连接成功"；失败 → 红条具体 error（如 `Permission denied (publickey)` / `Connection refused`）
- `[取消]` / Esc → 关 dialog + 发 cancel 信号给后端中断进行中的连接
- `[连接]` → `cmd_open_remote_in_new_window(params, path, tail_lines)`（**不复用** multi-window v1 的 `cmd_open_in_new_window`，避免 secret 进 URL）。后端流程：
  1. 把 `(params, path, tail_lines)` 写入 `SessionStore::pending_connections: DashMap<window_label, PendingConnection>`
  2. 生成新 window label，URL 只装 `?source=<ssh URI 不含 secret>&pending=<label>`
  3. `WebviewWindowBuilder` spawn 新窗口
  4. 新窗口 mount 时调 `cmd_take_pending_connection(window)` 从 pending_connections 取出并消费 → 调 `cmd_open_remote_file`
  5. 消费即 remove，timeout 5s 未消费自动清理（防 pending 积压）

### 5.3 host 指纹未知确认对话框

```
┌─ 未知主机指纹 ───────────────────────┐
│ prod-1.example.com:22 不在 known_hosts │
│                                         │
│ SHA256:abcdefxxxxxxxxxxxxxxxxxxxxxx     │
│                                         │
│ 是否信任并保存？                        │
│              [拒绝] [仅本次] [信任并保存] │
└─────────────────────────────────────────┘
```

- 拒绝 → 取消连接
- 仅本次 → 跳过校验完成本次连接，不写 known_hosts
- 信任并保存 → `cmd_confirm_host_key(host, port, fingerprint, "trust")` → 追加到 `~/.ssh/known_hosts` → 自动重试连接

由前端订阅 `lv:host-key-unknown` 事件触发显示。

### 5.4 Settings "远程" tab（新增）

- 默认初始拉取行数（数字输入框，影响 OpenRemoteDialog 默认值）
- ssh_hosts 列表：每行 host:port + user + key_path + [编辑] [删除]
- 删除 host 默认配置不影响 recent_files 里的 URI

## 6. 安全 / 生命周期

### 6.1 敏感数据红线（grep-able）

| 数据 | 规则 |
|---|---|
| Passphrase / 密码 | 仅前端 React state + Rust `String` 内存；**永远不进 prefs.json / 日志 / event payload / `Debug` impl** |
| 私钥内容 | `russh-keys::load_secret_key` 加载后只存 `KeyPair` 内存；不打印不持久化 |
| Key file 路径 | 可持久化（路径不是 secret） |
| Host fingerprint | 可持久化（到 `~/.ssh/known_hosts`） |

实现要点：所有 `tracing!` / `println!` / `format!("{:?}")` / `to_string()` / `emit` 涉及 Credential 的位置都需 review。`Credential` 手动 impl `Debug` 把敏感字段输出为 `"<redacted>"`。

### 6.2 shell quoting

远程命令拼接走 `shell_escape::unix::escape`：

```rust
let cmd = format!(
    "tail -n {} -F {}",
    tail_lines,                              // usize 类型校验
    shell_escape::unix::escape(path.into()), // 用户输入路径全 escape
);
```

`tail_lines` 是 `usize`，无注入风险。`path` 里的空格 / 单引号 / `$` / 反引号都会被正确转义。

### 6.3 关窗 / 中断

- 关窗 → 多窗口 v1 已有的 `SessionStore::close(label)` 链路 → `Drop for SessionState` → `SourceReader::Drop` → 干净 disconnect SSH session
- Dialog 取消 / Esc → 后端 `cmd_test_ssh_connection` / `cmd_open_remote_file` 通过 `tokio::select!` 监听 cancel channel，能在 TCP 握手 / russh 认证中途 abort

### 6.4 重连 / 断线 UX

`DisconnectReason::NetworkError` → RemoteReader 内部退避自动重连 3 次（1s/2s/4s）→ 仍失败 emit `lv:remote-disconnected { reason, will_retry: false }` → 前端弹"重连失败" toast + FollowToggle 加 [手动重试] 按钮。

`DisconnectReason::AuthFailed` / `HostKeyChanged` → 不重试，直接发 event 弹错误。

## 7. Tauri 事件总线（新增 4 个）

| event | payload | 触发 |
|---|---|---|
| `lv:remote-connected` | `{ host, user, port }` | SSH 握手 + 认证 + tail 启动成功 |
| `lv:remote-disconnected` | `{ reason: "network"\|"auth"\|"server-closed", will_retry: bool }` | stdout EOF / 网络错 / 重连失败 |
| `lv:host-key-unknown` | `{ host, port, fingerprint }` | 首次连 unknown host |
| `lv:host-key-mismatch` | `{ host, port, expected, actual }` | 指纹变化（不重连） |

## 8. 后端 cmd 清单（新增 8 个）

```rust
/// 测试连接：只走握手 + 认证，不打开文件
cmd_test_ssh_connection(params: SshConnectionParams) -> Result<(), AppError>

/// OpenRemoteDialog [连接] 走这个：缓存 pending + spawn 新窗口
cmd_open_remote_in_new_window(
    app: AppHandle,
    store: State<'_, SessionStore>,
    params: SshConnectionParams,
    path: String,
    tail_lines: usize,
) -> Result<(), AppError>

/// 新窗口 mount 时取出 pending 连接参数（消费式 remove）
cmd_take_pending_connection(
    window: tauri::Window,
    store: State<'_, SessionStore>,
) -> Result<Option<PendingConnection>, AppError>

/// 打开远程文件（per-window，跟本地 cmd_open_file 平行）
cmd_open_remote_file(
    window: tauri::Window,
    store: State<'_, SessionStore>,
    params: SshConnectionParams,
    path: String,
    tail_lines: usize,
) -> Result<FileMetadata, AppError>

/// 用户在"未知主机"对话框点的确认动作
cmd_confirm_host_key(
    host: String,
    port: u16,
    fingerprint: String,
    action: String,  // "trust" | "session-only"
) -> Result<(), AppError>

/// ssh_hosts 默认配置 CRUD（Settings "远程" tab 用）
cmd_list_ssh_hosts() -> Vec<(String, SshHostConfig)>
cmd_save_ssh_host(key: String, cfg: SshHostConfig) -> Result<(), AppError>
cmd_delete_ssh_host(key: String) -> Result<(), AppError>
```

`PendingConnection` 内部结构：

```rust
pub struct PendingConnection {
    pub params: SshConnectionParams,
    pub path: String,
    pub tail_lines: usize,
    pub created_at: Instant,    // > 5s 未消费视作过期，由 spawn 时启动的 cleanup task 清理
}
```

`SessionStore` 新增字段：

```rust
pub struct SessionStore {
    sessions: DashMap<String, Arc<Mutex<SessionState>>>,
    path_to_label: DashMap<String, String>,      // key 改为 LogSource::to_uri()
    pending_connections: DashMap<String, PendingConnection>,  // 新增
}
```

`save_ssh_host` / `delete_ssh_host` 完成后 `emit_to_all("lv:prefs-changed", "ssh_hosts")` —— 复用 multi-window v1 的 prefs 广播机制（`PrefsKind` 加 `SshHosts`，前端 `usePrefsSync` lazy-load 处理）。

## 9. 风险与取舍

| 风险 | 评估 | 处理 |
|---|---|---|
| russh 0.49 API 演进 | 中 | 锁版本；后续升级单独 PR |
| 不集成 ssh-agent | 低（key file 自动 prefill） | v2 加 macOS / 1Password 支持 |
| 不支持 ProxyJump | 中（部分企业场景必需） | v2（russh 支持 nested channel） |
| 远程 tail 不是 GNU coreutils | 低 | spec 明示 MVP 假设；显示 stderr |
| `~/.ssh/known_hosts` hashed host 形态 | 中 | 看 russh-keys 是否原生支持；不支持则按 plaintext-only 匹配，hashed 条目走 TOFU 重新接受 |
| Pending connection 内存里短时持有 passphrase | 低（5s 自清） | 启动 cleanup task；任何 take/spawn 失败路径都立即 remove |
| Passphrase 内存停留时长 | 中 | UI 明示"本次会话记住"；不勾选时连接成功立即从 zustand 清除 |
| Tauri webview SSH dialog 风险 | 低 | 后端独立处理网络 IO；前端只做 form + event 订阅 |

## 10. 测试

### 10.1 Rust 单元

`remote/` 模块下 (6+ 个)：
- `LogSource::to_uri` ↔ `from_uri` round-trip（含 percent-encoded 路径、IPv6、port 省略）
- `LogSource::display_name` 三种 source 输出
- `shell_escape` 在含空格 / 单引号 / `$` / 反引号路径上的转义
- `known_hosts::lookup` 三态（命中 / 未命中 / 指纹不匹配）
- `Credential` 的 `Debug` impl 输出 redacted 而非真实 passphrase
- prefs migration：旧格式 `key = "/abs/path"` 自动升级为 `"file:///abs/path"`

### 10.2 Rust 集成（`tests/remote_ssh.rs`，`#[ignore]` — 需本机 docker）

- `docker compose up linuxserver/openssh-server`（fixture）
- 端到端：连接 → exec `tail -n 10 -F /tmp/x.log` → server 端 `echo foo >> /tmp/x.log` → 验证 RemoteReader 收到 chunk
- kill server → 验证 `lv:remote-disconnected` 触发 + 重连退避 3 次

### 10.3 前端 vitest

- `OpenRemoteDialog` 字段校验（host 不能空 / port 1-65535 / path 必须 `/` 开头）
- URI parser TS 端 round-trip
- 选 recent 远程 URI → dialog prefill 关键字段

### 10.4 手动验收清单

- [ ] Mac 上开 sshd（System Preferences → Sharing → Remote Login）测连接
- [ ] known_hosts 三种 host key 状态（首次 / 已存在 / 指纹变化）UX 都对
- [ ] 网络断（关 wifi）→ 看到 disconnected event + 退避重连 → 恢复 wifi → tail 继续
- [ ] 大文件（10MB log）拉末尾 5000 行延迟可接受
- [ ] 同 URI 第二次打开聚焦已有窗口
- [ ] 关窗 → 验证 SSH 进程 / TCP 连接释放（`lsof -i :22 | grep Lumen`）
- [ ] passphrase 勾选 / 不勾选"本次会话记住"行为正确
- [ ] Settings → 远程 tab 编辑 / 删除 host 默认配置同步生效

## 11. 文档改动

- `README.md` 新增章节 "远程日志（SSH tail）"
  - 入口位置 / OpenRemoteDialog 字段说明
  - 私钥探测顺序
  - known_hosts TOFU 行为
  - v2 留白列表（用户明确知道 ProxyJump / agent 没有）
- `Settings` 章节加 "远程" tab 说明
- 快捷键无新增

## 12. 依赖

```toml
# src-tauri/Cargo.toml 新增
russh = "0.49"
russh-keys = "0.49"
shell-escape = "0.1"
```

## 13. 平台支持

- macOS（Intel + Apple Silicon）— 主测平台
- Linux 桌面 — 应该 work，best-effort
- Windows — 不支持（known_hosts 路径 / 私钥位置约定差异，v2 处理）
