// 全局状态：当前文件元数据 + 当前 QuerySpec + 最新查询结果 + 模板列表 + tail follow 状态

import { create } from 'zustand';
import type { FileMetadata, QuerySpec, QueryResponse, LogLevel, TemplateInfo, LogEntry } from '../types/log';
import { listTemplates } from '../api/commands';

const ALL_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'unknown'];

interface SessionStore {
  metadata: FileMetadata | null;
  spec: QuerySpec;
  result: QueryResponse | null;
  loading: boolean;
  error: string | null;
  templates: TemplateInfo[];
  currentTemplateId: string | null;
  /**
   * 当前在详情抽屉里选中的 entry —— 直接存整个对象，不再用 line_no 反向查找
   * （之前用 line_no 只能在 result.page_entries 前 200 条里找到，几万行后的行点不出来）。
   */
  selectedEntry: LogEntry | null;

  follow: boolean;
  /** tail-follow 时新 error 是否触发桌面通知（仅当窗口未聚焦时） */
  notifyOnError: boolean;
  rotationKind: string | null;
  newEntriesPending: number;
  /** 快捷键 help overlay 是否打开 */
  helpOpen: boolean;
  /** 跳到行号 dialog 是否打开 */
  gotoOpen: boolean;
  /** 设置面板是否打开 */
  settingsOpen: boolean;
  /** 日志内容字号（LogList row + DetailDrawer Message/Raw），px */
  fontSize: number;

  /**
   * 打开新文件用：把 metadata 写入，同时清空 spec / result / 选中行 / 待追加计数。
   * follow toggle 状态保留（用户开着跟踪打开下一个文件，期望仍然在跟踪）。
   */
  loadFile: (m: FileMetadata) => void;
  /** 更新 metadata 但保留 spec（用于模板切换、tail-follow 后刷 metadata 等）。 */
  setMetadata: (m: FileMetadata | null) => void;
  setSpec: (s: QuerySpec) => void;
  patchSpec: (p: Partial<QuerySpec>) => void;
  setResult: (r: QueryResponse | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setTemplates: (ts: TemplateInfo[]) => void;
  setSelectedEntry: (e: LogEntry | null) => void;

  setFollow: (b: boolean) => void;
  setNotifyOnError: (b: boolean) => void;
  setRotationKind: (k: string | null) => void;
  appendEntries: (entries: LogEntry[], total: number) => void;
  clearNewEntriesPending: () => void;
  setHelpOpen: (b: boolean) => void;
  setGotoOpen: (b: boolean) => void;
  setSettingsOpen: (b: boolean) => void;
  setFontSize: (n: number) => void;
  /** 重新从后端拉取模板列表并写入 store */
  refetchTemplates: () => Promise<void>;
}

export const useSession = create<SessionStore>((set) => ({
  metadata: null,
  spec: { levels: ALL_LEVELS },
  result: null,
  loading: false,
  error: null,
  templates: [],
  currentTemplateId: null,
  selectedEntry: null,

  follow: false,
  notifyOnError: false,
  rotationKind: null,
  newEntriesPending: 0,
  helpOpen: false,
  gotoOpen: false,
  settingsOpen: false,
  fontSize: 12,

  loadFile: (m) => set({
    metadata: m,
    currentTemplateId: m.template_id,
    selectedEntry: null,
    newEntriesPending: 0,
    spec: { levels: ALL_LEVELS },
    result: null,
    error: null,
    rotationKind: null,
  }),
  setMetadata: (m) => set({
    metadata: m,
    currentTemplateId: m?.template_id ?? null,
    selectedEntry: null,
    newEntriesPending: 0,
  }),
  setSpec: (spec) => set({ spec }),
  patchSpec: (p) => set((s) => ({ spec: { ...s.spec, ...p } })),
  setResult: (result) => set((s) => {
    // follow 模式下：根据 total_matched 增量计算 newEntriesPending
    // （tail-follow 重新查询后，本次 matched 总数 - 上次 matched 总数 = 这次过滤后的"新条目"）
    let pending = s.newEntriesPending;
    if (s.follow && result && s.result) {
      const delta = result.total_matched - s.result.total_matched;
      if (delta > 0) pending += delta;
    }
    return { result, newEntriesPending: pending };
  }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setTemplates: (templates) => set({ templates }),
  setSelectedEntry: (e) => set({ selectedEntry: e }),
  setFollow: (b) => set({ follow: b }),
  setNotifyOnError: (b) => set({ notifyOnError: b }),
  setRotationKind: (k) => set({ rotationKind: k }),
  /**
   * tail-follow 收到新条目后调用：仅更新 metadata.total（文件原始行数）。
   * result 由 useTailFollow 内的 debounced re-query 静默刷新，
   * setResult 会按 total_matched 差额自动累加 newEntriesPending。
   *
   * 旧实现把所有 newEntries 直接 push 到 page_entries 并累加计数，无视当前 spec —
   * 是 README 已知 bug "tail 追加的新条目不走 spec filter"。
   *
   * newEntries 参数保留兼容（后端事件还在发，但前端不再直接消费）。
   */
  appendEntries: (_newEntries, total) => set((s) => ({
    metadata: s.metadata ? { ...s.metadata, total } : s.metadata,
  })),
  clearNewEntriesPending: () => set({ newEntriesPending: 0 }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setGotoOpen: (gotoOpen) => set({ gotoOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setFontSize: (fontSize) => set({ fontSize: Math.min(20, Math.max(10, fontSize)) }),
  refetchTemplates: async () => {
    const list = await listTemplates();
    set({ templates: list });
  },
}));
