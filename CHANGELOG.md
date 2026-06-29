# Changelog

All notable changes to Lumen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-06-29

### Added
- 详情面板支持停靠位置切换（右侧 / 底部）：挤压列表而非浮层遮挡，选择持久化到
  prefs.json 并跨窗实时同步。
- 日志列表 Message + Fields 列支持横向滚动查看：左侧 行号/时间/级别/Scope 列冻结，
  超长内容不再被截断；Message 列宽可拖拽调整。
- 详情面板复制扩展：Message、Fields（整体 / 单字段）均可一键复制，并带"已复制"反馈。

### Fixed
- 详情面板复制在 macOS 上点击无反应：navigator.clipboard 在 WKWebView 下常失败且被
  静默吞掉，改为优先 navigator.clipboard、失败回退临时 textarea + execCommand('copy')
  的可靠路径（与已恢复的原生 Edit 菜单同一条复制链路）。

## [0.3.1] - 2026-05-25

### Fixed
- "打开文件" / 启动自动打开最近 在 v0.3.0 上空白窗口的 regression：Task 1.4
  prefs migration 把 `recent_files` 升级成 `file:///abs/path` URI 形式，但前端
  OpenFileMenu / useAutoOpenRecent 仍把 URI 当 raw path 传后端 → 加载失败。
  修复加 toLocalPath helper 在调后端前解 URI 为 fs 路径。
- 最近文件下拉里若是 `ssh://` 远程项，点击会提示用户走 "打开远程文件…" 重新输入
  密码（passphrase 不持久化，无法静默重连）。
- spawn 的新窗口里 useAutoOpenRecent 不再和 URL `?path=` 流程赛跑。

## [0.3.0] - 2026-05-25

### Added
- 多窗口支持：每个文件独立窗口、同路径自动聚焦、⌘N 新窗
- 远程日志（SSH tail）：私钥 / 密码认证、known_hosts TOFU、自动退避重连
- App 自动升级检测：启动横幅 + Settings 手动检查
- Settings 加 "关于" tab：显示版本 / 构建时间 / commit

### Security
- known_hosts append/lookup 输入校验：拒绝换行 / shell metachar 注入
- TOFU "仅本次" session bypass：让 HostKeyDialog "仅本次"按钮真生效
- HostKeyUnknown 单独 emit 事件（不再被压成 Auth 错误）
- Credential Debug impl 屏蔽 passphrase / password

### Fixed
- dark 模式选中态 / chip / slider / datepicker 一致性

### Limits
- Windows 上 Remote SSH 入口隐藏（v2 适配）
- macOS .app 用 self-signed cert，首次需右键打开
- Windows .msi/.exe 不签，首次 SmartScreen 警告需 "More info → Run anyway"

## [0.1.0] - 2026-05-22
- 首个内部版本
