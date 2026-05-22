// 共享：通过原生 open dialog 选日志文件 → 调 openFile → loadFile
// 由 OpenFileMenu 和 useGlobalShortcuts（⌘O）共用，避免逻辑两份。

import { open } from '@tauri-apps/plugin-dialog';
import { openFile } from './commands';
import type { FileMetadata } from '../types/log';

interface Deps {
  loadFile: (md: FileMetadata) => void;
  setLoading: (b: boolean) => void;
  setError: (msg: string | null) => void;
}

export async function openFileViaDialog({ loadFile, setLoading, setError }: Deps): Promise<void> {
  setError(null);
  const selected = await open({
    multiple: false,
    filters: [{ name: 'Log', extensions: ['log', 'jsonl', 'txt'] }],
  });
  if (typeof selected !== 'string') return;
  try {
    setLoading(true);
    const md = await openFile(selected);
    loadFile(md);
  } catch (e) {
    setError(`打开失败：${typeof e === 'string' ? e : JSON.stringify(e)}`);
  } finally {
    setLoading(false);
  }
}
