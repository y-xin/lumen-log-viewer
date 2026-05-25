# Changelog

All notable changes to Lumen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
