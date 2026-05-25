# Security

## 报告漏洞

发邮件到 `<your-email>@example.com`（**实施时替换为维护者邮箱**；如有 PGP 公钥可在此公布）。

我们承诺：
- 72 小时内确认收到
- 30 天内给出修复或 mitigation 方案
- 不会因善意安全研究起诉报告者

## Updater 密钥管理

Lumen 自动升级用 ed25519 签名做完整性校验：

- **公钥** 嵌在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` —— 可 commit，不是 secret
- **私钥** 保存在维护者本机 `~/.tauri/lumen.key` + GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` —— 永远不进 git
- **私钥泄露应急**：
  1. 立即重新生成：`npm exec -- @tauri-apps/cli signer generate -w ~/.tauri/lumen.key`
  2. 把新公钥 commit 到 `tauri.conf.json`，标记 changelog `BREAKING: updater pubkey rotated`
  3. 旧 release 的 `latest.json` 自然过期（旧公钥不再被任何已发布版本认可）
  4. 用户必须**手动重新下载**最新版（updater 链断）

## macOS Codesigning

Lumen 用 self-signed cert（本机 Keychain 生成），不经 Apple Notary 公证：
- 用户首次打开 .app 会被 Gatekeeper 拦截，需右键 → 打开 → 允许
- updater 后续 atomic replace 不再触发警告（用户已为该 cert 一次性 trust）
- 未来如有 Apple Developer 账号将切换为 Developer ID + notarization，**不影响 ed25519 updater 校验**

## Windows Codesigning

Lumen Windows .msi/.exe **不做 codesigning**：
- 用户首次跑 .msi 会被 SmartScreen 拦截，需 "More info → Run anyway"
- self-signed Windows cert 对 SmartScreen 无效（需付费 EV cert，性价比低）
