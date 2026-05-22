// 轮转/截断/删除时弹窗询问用户：重新加载 / 仅停止跟踪 / 关闭

import { useSession } from '../state/session';
import { openFile } from '../api/commands';

const MESSAGES: Record<string, string> = {
  Truncated: '文件被截断（可能日志轮转）。要重新加载文件吗？',
  InodeChanged: '文件被替换（inode 已变）。要重新加载新文件吗？',
  Removed: '文件已被删除。已停止跟踪，保留已加载数据。',
};

export function RotationDialog() {
  const { rotationKind, setRotationKind, metadata, setMetadata, setError } = useSession();
  if (!rotationKind) return null;

  const msg = MESSAGES[rotationKind] ?? `检测到文件变化：${rotationKind}`;
  const canReload = rotationKind !== 'Removed' && metadata;

  const handleReload = async () => {
    if (!metadata) return;
    try {
      const md = await openFile(metadata.path);
      setMetadata(md);
      setRotationKind(null);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
      setRotationKind(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40">
      <div className="bg-white rounded shadow-xl p-6 max-w-md">
        <h3 className="font-semibold mb-3">文件状态变化</h3>
        <p className="text-sm text-slate-700 mb-4">{msg}</p>
        <div className="flex justify-end gap-2">
          {canReload && (
            <button
              onClick={handleReload}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
            >
              重新加载
            </button>
          )}
          <button
            onClick={() => setRotationKind(null)}
            className="px-3 py-1.5 bg-slate-100 text-sm rounded hover:bg-slate-200"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
