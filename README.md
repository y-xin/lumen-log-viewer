# Lumen — 日志查看与分析

> See through your logs.

桌面 GUI 日志查看与分析工具（Tauri + React + TypeScript）。代号 `log-viewer`，发布名 **Lumen**。

## 当前状态：Plan 2b + Export + Style v3 + Saved Filters + Shortcuts + Detail Nav + Overnight + Multi-Window + Remote-SSH + Updater (16 features) 已完成

**最新视觉规范**：统一 28px 控件高度、Linear/Notion 风格、StatsPanel 瘦身、level 计数下沉到 footer。

**核心能力**：
- 7 种内置解析模板（JSON Lines / bracket-electron / bracket-common / python-default / nginx-combined / logfmt / rfc3339-bracket）+ 自动嗅探 + 自定义模板（管理对话框 + 持久化）
- JSON Lines 容忍 grep/tail 多文件拼接产生的前缀（`filename.log:{...}`）
- Level 数字格式自动识别：winston/bunyan/pino（10/20/30/40/50）+ ×16 步进（0/16/32/48/64）
- **Raw 模式 fallback**：嗅探完全 NoMatch 时表格塌成 "行号 + 原始内容" 单列，不强行编造空字段
- **关键词搜索历史**：localStorage 保留最近 10 个搜索词，输入框 datalist 提示
- **同 trace 染色**：选中含 trace_id / request_id / session_id 等字段的 entry 时，所有同值行用浅绿背景
- **桌面通知**：tail-follow 时新 ERROR 触发系统通知（窗口未聚焦才弹），头部 🔔/🔕 toggle 控制
- **自定义模板编辑 + 导入/导出 JSON**：可改写已有自定义模板；模板管理对话框顶部 ⬆⬇ 跨设备共享
- **统一设置面板（⚙ / ⌘,）**：4 tab — 通用（字号、主题）/ 颜色（主色调 + 高亮色）/ 快捷键（一览）/ 模板（管理入口）。视觉偏好走 localStorage 即时生效；dark 模式当前为实验性
- 多行 entry 自动合并（如 electron-log 尾部 JSON 跨多行）
- bracket-electron 同时支持 `[scope]` 和 `(scope)` 两种 scope 写法
- 按级别 / scope（exact/glob/regex + Top scope 多选）/ 时间区间 / 关键词筛选
- 虚拟滚动列表（按需分页 + 列宽拖动 + 跳到底部按钮）
- 总数 + level 分组 + Top scope + **时间桶 sparkline 趋势图**（堆叠 AreaChart + brush 拖选）
- **点击行打开详情抽屉**，显示 fields + raw + 快捷筛选（scope / 时间窗口 ±5min）+ Esc 关闭
- **实时跟踪（tail -f）**：notify watcher 监听追加，自动追加列表 + "↓N 条新日志" 浮动跳底
- **文件轮转/截断/删除检测**：弹窗询问重新加载
- **最近打开文件**：顶部 `▾` 下拉访问最近 10 个文件
- **拖拽打开**：拖 .log / .jsonl / .txt 文件到窗口任意位置即可打开
- **多窗口**：每次"打开文件"都是新窗口，同路径自动聚焦已有窗口；⌘N 新建空白；macOS 关到 0 留 dock（⌘Q 通过菜单真退），其他平台关到 0 退出；视觉偏好（主题 / 字号 / accent）与持久化资产（模板 / saved filters / 最近文件）跨窗实时同步
- **远程日志 (SSH tail)**：通过 SSH 看远程 Linux 服务器日志文件，支持私钥 / 密码认证，known_hosts TOFU，自动退避重连
- **App 自动升级**：启动 5s 后台检查 GitHub Releases；有新版顶部横幅提示，点击下载装 → atomic replace + 重启
- **导出筛选结果**：CSV / JSON Lines / JSON Array 三种格式，FilterBar 右侧 📥 菜单触发
- **保存筛选器**：按文件路径命名保存常用 level/scope/keyword 组合，FilterBar 右侧 📌 菜单一键调出 / 重命名 / 删除
- **键盘快捷键**：⌘O 打开 / ⌘N 新窗口 / ⌘R 刷新 / ⌘F 聚焦搜索 / ⌘K 清空筛选 / ⌘T 跟踪 / ⌘E 导出 / ⌘S 筛选器 / ? 帮助 / Esc 关闭
- **跨页详情导航 + 关键词高亮**：详情抽屉 ↑/↓ 跨全部 matched entries 跳转 + 显示 "第 X / 共 Y 条匹配"；列表行 / Message / Raw 区按 text_search 命中黄底高亮
- **多行 entry 展开/折叠**：stack trace 等多行 entry 在表格里行末显示 `▸ N`，点开看完整 raw（单条上限 10 行，更多在详情抽屉 Raw 区）
- **列宽 / 列显隐持久化**：拖动列宽 + 表头 ⚙ 菜单切换列显示，全部写 prefs.json，下次启动还原
- **日志字号 ⌘+/⌘-/⌘0**：LogList 行 + 详情抽屉 Message/Raw 字号可调（10-20px），行高同比缩放，持久化到 prefs.json
- **解析嗅探质量提示**：自动嗅探不确定时（confidence < 0.8）顶部黄/红条提示切模板
- **关键词 regex 模式**：FilterBar 关键词框旁 `.Rx` 切换，正则非法时输入框红边框（不阻塞，后端静默放行）
- **错误边界**：根级 React ErrorBoundary，崩溃后给 "尝试恢复 / 重新加载" 卡片（dev 模式带 stack trace）
- **drawer 单条复制 / 导出**：详情抽屉 Raw 区三按钮 — 复制 raw / 复制为 JSON / 导出 entry-{N}.json
- **跨页跳行 ⌘G**：弹小对话框输入文件原始行号 → LogList scrollToItem 居中
- **scope 字段任意化**：scope filter 字段名输入支持自由文本 + 常见结构化字段 datalist 补全（request_id / trace_id 等）
- **scope 值自动补全**：exact 模式下 scope 输入框 datalist 提示当前文件出现过的所有 scope
- **drawer 导航同步滚动**：抽屉 ↑/↓ 切换 entry 时 LogList 自动居中到对应行

## 开发

```bash
npm install
npm run tauri dev
```

## 测试

```bash
cd src-tauri && cargo test     # 124 lib + 9 integration tests
npm test                       # 前端 vitest
```

## 路径

- 自定义模板 + 保存的筛选器存储：`~/Library/Application Support/log-viewer/prefs.json`（macOS）

## 远程日志（SSH tail）

通过 SSH 在 Lumen 里看远程 Linux 服务器上的日志文件，体验和本地完全一致：解析模板 / 筛选 / saved filters / 详情抽屉 / 跨页跳行全部可用。

### 入口

OpenFileMenu → **🌐 打开远程文件…** → 弹 OpenRemoteDialog 填：

| 字段 | 说明 |
|---|---|
| Host / User / Port | 22 默认；可填 IP 或域名 |
| 远程路径 | 绝对路径，例 `/var/log/nginx/access.log` |
| 认证 | 私钥 / 密码二选一 |
| 私钥路径 | 默认填入 `~/.ssh/id_ed25519` |
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
- `~/.ssh/known_hosts` 中 hashed host entry 不识别（按 TOFU 流程当作 unknown 重新接受）

## 下载安装

到 [Releases](https://github.com/y-xin/lumen-log-viewer/releases) 下载对应平台：

### macOS

下载 `Lumen_x.y.z_aarch64.dmg`（Apple Silicon）或 `Lumen_x.y.z_x64.dmg`（Intel）。

**首次安装**：双击 .dmg → 拖 Lumen.app 到 Applications → 双击启动会被 Gatekeeper 拦截（"无法打开，因为无法验证开发者"）。

解决：
1. **右键** Lumen.app → **打开** → 弹窗里点 **打开** —— 一次后永远 trust
2. 或终端：`xattr -d com.apple.quarantine /Applications/Lumen.app`

之后版本通过 App 内 updater 自动装无障碍。

### Windows

下载 `Lumen_x.y.z_x64-setup.exe` 或 `Lumen_x.y.z_x64_en-US.msi`。

**首次安装**：双击会被 SmartScreen 拦截（"Windows protected your PC"）。

解决：点 **More info** → **Run anyway** → 安装正常进行。

> **Windows 上的限制**：Remote SSH 功能在 Windows 上**不可用**（v2 适配），OpenFileMenu 不显示"打开远程文件"项。

## 自动升级

Lumen 启动 5s 后静默检查 GitHub Releases 有无新版：

- 有新版 → 顶部横幅 `🎉 Lumen v0.x.x 可用` + 4 按钮：
  - **看 changelog** — 弹窗显示 release notes
  - **现在更新** — 下载 → ed25519 签名校验 → atomic replace → 重启
  - **稍后** — 关闭横幅，下次启动还会出
  - **跳过此版** — 写 localStorage，直到下一个更新前不再提示

- 也可在 **Settings → 关于 → [检查更新]** 手动触发（不受"跳过此版"影响）

离线 / 网络受限时静默不报错。

## 已知 MVP 限制

- 文件轮转检测仅 macOS / Linux（依赖 inode）
- macOS 上 FSEvents 监听是父目录而非单文件（解决 file-granularity 不可靠的 known issue）

## 未实现

- （暂无 — README 待办已全部交付）

## 发布流程（开发者）

1. 更新 `CHANGELOG.md` 把 `## [Unreleased]` 重命名为 `## [x.y.z] - YYYY-MM-DD`，新建空白 `## [Unreleased]`
2. `./scripts/bump-version.sh 0.3.0` —— 同步 3 处版本号 + commit + tag
3. `git push && git push --tags` —— 触发 GitHub Actions
4. 等 Actions 跑完（约 10-15 分钟），Release 自动出
5. 现存用户 5 秒后看到 updater 横幅

### 首次发布前 setup

见 [`docs/superpowers/specs/2026-05-25-updater-design.md`](docs/superpowers/specs/2026-05-25-updater-design.md) §10 章节 —— 需配置：
- ed25519 keypair (`~/.tauri/lumen.key`)
- self-signed macOS cert 导出为 .p12
- GitHub Secrets × 5
- repo Actions 权限：Read and write
