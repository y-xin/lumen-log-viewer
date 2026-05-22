# Keyboard Shortcuts v1 设计文档

- **日期**：2026-05-22
- **状态**：设计已认可，待生成实现计划
- **前置**：当前 UI 已实现 Style v3 + Saved Filters

## 1. 目标

一套全局快捷键覆盖文件操作 / 筛选 / 菜单切换；按 `?` 弹一览表。降低高频操作的鼠标依赖。

## 2. 非目标

- 自定义快捷键配置 / 重映射
- Vim 风格行内导航（j/k）
- 数字键 1-6 toggle level（用户明确不选）
- macOS-specific keychord 模式（如 ⌘K ⌘C）
- 焦点环 / Tab 顺序优化

## 3. 快捷键清单

| 快捷键 | 行为 | 触发条件 | 派发方式 |
|---|---|---|---|
| `⌘O` / `Ctrl+O` | 打开文件对话框 | 全局 | 直接调 `@tauri-apps/plugin-dialog` open + loadFile |
| `⌘R` / `Ctrl+R` | 刷新当前 spec | 全局 | `setSpec({ ...spec })` 触发 useAutoQuery |
| `⌘F` / `Ctrl+F` | 聚焦关键词输入框 | 全局 | CustomEvent `lv:focus-keyword` |
| `⌘K` / `Ctrl+K` | 清空所有筛选 | 全局 | 直接 patchSpec 重置 5 字段 |
| `⌘T` / `Ctrl+T` | 切换实时跟踪 | metadata 存在 | 直接 `setFollow(!follow)` |
| `⌘E` / `Ctrl+E` | 打开导出菜单 | metadata 存在 | CustomEvent `lv:open-export` |
| `⌘S` / `Ctrl+S` | 打开 saved-filter 菜单 | metadata 存在 | CustomEvent `lv:open-saved-filters` |
| `?` | 弹快捷键 help | 输入框未聚焦 | `setHelpOpen(true)` |
| `Esc` | 关 help → modal → drawer | 全局 | 按优先级逐级关 |

跨平台：检测 `e.metaKey || e.ctrlKey`，逻辑共用。

## 4. 架构

### 4.1 集中式 hook `useGlobalShortcuts`

挂在 `App.tsx`，唯一的 `window` keydown 监听者。
- 解析按键组合
- 直接做的事（开 dialog / patchSpec / setFollow / setSpec）走 store action 或 API
- 需要触发其他组件状态的（开 ExportMenu / SavedFiltersMenu / 聚焦 keyword input）通过 `window.dispatchEvent(new CustomEvent(...))`

### 4.2 CustomEvent 事件命名

```
lv:focus-keyword       // 由 ⌘F 派发；FilterBar 监听 → keyword input.focus()
lv:open-export         // 由 ⌘E 派发；ExportMenu 监听 → setOpen(true)
lv:open-saved-filters  // 由 ⌘S 派发；SavedFiltersMenu 监听 → setOpen(true)
```

事件名前缀 `lv:`（log-viewer 缩写）防与浏览器原生事件冲突。

### 4.3 zustand 状态新增

```ts
helpOpen: boolean;
setHelpOpen: (b: boolean) => void;
```

无其他状态扩展。

### 4.4 Help overlay `ShortcutsHelp.tsx`

固定 modal 居中，z-50（高于 drawer/RotationDialog），列出所有快捷键 + 描述。背景半透明遮罩。
- 点遮罩 / 按 Esc / 再按 ? → 关
- 实现为简单 React 组件，挂在 App.tsx，根据 helpOpen 显隐

### 4.5 Esc 行为合并

`useKeyboardNav`（仅 drawer Esc）合并进 `useGlobalShortcuts`，统一按以下优先级：
1. helpOpen → setHelpOpen(false)
2. rotationKind 非 null → setRotationKind(null)
3. (TemplateManagerDialog 自己管理 open，不接入这里 — 后述)
4. selectedEntry 非 null → setSelectedEntry(null)

TemplateManagerDialog 的 open state 由 App.tsx 局部 `showManager` 管理，不在 store 里。其 Esc 通过自身组件内 useEffect 监听处理（轻微局部偏离原则，避免给 App.tsx 加 prop drilling）。

## 5. 实现细节

### 5.1 输入框检测

```ts
function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
}
```

- `?` 单键：`if (isTypingTarget(e)) return;` 跳过
- ⌘-组合键：不跳过（用户在 input 里也希望 ⌘O / ⌘F 能用）

### 5.2 ⌘K 清空 spec

```ts
const ALL_LEVELS: LogLevel[] = ['trace','debug','info','warn','error','unknown'];
patchSpec({
  levels: ALL_LEVELS,
  scope_filter: null,
  scope_in: null,
  text_search: null,
  time_range: null,
});
```
FilterBar 已有"spec → 本地输入态"反向同步 useEffect，输入框/select 会自动回填空。

### 5.3 ⌘R 刷新

```ts
setSpec({ ...spec });  // 新引用触发 useAutoQuery
```
不调 `patchSpec({})`，更明确。

### 5.4 ⌘O 打开

直接调用 OpenFileMenu 里同样的逻辑（open dialog → openFile → loadFile）。为复用，提取一个 `openFileViaDialog(loadFile, setError, setLoading)` helper 到 `api/dialog.ts`（OpenFileMenu 同时改用此 helper）。

### 5.5 preventDefault

所有 ⌘-组合在浏览器都有默认行为（⌘O = open URL bar, ⌘R = reload, ⌘F = browser find, ⌘S = save page, etc.）。匹配后 `e.preventDefault()`。

### 5.6 ⌘E / ⌘S 派发后菜单已被遮罩盖住的情况

每个菜单的 `open` 状态由其内部 `useState` 管，CustomEvent 触发后会设 open=true。如果已经 open，再触发不变化，无害。如果点击外部遮罩（fixed inset-0 那层）会关闭 — 用户预期。

## 6. 边界与异常

- **input 聚焦时按 ⌘K**：仍会清空筛选；input 本身会回填空。可接受。
- **多次按 ?**：toggle help（按一次开，再按关）。
- **没打开文件按 ⌘T / ⌘E / ⌘S**：早返回，无副作用。
- **跨平台 Ctrl+R = browser reload**：在 Tauri WKWebView 里默认是 reload web 页（重置整个 app 状态）。我们 preventDefault 后变成"重新查询"，正常。
- **被 Tauri menu bar 拦截的快捷键**：tauri.conf.json 默认无菜单栏配置，应不会冲突。如果将来加菜单，需注意。

## 7. 测试

### 7.1 vitest 单元测试

加 `useGlobalShortcuts.test.ts`，测：
- 按 `?` 在 input 里不触发 setHelpOpen（mock activeElement = input）
- 按 `?` 在普通元素上触发 setHelpOpen
- 按 `⌘F` 派发 `lv:focus-keyword` CustomEvent
- 按 `⌘K` 调 patchSpec 重置 5 字段
- 按 `Esc` 按优先级处理（mock 多个开状态）

工具：`@testing-library/react` 已在依赖（FilterBar 测试用过），用 `renderHook` + `act(() => fireEvent.keyDown(window, ...))`。

### 7.2 手动验收

按 §9 清单一项项核对。

## 8. 文件清单

```
src/
├── api/
│   └── dialog.ts                        (新：openFileViaDialog helper)
├── hooks/
│   ├── useGlobalShortcuts.ts            (新：集中 keydown 监听)
│   └── useKeyboardNav.ts                (删除：行为已合并进 useGlobalShortcuts)
├── components/
│   ├── ShortcutsHelp.tsx                (新：help modal)
│   ├── FilterBar.tsx                    (修改：keyword input 加 ref + 监听 lv:focus-keyword)
│   ├── ExportMenu.tsx                   (修改：监听 lv:open-export)
│   ├── SavedFiltersMenu.tsx             (修改：监听 lv:open-saved-filters)
│   ├── OpenFileMenu.tsx                 (修改：用 openFileViaDialog helper)
│   ├── TemplateManagerDialog.tsx        (微调：自己加 Esc 监听)
│   ├── DetailDrawer.tsx                 (修改：移除 useKeyboardNav 调用)
│   └── App.tsx                          (修改：useGlobalShortcuts() + <ShortcutsHelp />)
├── state/session.ts                     (修改：加 helpOpen + setHelpOpen)
└── hooks/useGlobalShortcuts.test.ts     (新：5 个单测)
```

## 9. 验收清单

- [ ] `npm test` + `npm run build` 全绿
- [ ] 手动跑 `npm run tauri dev`：
  - [ ] `⌘O` 打开文件对话框
  - [ ] `⌘R` 触发一次重新查询（loading 一闪而过）
  - [ ] `⌘F` 聚焦关键词输入框；已聚焦时不报错
  - [ ] `⌘K` 清空所有筛选；FilterBar 输入框 / select 同步空
  - [ ] `⌘T` 切换实时跟踪 chip 状态
  - [ ] `⌘E` 打开导出菜单
  - [ ] `⌘S` 打开 saved-filter 菜单
  - [ ] `?` 弹 help 一览；再按 `?` 或 Esc 关
  - [ ] 在 keyword 输入框内按 `?` 不弹 help（输入 `?` 字符）
  - [ ] Esc 优先级：先关 help → 再关 rotationDialog → 再关 drawer
  - [ ] 没打开文件时按 ⌘T / ⌘E / ⌘S 无副作用

## 10. 估算

- ~10 task（store 字段 / 4 个组件改 / dialog helper / hook / help modal / 测试 / 验收 / README）
- 1.5-2 小时
