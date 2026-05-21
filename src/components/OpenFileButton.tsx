// 打开文件按钮：调 tauri dialog 选文件 → 调 openFile command → 写入 store

import { open } from '@tauri-apps/plugin-dialog';
import { openFile } from '../api/commands';
import { useSession } from '../state/session';

export function OpenFileButton() {
  const { setMetadata, setError, setLoading, setResult } = useSession();

  const handle = async () => {
    setError(null);
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Log', extensions: ['log', 'jsonl', 'txt'] }],
    });
    if (typeof selected !== 'string') return;
    try {
      setLoading(true);
      setResult(null);
      const md = await openFile(selected);
      setMetadata(md);
    } catch (e) {
      const msg = typeof e === 'string' ? e : JSON.stringify(e);
      setError(`打开失败：${msg}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handle}
      className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
    >
      打开日志文件
    </button>
  );
}
