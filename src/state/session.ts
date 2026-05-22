// 全局状态：当前文件元数据 + 当前 QuerySpec + 最新查询结果 + 模板列表

import { create } from 'zustand';
import type { FileMetadata, QuerySpec, QueryResponse, LogLevel, TemplateInfo } from '../types/log';

const ALL_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'unknown'];

interface SessionStore {
  metadata: FileMetadata | null;
  spec: QuerySpec;
  result: QueryResponse | null;
  loading: boolean;
  error: string | null;

  templates: TemplateInfo[];
  currentTemplateId: string | null;

  selectedLineNo: number | null;
  setSelectedLineNo: (n: number | null) => void;

  setMetadata: (m: FileMetadata | null) => void;
  setSpec: (s: QuerySpec) => void;
  patchSpec: (p: Partial<QuerySpec>) => void;
  setResult: (r: QueryResponse | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;

  setTemplates: (ts: TemplateInfo[]) => void;
}

export const useSession = create<SessionStore>((set) => ({
  metadata: null,
  spec: { levels: ALL_LEVELS },
  result: null,
  loading: false,
  error: null,
  templates: [],
  currentTemplateId: null,
  selectedLineNo: null,

  setMetadata: (m) => set({
    metadata: m,
    currentTemplateId: m?.template_id ?? null,
    selectedLineNo: null,
  }),
  setSpec: (spec) => set({ spec }),
  patchSpec: (p) => set((s) => ({ spec: { ...s.spec, ...p } })),
  setResult: (result) => set({ result }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  setTemplates: (templates) => set({ templates }),
  setSelectedLineNo: (n) => set({ selectedLineNo: n }),
}));
