// 全局状态：当前文件元数据 + 当前 QuerySpec + 最新查询结果 + 模板列表 + tail follow 状态

import { create } from 'zustand';
import type { FileMetadata, QuerySpec, QueryResponse, LogLevel, TemplateInfo, LogEntry } from '../types/log';

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
  rotationKind: string | null;
  newEntriesPending: number;

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
  setRotationKind: (k: string | null) => void;
  appendEntries: (entries: LogEntry[], total: number) => void;
  clearNewEntriesPending: () => void;
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
  rotationKind: null,
  newEntriesPending: 0,

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
  setResult: (result) => set({ result }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setTemplates: (templates) => set({ templates }),
  setSelectedEntry: (e) => set({ selectedEntry: e }),
  setFollow: (b) => set({ follow: b }),
  setRotationKind: (k) => set({ rotationKind: k }),
  appendEntries: (newEntries, total) => set((s) => {
    if (!s.result) {
      return {
        metadata: s.metadata ? { ...s.metadata, total } : s.metadata,
        newEntriesPending: s.newEntriesPending + newEntries.length,
      };
    }
    return {
      result: {
        ...s.result,
        total_matched: s.result.total_matched + newEntries.length,
        page_entries: [...s.result.page_entries, ...newEntries],
      },
      metadata: s.metadata ? { ...s.metadata, total } : s.metadata,
      newEntriesPending: s.newEntriesPending + newEntries.length,
    };
  }),
  clearNewEntriesPending: () => set({ newEntriesPending: 0 }),
}));
