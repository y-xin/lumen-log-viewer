# Log Viewer

桌面 GUI 日志查看与分析工具（Tauri + React + TypeScript）。

## 当前状态：Plan 2b 已完成

**核心能力**：
- 6 种内置解析模板 + 自动嗅探 + 自定义模板（管理对话框 + 持久化）
- 多行 entry 自动合并（如 electron-log 尾部 JSON 跨多行）
- bracket-electron 同时支持 `[scope]` 和 `(scope)` 两种 scope 写法
- 按级别 / scope（exact/glob/regex）/ 时间区间 / 关键词筛选
- 虚拟滚动列表（按需分页）
- 总数 + level 分组 + Top scope + **时间桶 sparkline 趋势图**（堆叠 AreaChart + brush 拖选）
- **点击行打开详情抽屉**，显示 fields + raw + 快捷筛选（scope / 时间窗口 ±5min）+ 键盘 ↑↓/Esc 导航
- **实时跟踪（tail -f）**：notify watcher 监听追加，自动追加列表 + "↓N 条新日志" 浮动跳底
- **文件轮转/截断/删除检测**：弹窗询问重新加载

## 开发

```bash
npm install
npm run tauri dev
```

## 测试

```bash
cd src-tauri && cargo test     # 89 lib + 6 integration tests
npm test                       # 前端 vitest
```

## 路径

- 自定义模板存储：`~/Library/Application Support/log-viewer/prefs.json`（macOS）

## 已知 MVP 限制

- 实时跟踪的"增量过滤"不重新跑 spec filter — 新条目无条件追加（切换 spec 会重新查询修正）
- 详情抽屉的 ↑/↓ 仅在当前已加载的 200 条页面内导航
- 文件轮转检测仅 macOS / Linux（依赖 inode）
- macOS 上 FSEvents 监听是父目录而非单文件（解决 file-granularity 不可靠的 known issue）

## 未实现（不在 Plan 2 范围内）

- 最近打开文件列表
- 保存/复用筛选器
- 导出 CSV / JSON
- 键盘快捷键全集（⌘O / ⌘F 等）
- 跨页详情导航
