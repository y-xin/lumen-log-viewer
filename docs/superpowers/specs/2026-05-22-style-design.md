# 样式优化（Style v3）设计文档

- **日期**：2026-05-22
- **状态**：设计已认可，待生成实现计划
- **前置**：当前 UI 已实现于 Plan 1 / 2a / 2b / Export
- **mockup**：见 `.superpowers/brainstorm/98577-1779437043/content/full-layout-v3.html`

## 1. 目标

把当前 UI 视觉上从"功能性堆砌"收敛到 **B 风格（Linear/Notion 现代清爽）+ 紧凑控件**：
- 控件高度统一（解决"按钮高度不齐"的视觉噪声）
- 整体按钮缩小一档（用户反馈"按钮缩小一点"）
- StatsPanel 瘦身：level counts 下沉到 footer
- 圆角、字号、颜色等 token 化

## 2. 非目标

- 主题切换（暗色 / 浅色） — 仅做浅色优化
- 自定义主题颜色配置
- 字体替换 — 沿用 system / `ui-monospace`
- 重排 LogList 列（拖动列宽、列顺序已在前期实现）

## 3. Design Tokens（CSS 变量）

在 `src/index.css` 顶部追加：

```css
:root {
  /* === Surface / 边框 / 文字 === */
  --bg: #f8fafc;
  --surface: #ffffff;
  --border: #e2e8f0;
  --border-strong: #cbd5e1;
  --text: #0f172a;
  --text-2: #475569;
  --text-3: #94a3b8;
  --accent: #2563eb;
  --accent-bg: #eff6ff;

  /* === 控件尺寸系统 === */
  --h-control: 28px;       /* button / input / select / chip 统一 */
  --h-control-sm: 22px;    /* 装饰 chip（level pill / scope tag） */
  --radius: 5px;
  --radius-sm: 4px;
}
```

并加几个共享 utility class（也在 `index.css`）：

```css
/* 统一控件高度 + 边框 + 圆角 — 所有 toolbar 控件挂这一个类 */
.ctl {
  height: var(--h-control);
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  font-size: 12px;
  line-height: 1;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
.ctl:hover { background: #f1f5f9; }
.ctl-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.ctl-primary:hover { background: #1d4ed8; }

/* segment 复合按钮 */
.ctl-segment {
  height: var(--h-control);
  display: inline-flex; align-items: stretch;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  overflow: hidden;
  box-sizing: border-box;
}
.ctl-segment > button {
  padding: 0 8px; font-size: 12px; border: none;
  background: var(--surface); color: var(--text); cursor: pointer;
  border-right: 1px solid var(--border-strong);
}
.ctl-segment > button:last-child { border-right: none; }
.ctl-segment > button:hover { background: #f1f5f9; }
.ctl-segment > button.active { background: #334155; color: #fff; }

/* 等高输入 */
.input-ctl {
  height: var(--h-control); box-sizing: border-box;
  padding: 0 8px; font-size: 12px; line-height: 1;
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface); color: var(--text);
}
.input-ctl:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
}

/* 等高 select（去浏览器默认箭头） */
.select-ctl {
  height: var(--h-control); box-sizing: border-box;
  padding: 0 18px 0 6px; font-size: 11px; line-height: 1;
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 4l3 3 3-3' stroke='%2394a3b8' fill='none' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 6px center;
  appearance: none;
  cursor: pointer;
}
```

## 4. 组件改动清单

### 4.1 全局 (`src/index.css`)

- 加 tokens + utility classes（§3）
- 已有的 overscroll / user-select 规则保留

### 4.2 App.tsx（顶部 header）

| 当前 | 改后 |
|---|---|
| `<OpenFileButton />` + `<RecentFilesMenu />` 两个独立按钮 | 合并成一个 `ctl-segment`：`📂 打开 | ▾` |
| `<TemplateMenu />` 普通 button | 仍是按钮，类名换 `ctl` |
| `<FollowToggle />` 大按钮 + ON/OFF 文字 | 缩成 `follow-chip` 28px 高小 chip。开启：绿底（`#ecfdf5`）+ 绿色边框 + 脉冲绿点 + "实时跟踪" 文字。关闭：灰底（`#f8fafc`）+ 灰边框 + 灰点（无脉冲）+ 同样文字。颜色 + dot 动态足够区分两个状态。 |
| 右上显示 `path · N 行 · 模板 X` | 只显示 `path`（模板信息已在 TemplateMenu 按钮里） |

涉及的组件：`OpenFileButton.tsx`、`RecentFilesMenu.tsx`（合并为一个 `OpenFileMenu.tsx`），`TemplateMenu.tsx`、`FollowToggle.tsx`、`App.tsx`。

### 4.3 FilterBar.tsx

- 所有 button / input / select / segment 改用 `.ctl` / `.input-ctl` / `.select-ctl` / `.ctl-segment`
- 级别行右端加 `<ExportMenu />`（之前已经在了）
- 行间距从 `space-y-2` (8px) → `space-y-1` (4px)
- 行内 gap 从 `gap-2` → `gap-1.5`

### 4.4 StatsPanel.tsx

**瘦身**：去掉"总数 + level 分组"那行，只保留：
1. `<TrendSparkline />` (76px 高，不变)
2. Scope tags 一行（直接显示，省略原 `Scope：` label 前缀）

level 分组移到 LogList 的 footer（§4.5）。

### 4.5 LogList.tsx

底部 footer 从：

```tsx
<div className="px-3 py-1 text-xs text-slate-500 border-t bg-slate-50">
  匹配 {result.total_matched.toLocaleString()} 条
</div>
```

改为：

```tsx
<div className="flex items-center gap-3 px-3 py-1 text-xs border-t bg-slate-50">
  <span className="font-semibold text-slate-700">
    匹配 {result.total_matched.toLocaleString()} 条
  </span>
  {LEVELS_DISPLAY_ORDER.map((lv) => {
    const n = result.stats.level_counts[lv] ?? 0;
    if (n === 0) return null;
    return (
      <span key={lv} className={LEVEL_FOOTER_COLOR[lv]}>
        <span className="text-slate-300 mr-2">·</span>
        {lv.toUpperCase()} {n.toLocaleString()}
      </span>
    );
  })}
</div>
```

`LEVELS_DISPLAY_ORDER = ['error', 'warn', 'info', 'debug', 'trace', 'unknown']`，`LEVEL_FOOTER_COLOR` 用与现在 StatsPanel 同色 token。

### 4.6 不动的组件

- `LogList.tsx` 列宽拖动、表头、行渲染 — 已经满足 v3 mockup 风格
- `DetailDrawer.tsx` / `TemplateManagerDialog.tsx` / `RotationDialog.tsx` — 仅微调内部 button 用 `.ctl` 类名，结构不变
- `TrendSparkline.tsx` — 不变
- `ExportMenu.tsx` — 已经是 v3 风格 chip，仅确认 .ctl 替换

## 5. 影响 / 测试

- 没有后端改动 — Rust 代码不动
- `npm test` 已有的 `FilterBar.test.tsx` 主要测交互（level toggle），与样式无关，应继续通过
- 手动验收清单：见 §7

## 6. 文件清单

```
src/
├── index.css                            (修改：加 tokens + utility classes)
├── App.tsx                              (修改：header 重组，合并 Open + RecentFiles)
├── components/
│   ├── OpenFileButton.tsx               (删除 — 合并)
│   ├── RecentFilesMenu.tsx              (删除 — 合并)
│   ├── OpenFileMenu.tsx                 (新：segment 复合 "📂 打开 + ▾")
│   ├── TemplateMenu.tsx                 (修改：按钮换 .ctl)
│   ├── FollowToggle.tsx                 (修改：改 chip 风格)
│   ├── FilterBar.tsx                    (修改：控件全部用 .ctl/.input-ctl/.select-ctl/.ctl-segment)
│   ├── StatsPanel.tsx                   (修改：去掉 total + level counts 行)
│   ├── LogList.tsx                      (修改：footer 加 level counts)
│   ├── ExportMenu.tsx                   (微调：button 用 .ctl)
│   ├── TemplateManagerDialog.tsx        (微调：button 用 .ctl)
│   ├── DetailDrawer.tsx                 (微调：button 用 .ctl)
│   └── RotationDialog.tsx               (微调：button 用 .ctl)
```

## 7. 验收清单

- [ ] `npm test` + `npm run build` 全绿
- [ ] 手动跑 `npm run tauri dev`：
  - [ ] 顶部 3 个控件（📂 打开/▾ + 模板按钮 + 实时跟踪 chip）视觉等高
  - [ ] FilterBar 三行内的 input / select / button / segment 视觉等高
  - [ ] StatsPanel 顶部只有 sparkline + scope tags（没有 total/level 计数）
  - [ ] 列表底部状态条显示：`匹配 N 条 · ERROR x · WARN y · INFO z`（0 计数 level 不显示）
  - [ ] 实时跟踪按钮点击后变绿色 chip 带 dot 脉冲；点击再次关闭
  - [ ] 顶部"📂 打开 + ▾"：左半触发文件对话框；右半 ▾ 触发最近文件下拉
  - [ ] 列表行号、列宽拖动、message+fields、详情抽屉、Export 菜单等已实现功能不被破坏

## 8. 估算

- ~8-10 task（多数是机械的 className 替换 + 一个组件合并）
- 预计 1.5-2 小时
