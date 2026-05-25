# Lumen — 日志查看与分析

> See through your logs.

[![Release](https://img.shields.io/github/v/release/y-xin/lumen-log-viewer)](https://github.com/y-xin/lumen-log-viewer/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue)

Tauri + React + TypeScript 桌面 GUI 日志工具。开发代号 `log-viewer`，发布名 **Lumen**。

---

## 下载安装

到 **[Releases](https://github.com/y-xin/lumen-log-viewer/releases)** 下载最新版。

### macOS (Apple Silicon)

下载 `Lumen_x.y.z_aarch64.dmg` → 双击 → 拖 `Lumen.app` 到 Applications。

**首次启动**会被 Gatekeeper 拦截（self-signed cert，非 Apple 公证）。解决：
- **右键** `Lumen.app` → **打开** → 弹窗里点 **打开**（一次后永久 trust）
- 或终端：`xattr -d com.apple.quarantine /Applications/Lumen.app`

之后通过 App 内 updater 升级无障碍。

### Windows (x64)

下载 `Lumen_x.y.z_x64-setup.exe` 或 `.msi`。

**首次安装**会被 SmartScreen 拦截。解决：点 **More info** → **Run anyway**。

> Windows 上 Remote SSH 功能不可用（v2 适配），OpenFileMenu 不显示"打开远程文件"项。

### macOS (Intel) / Linux

暂未提供二进制；从源码构建（见下方"开发者"）。

---

## 主要功能

### 📂 解析与筛选

- **7 种内置模板**：JSON Lines / bracket-electron / bracket-common / python-default / nginx-combined / logfmt / rfc3339-bracket — 打开文件时自动嗅探
- **自定义模板**：模板管理对话框新建 / 编辑 / 导入 / 导出 JSON
- **Raw 模式 fallback**：嗅探完全 NoMatch 时降级为"行号 + 原始内容"单列，不强行编造字段
- **多行 entry 合并**：electron-log 尾部 JSON、stack trace 等跨行 entry 自动合并
- **Level 数字格式识别**：winston/bunyan/pino (10/20/30/40/50) + ×16 步进 (0/16/32/48/64)
- **筛选**：按 level / scope (exact/glob/regex + Top scope 多选) / 时间区间 / 关键词 (可 regex 模式)
- **关键词高亮**：列表行 / Message / Raw 区命中黄底高亮 + 历史 datalist 提示
- **同 trace 染色**：选中含 trace_id / request_id / session_id 等字段时，同值行用浅绿背景

### 📊 浏览与导航

- **虚拟滚动列表**：按需分页，支持 100k+ 行流畅
- **列宽 / 列显隐持久化**：拖动列宽 + 表头 ⚙ 切换，写 prefs.json
- **详情抽屉**：点行打开，显示 fields + raw + 快捷筛选（scope / 时间窗口 ±5min）
- **跨页详情导航**：抽屉 ↑/↓ 跨全部 matched 跳转 + 同步滚动列表
- **跨页跳行 ⌘G**：输入文件原始行号 → 居中到该行
- **统计 + 趋势图**：总数 / level 分组 / Top scope / 时间桶 sparkline (堆叠 AreaChart + brush 拖选)

### 🔴 实时与远程

- **实时跟踪 (tail -f)**：notify watcher 监听追加 + "↓N 条新日志"浮动跳底
- **轮转/截断/删除检测**：弹窗询问重新加载
- **桌面通知**：tail-follow 时新 ERROR 触发系统通知（窗口未聚焦才弹）
- **远程日志 (SSH tail)**：私钥 / 密码认证、known_hosts TOFU、自动退避重连。OpenFileMenu → 🌐 打开远程文件…

### 🪟 多窗口

- 每次"打开文件"都是新窗口；同路径自动聚焦已有窗口
- ⌘N 新建空白窗口
- macOS 关到 0 窗口留 dock；其他平台关到 0 退出
- 视觉偏好 (主题 / 字号 / accent) + 持久化资产 (模板 / saved filters / 最近文件) **跨窗实时同步**

### 💾 导出与保存

- **导出筛选结果**：CSV / JSON Lines / JSON Array (FilterBar 右侧 📥)
- **保存筛选器**：按文件路径命名 level/scope/keyword 组合 (FilterBar 右侧 📌)
- **drawer 单条导出**：复制 raw / 复制为 JSON / 导出 `entry-{N}.json`

### ⚙️ 设置

统一设置面板 (⚙ / ⌘,) — 6 tab：
- **通用**：字号 (10-20px，⌘+/⌘-/⌘0 也可调) / 主题 (light/dark 实验性)
- **颜色**：主色调 + 高亮色
- **快捷键**：一览
- **模板**：管理入口
- **远程**：SSH host 默认配置 (Windows 隐藏)
- **关于**：版本 / 构建时间 / commit / 手动检查更新

### 🚀 自动升级

启动 5s 后台检查 GitHub Releases；有新版顶部横幅：

- **看 changelog** — 弹窗显示 release notes
- **现在更新** — 下载 → ed25519 签名校验 → atomic replace → 重启
- **稍后** — 关横幅，下次启动还会出
- **跳过此版** — localStorage 持久化，直到下一新版前不再提示

也可在 **Settings → 关于 → [检查更新]** 手动触发（不受跳过限制）。

---

## 键盘快捷键

| 快捷键 | 行为 |
|---|---|
| ⌘O | 打开文件 |
| ⌘N | 新建空白窗口 |
| ⌘R | 刷新当前查询 |
| ⌘F | 聚焦关键词搜索 |
| ⌘K | 清空所有筛选 |
| ⌘T | 切换实时跟踪 |
| ⌘E | 打开导出菜单 |
| ⌘S | 打开 saved-filter 菜单 |
| ⌘G | 跳到文件原始行号 |
| ⌘+ / ⌘- / ⌘0 | 日志字号 + / - / 重置 |
| ⌘, | 打开设置 |
| ↑ / ↓ | 详情抽屉打开时切上/下一条 matched |
| ? | 快捷键帮助 |
| Esc | 关闭抽屉 / 弹窗 / 帮助 |

---

## 已知限制

- **平台**：macOS aarch64 + Windows x64 已发；macOS Intel / Linux 暂需自行构建
- **文件轮转检测**仅 macOS / Linux（依赖 inode）；macOS 上 FSEvents 监听父目录而非单文件
- **Remote SSH**：仅 macOS / Linux 客户端；不支持 ssh-agent / ProxyJump / SFTP 文件树浏览 / 历史反向 backfill / hashed known_hosts entry
- **macOS .app** self-signed（非 Apple 公证），首次需右键打开；Windows .msi 不签，首次 SmartScreen 拦截

---

## 数据存储路径

| 平台 | prefs.json 路径 |
|---|---|
| macOS | `~/Library/Application Support/log-viewer/prefs.json` |
| Windows | `%APPDATA%\log-viewer\prefs.json` |
| Linux | `~/.config/log-viewer/prefs.json` |

存储：自定义模板 / saved filters / 最近文件 / 列宽列显隐 / 字号 / 主题 / SSH host 默认配置。**永远不存** passphrase / 密码 / 私钥内容。

---

## 开发者

### 开发

```bash
npm install
npm run tauri dev
```

### 测试

```bash
cd src-tauri && cargo test     # 162 lib + 12 integration tests
npx vitest run                 # 前端 25 tests
```

### 发布流程

1. 更新 `CHANGELOG.md`：把 `## [Unreleased]` 改为 `## [x.y.z] - YYYY-MM-DD`，新建空白 `## [Unreleased]`
2. `./scripts/bump-version.sh 0.x.y` — 同步 3 处版本号 + commit + tag
3. `git push && git push --tags` — 触发 GitHub Actions
4. 等 ~10-15 分钟（macOS Intel runner 可能更久），Release 自动出
5. 现存用户 5 秒后看到 updater 横幅

#### 首次发布前 setup

见 [`docs/superpowers/specs/2026-05-25-updater-design.md`](docs/superpowers/specs/2026-05-25-updater-design.md) §10 — 配置：
- ed25519 keypair (`~/.tauri/lumen.key`)
- self-signed macOS cert 导出为 .p12
- GitHub Secrets × 5（见 SECURITY.md）
- repo Actions permissions: Read and write

---

## License

MIT — 见 [LICENSE](LICENSE)。

安全相关请见 [SECURITY.md](SECURITY.md)。变更历史见 [CHANGELOG.md](CHANGELOG.md)。
