# Log Viewer

桌面 GUI 日志查看与分析工具（Tauri + React + TypeScript）。

## 当前状态：Plan 2a 已完成

已实现：
- **6 种内置解析模板**：`json-lines` / `bracket-electron` / `bracket-common` / `logfmt` / `python-default` / `nginx-combined`
- **打开文件自动嗅探**最合适的模板（confidence ≥ 0.8 自动用，0.4-0.8 建议）
- **多行 entry 自动合并**（如 electron-log 尾部 JSON 跨多行，列表显示 `#11-13` 范围行号）
- **顶部下拉手动切换模板**
- **模板管理对话框**：新建/删除自定义正则模板，"试解析"实时预览前 10 行命中率
- **自定义模板持久化** → `~/Library/Application Support/log-viewer/prefs.json`
- 按级别 / scope（exact/glob/regex）/ 时间区间 / 关键词筛选
- 虚拟滚动列表（按需分页）
- 总数 + level 分组 + Top scope 统计

未实现（见 Plan 2b / 3）：
- 实时跟踪（tail -f）
- 详情抽屉
- 时间桶趋势图（sparkline）
- 文件轮转检测
- Sidebar（最近打开文件 + 保存的筛选器）
- 导出 CSV / JSON
- 键盘快捷键

## 开发

```bash
npm install
npm run tauri dev
```

## 测试

```bash
# Rust（76 lib + 6 integration tests）
cd src-tauri && cargo test

# 前端
npm test
```
