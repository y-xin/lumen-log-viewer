# 多行 Entry 展开/折叠 v1 设计文档

- **日期**：2026-05-22
- **状态**：自主执行（用户睡眠时间）
- **前置**：cross-page nav + highlight 已落地

## 1. 目标

多行 entry（`line_count > 1`）在表格里：
- 默认折叠：只显示 `entry.message` 第一行 + 行末标记 `▸`
- 点 `▸` 展开：变成高行，显示完整 `entry.raw`（pre-wrap 保留换行 + 缩进）
- 行高动态：折叠 28px / 展开 `28 + (line_count-1) * 16`px（最高 ~10 行 = 172px，超出 scroll within row）

## 2. 非目标

- 持久化展开状态（每次文件切换/spec 变化都重置）
- 全部展开 / 全部折叠 一键操作
- 展开状态下编辑 / 复制 fragment

## 3. 实现

### 3.1 LogList 改 VariableSizeList

react-window 提供 `VariableSizeList` 支持每行不同高度。改：
```tsx
import { VariableSizeList as List } from 'react-window';
```

新增 ref 用 `List.resetAfterIndex` 在展开状态变化时刷新尺寸缓存。

### 3.2 展开状态

```tsx
const [expanded, setExpanded] = useState<Set<number>>(new Set());
// key 用 line_no（line_count > 1 的 entry 都是块开始 = line_no 唯一）

const toggleExpand = useCallback((lineNo: number) => {
  setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(lineNo)) next.delete(lineNo); else next.add(lineNo);
    return next;
  });
  // 立即清缓存让 List 重算
  listRef.current?.resetAfterIndex(0);
}, []);
```

文件 / spec 切换时清空：
```tsx
useEffect(() => {
  setExpanded(new Set());
  listRef.current?.resetAfterIndex(0);
}, [curKey]);  // curKey 已存在，是 spec JSON
```

### 3.3 行高计算

```tsx
const ROW_HEIGHT = 28;
const EXPANDED_LINE = 16;

const getItemSize = useCallback((index: number) => {
  const e = entries[index];
  if (!e || e.line_count <= 1) return ROW_HEIGHT;
  if (!expanded.has(e.line_no)) return ROW_HEIGHT;
  // 展开：基础行 + 额外行；每额外行 16px；上限 11 行（避免一条 entry 把整个视口占满）
  const extraLines = Math.min(e.line_count - 1, 10);
  return ROW_HEIGHT + extraLines * EXPANDED_LINE;
}, [entries, expanded]);
```

### 3.4 Row 渲染

折叠态（line_count == 1）：现有不变。

折叠态（line_count > 1）：右侧 message 末加 `▸` 按钮，stop propagation 防止触发整行选中：
```tsx
<button
  onClick={(e) => { e.stopPropagation(); toggleExpand(e.line_no); }}
  className="text-slate-400 hover:text-slate-700 ml-1 font-mono"
  title={`展开 ${e.line_count} 行`}
>
  ▸ {e.line_count}
</button>
```

展开态：
- 第一行同折叠 + 改为 `▾` 按钮
- 下方插入一个 mono pre-wrap 块显示 `entry.raw` 完整内容（除首行），缩进对齐到 message 列
- 整行容器换 `flex-col`

```tsx
<div style={{ ...style }} className="flex flex-col ...">
  <div className="flex items-stretch h-7">  {/* 28px 首行 */}
    {/* 既有 line / time / level / scope / message + ▾ */}
  </div>
  {isExpanded && (
    <div
      className="px-2 font-mono text-xs whitespace-pre text-slate-600 bg-slate-50 border-t border-slate-100"
      style={{ paddingLeft: widths.line + widths.time + widths.level + widths.scope + 8 }}
    >
      {restOfRaw(e.raw)}
    </div>
  )}
</div>
```

`restOfRaw(raw)`：split 后舍弃第一行，join `\n`。

### 3.5 高亮

展开块也走 `<HighlightedText>` 包装。

## 4. 文件清单

```
src/components/LogList.tsx     (修改：VariableSizeList + expanded state + ▸/▾ + restOfRaw block)
```

仅 1 个文件改动。无新组件、无新 helper、无新测试（视觉行为，自动化测试覆盖性差）。

## 5. 验收

- [ ] 单行 entry 仍 28px 高、无 ▸
- [ ] 多行 entry 行末显示 `▸ N`
- [ ] 点 `▸` → 行变高、显示 raw 剩余行、按钮变 `▾`
- [ ] 点 `▾` → 折回
- [ ] 切换 spec / 关闭重开文件 → 全折叠
- [ ] 展开块高亮 text_search 命中
- [ ] 行选中 / 详情抽屉不被影响
- [ ] 跟踪模式下展开的行随新条目滚动正常

## 6. 估算

3-4 task / 30-45 分钟。
