import { OpenFileButton } from './components/OpenFileButton';
import { useSession } from './state/session';

export default function App() {
  const { metadata, loading, error } = useSession();
  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 px-4 py-2 border-b bg-white">
        <h1 className="text-base font-semibold">Log Viewer</h1>
        <OpenFileButton />
        <div className="ml-auto text-xs text-slate-500">
          {metadata ? `${metadata.path} · ${metadata.total} 行 · 模板 ${metadata.template_id}` : '未打开文件'}
        </div>
      </header>
      {error && (
        <div className="px-4 py-2 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
      )}
      {loading && (
        <div className="px-4 py-2 text-sm text-slate-600">加载中…</div>
      )}
      <main className="flex-1 overflow-hidden">
        {!metadata && !loading && (
          <div className="h-full flex items-center justify-center text-slate-400">
            点击"打开日志文件"开始
          </div>
        )}
        {/* FilterBar / StatsPanel / LogList 在后续 Phase 加入 */}
      </main>
    </div>
  );
}
