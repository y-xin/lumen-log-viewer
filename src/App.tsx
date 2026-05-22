import { useState } from 'react';
import { OpenFileMenu } from './components/OpenFileMenu';
import { FilterBar } from './components/FilterBar';
import { StatsPanel } from './components/StatsPanel';
import { LogList } from './components/LogList';
import { TemplateMenu } from './components/TemplateMenu';
import { TemplateManagerDialog } from './components/TemplateManagerDialog';
import { DetailDrawer } from './components/DetailDrawer';
import { FollowToggle } from './components/FollowToggle';
import { RotationDialog } from './components/RotationDialog';
import { useSession } from './state/session';
import { useAutoQuery } from './hooks/useAutoQuery';
import { useTailFollow } from './hooks/useTailFollow';
import { useFileDrop } from './hooks/useFileDrop';

export default function App() {
  const { metadata, loading, error } = useSession();
  const [showManager, setShowManager] = useState(false);
  useAutoQuery();
  useTailFollow();
  const isDragging = useFileDrop();

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 px-4 py-2 border-b bg-white">
        <h1 className="text-base font-semibold">Log Viewer</h1>
        <OpenFileMenu />
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
      <RotationDialog />

      {/* 拖拽文件 overlay：覆盖整个窗口，不阻挡 drag-leave/drop 事件传播 */}
      {isDragging && (
        <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center bg-blue-500/20 border-4 border-dashed border-blue-500">
          <div className="bg-white rounded-lg shadow-xl px-6 py-4 text-center">
            <div className="text-3xl mb-1">📂</div>
            <div className="text-sm font-medium text-slate-700">松开鼠标打开日志文件</div>
          </div>
        </div>
      )}
    </div>
  );
}
