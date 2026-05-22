import { useState } from 'react';
import { OpenFileButton } from './components/OpenFileButton';
import { FilterBar } from './components/FilterBar';
import { StatsPanel } from './components/StatsPanel';
import { LogList } from './components/LogList';
import { TemplateMenu } from './components/TemplateMenu';
import { TemplateManagerDialog } from './components/TemplateManagerDialog';
import { DetailDrawer } from './components/DetailDrawer';
import { FollowToggle } from './components/FollowToggle';
import { useSession } from './state/session';
import { useAutoQuery } from './hooks/useAutoQuery';
import { useTailFollow } from './hooks/useTailFollow';

export default function App() {
  const { metadata, loading, error } = useSession();
  const [showManager, setShowManager] = useState(false);
  useAutoQuery();
  useTailFollow();

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 px-4 py-2 border-b bg-white">
        <h1 className="text-base font-semibold">Log Viewer</h1>
        <OpenFileButton />
        {metadata && <TemplateMenu onOpenManager={() => setShowManager(true)} />}
        {metadata && <FollowToggle />}
        <div className="ml-auto text-xs text-slate-500">
          {metadata ? `${metadata.path} · ${metadata.total} 行 · 模板 ${metadata.template_id}` : '未打开文件'}
        </div>
      </header>
      {error && (
        <div className="px-4 py-2 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
      )}
      {metadata && <FilterBar />}
      {metadata && <StatsPanel />}
      {metadata ? <LogList /> : (
        <main className="flex-1 flex items-center justify-center text-slate-400">
          {loading ? '加载中…' : '点击"打开日志文件"开始'}
        </main>
      )}

      {showManager && <TemplateManagerDialog onClose={() => setShowManager(false)} />}
      <DetailDrawer />
    </div>
  );
}
