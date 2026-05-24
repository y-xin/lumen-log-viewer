// 短期内存：保存用户勾选"本次会话记住"的 passphrase
// 关窗 / 刷新即丢失（zustand store 在 webview 内）
// 永不持久化

import { create } from 'zustand';

interface State {
  rememberedSecrets: Map<string, string>; // key = "host:port:user"，value = passphrase / password
  remember(hostKey: string, secret: string): void;
  recall(hostKey: string): string | undefined;
  forget(hostKey: string): void;
  clear(): void;
}

export const useRemoteSession = create<State>((set, get) => ({
  rememberedSecrets: new Map(),
  remember(hostKey, secret) {
    set((s) => {
      const next = new Map(s.rememberedSecrets);
      next.set(hostKey, secret);
      return { rememberedSecrets: next };
    });
  },
  recall(hostKey) {
    return get().rememberedSecrets.get(hostKey);
  },
  forget(hostKey) {
    set((s) => {
      const next = new Map(s.rememberedSecrets);
      next.delete(hostKey);
      return { rememberedSecrets: next };
    });
  },
  clear() {
    set({ rememberedSecrets: new Map() });
  },
}));
