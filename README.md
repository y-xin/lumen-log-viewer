# Log Viewer

桌面 GUI 日志查看与分析工具（Tauri + React + TypeScript）。

## 当前状态：Plan 2b + Export + Style v3 + Saved Filters 已完成

**最新视觉规范**：统一 28px 控件高度、Linear/Notion 风格、StatsPanel 瘦身、level 计数下沉到 footer。

**核心能力**：
- 6 种内置解析模板 + 自动嗅探 + 自定义模板（管理对话框 + 持久化）
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
- **导出筛选结果**：CSV / JSON Lines / JSON Array 三种格式，FilterBar 右侧 📥 菜单触发
- **保存筛选器**：按文件路径命名保存常用 level/scope/keyword 组合，FilterBar 右侧 📌 菜单一键调出 / 重命名 / 删除

## 开发

```bash
npm install
npm run tauri dev
```

## 测试

```bash
cd src-tauri && cargo test     # 110 lib + 9 integration tests
npm test                       # 前端 vitest
```

## 路径

- 自定义模板 + 保存的筛选器存储：`~/Library/Application Support/log-viewer/prefs.json`（macOS）

## 已知 MVP 限制

- 实时跟踪的"增量过滤"不重新跑 spec filter — 新条目无条件追加（切换 spec 会重新查询修正）
- 详情抽屉的 ↑/↓ 仅在当前已加载的 200 条页面内导航
- 文件轮转检测仅 macOS / Linux（依赖 inode）
- macOS 上 FSEvents 监听是父目录而非单文件（解决 file-granularity 不可靠的 known issue）

## 未实现

- 键盘快捷键全集（⌘O / ⌘F 等）
- 跨页详情导航
