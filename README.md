# Log Viewer

桌面 GUI 日志查看与分析工具（Tauri + React + TypeScript）。

## 当前状态：Plan 2b + Export + Style v3 + Saved Filters + Shortcuts + Detail Nav + Overnight (13 features) 已完成

**最新视觉规范**：统一 28px 控件高度、Linear/Notion 风格、StatsPanel 瘦身、level 计数下沉到 footer。

**核心能力**：
- 7 种内置解析模板（JSON Lines / bracket-electron / bracket-common / python-default / nginx-combined / logfmt / rfc3339-bracket）+ 自动嗅探 + 自定义模板（管理对话框 + 持久化）
- JSON Lines 容忍 grep/tail 多文件拼接产生的前缀（`filename.log:{...}`）
- Level 数字格式自动识别：winston/bunyan/pino（10/20/30/40/50）+ ×16 步进（0/16/32/48/64）
- **Raw 模式 fallback**：嗅探完全 NoMatch 时表格塌成 "行号 + 原始内容" 单列，不强行编造空字段
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
- **键盘快捷键**：⌘O 打开 / ⌘R 刷新 / ⌘F 聚焦搜索 / ⌘K 清空筛选 / ⌘T 跟踪 / ⌘E 导出 / ⌘S 筛选器 / ? 帮助 / Esc 关闭
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

## 已知 MVP 限制

- 文件轮转检测仅 macOS / Linux（依赖 inode）
- macOS 上 FSEvents 监听是父目录而非单文件（解决 file-granularity 不可靠的 known issue）

## 未实现

- （暂无 — README 待办已全部交付）
