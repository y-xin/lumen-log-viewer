# Log Viewer

桌面 GUI 日志查看与分析工具（Tauri + React + TypeScript）。

## 当前状态：Plan 1 MVP

已实现：
- 打开 JSON Lines 格式日志文件
- 按级别 / scope（exact/glob/regex）/ 时间区间 / 关键词筛选
- 虚拟滚动列表（按需分页）
- 总数 + level 分组 + Top scope 统计

未实现（见 Plan 2 / 3）：
- 其他解析模板（logfmt、python、bracket、nginx）
- 自动嗅探 + 自定义模板
- 实时跟踪（tail -f）
- 时间桶趋势图
- 详情抽屉、Sidebar、保存的筛选器、最近打开文件、导出、键盘快捷键

## 开发

```bash
npm install
npm run tauri dev
```

## 测试

```bash
# Rust
cd src-tauri && cargo test

# 前端
npm test
```
