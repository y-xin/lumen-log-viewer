# 早晨验收清单 (2026-05-23 凌晨自主推进结果)

夜间自主完成 3 个 feature。所有改动都过了 `cargo test` (115+) 与 `npm test` (11)、`npm run build` 干净。

## 改动一览

### A. 多行 entry 展开/折叠 (commit `0a4f2bd`)

文件：`src/components/LogList.tsx`

- react-window 从 `FixedSizeList` 换 `VariableSizeList`
- 行末 `▸ N` 按钮（仅 `line_count > 1` 时显示）；点开变 `▾`，行下方插 mono pre-wrap 块显示 raw 剩余行
- 行高动态：折叠 28px / 展开 `28 + (line_count-1) × 16`，单条 entry 上限 10 行（超出有提示 "查看详情抽屉 Raw 区"）
- 切换 spec / 文件 → 全部折回
- 展开块也走 `<HighlightedText>` 支持关键词高亮
- 之前用 `scrollOffset` 算 atBottom 的逻辑（依赖固定行高）改用 `onItemsRendered` 的 `visibleStopIndex` 判断

**验收**
- [ ] 打开有 stack trace 的日志（electron 类）→ 多行 entry 行末出现 `▸ N`
- [ ] 点 `▸` → 展开看到完整 raw；点 `▾` → 折回
- [ ] 关键词搜索时展开块里命中也黄底高亮
- [ ] 切换模板 / 打开别的文件 → 自动折回
- [ ] 跟踪模式下展开的行随新条目滚动正常

### B. Tail-follow 增量过滤修正 (commit `0947376`)

文件：`src/state/session.ts`、`src/hooks/useTailFollow.ts`

修 README 已知 bug "tail 追加的新条目不走 spec filter — 新条目无条件追加"。

- `appendEntries` 退化成"只更新 metadata.total"
- `useTailFollow` 收到 entries_appended 后，250ms debounced 静默调一次 `cmd_query`（用当前 spec），把结果通过 `setResult` 写回
- `setResult` 新增 follow 模式下按 `total_matched` 差额累加 `newEntriesPending`（floating 跳到底部按钮的计数）
- 不走 `useAutoQuery` 是为了避免 loading=true 闪一下

**验收**
- [ ] 打开 follow ON，FilterBar 只勾 ERROR → 后续新 INFO 不再冒出来；只有新 ERROR 出现
- [ ] floating 跳底按钮的数字只数 matched 数（关键词 + scope 也过滤）
- [ ] follow OFF 后 spec 切换仍正常
- [ ] 高频追加（>10 条/s）不掉条 — debounce 250ms 内合并

### C. 列宽持久化 (commit `1e24241`)

文件：`src-tauri/src/prefs/store.rs`、`src-tauri/src/commands.rs`、`src-tauri/src/lib.rs`、`src/api/commands.ts`、`src/components/LogList.tsx`

- `Prefs.column_widths: Option<HashMap<String, u32>>`
- 2 个新 tauri 命令：`cmd_get_column_widths`、`cmd_save_column_widths`
- LogList 启动时读偏好，识别的 key 覆盖默认值
- 列宽变化后 400ms debounced 写回（防拖动期间 IO 风暴）
- 全局，不区分文件

**验收**
- [ ] 拖任意列宽 → 重启应用 → 列宽保持
- [ ] 拖动时不卡顿（debounce 生效）
- [ ] prefs.json 里看到 `"column_widths": {...}` 字段

## 跳过的项目（决策记录）

| 项 | 跳过原因 |
|---|---|
| 暗色模式 | 需要 palette 决策；中途无法 ping 用户 |
| 命令面板 | 键位分配 / 搜索范围都需要决策 |
| 多文件 tab | 架构改动太大，spec 模块要重写 |
| Windows 轮转检测 | 无 Windows 测试环境 |
| 字体大小调整 | 需要决定基准字号 + 调整范围 |
| 解析嗅探质量提示 | 需要后端改 FileMetadata + 5+ 文件，破坏性中等 |
| 统一设置面板 | scope 容易爆炸，建议拆成单独 feature |

## 后续待办（按优先级）

1. **暗色模式**（user-visible）
2. **解析嗅探质量提示** + 一键切模板按钮
3. **字体大小调整** ⌘+ / ⌘- + 持久化
4. **统一设置面板**（聚合上面所有偏好）
5. **regex 关键词搜索**
6. **多文件 tab**

## 全测试日志

```
cargo test:
  test result: ok. 115 passed; 0 failed
  test result: ok. 0 + 1 + 3 + 5 + 0 (integration suites)

npm test:
  Test Files  3 passed (3)
  Tests       11 passed (11)

npm run build:
  ✓ built in ~1.1s
```

## 早晨核对脚本

```bash
cd "/Users/kimyeung/Personal Projects/log-viewer"
git log --oneline 9191d10..HEAD     # 看夜间所有 commit
npm run tauri dev                    # 跑起来手动过上面 3 个验收清单
```

如果某个 feature 行为不符预期 / 想回滚单一项：

```bash
# 回滚 A 多行展开
git revert 0a4f2bd

# 回滚 B follow 修正
git revert 0947376

# 回滚 C 列宽持久化
git revert 1e24241
```

三者独立，可单独回滚不影响其余。
