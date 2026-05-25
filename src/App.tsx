import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { takePendingConnection, openRemoteFile, type SshConnectionParams } from './api/remote';
import { HostKeyDialog } from './components/HostKeyDialog';
import { OpenFileMenu } from './components/OpenFileMenu';
import { FilterBar } from './components/FilterBar';
import { StatsPanel } from './components/StatsPanel';
import { LogList } from './components/LogList';
import { TemplateMenu } from './components/TemplateMenu';
import { TemplateManagerDialog } from './components/TemplateManagerDialog';
import { DetailDrawer } from './components/DetailDrawer';
import { FollowToggle } from './components/FollowToggle';
import { NotifyToggle } from './components/NotifyToggle';
import { RotationDialog } from './components/RotationDialog';
import { useSession } from './state/session';
import { useAutoQuery } from './hooks/useAutoQuery';
import { useTailFollow } from './hooks/useTailFollow';
import { useTailStatsRefresh } from './hooks/useTailStatsRefresh';
import { useFileDrop } from './hooks/useFileDrop';
import { useAutoOpenRecent } from './hooks/useAutoOpenRecent';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { usePrefsSync } from './hooks/usePrefsSync';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { GotoLineDialog } from './components/GotoLineDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { SniffQualityBanner } from './components/SniffQualityBanner';
import { loadUiPrefs, applyUiPrefs, migrateLegacyLocalStorage, DEFAULT as UI_DEFAULT } from './lib/uiPrefs';
import { useEffect as useEffectInit } from 'react';
import { getFontSize, saveFontSize, openFile } from './api/commands';

// 启动时同步应用默认值（避免白屏闪）
applyUiPrefs(UI_DEFAULT);

export default function App() {
  const { metadata, loading, error } = useSession();
  const settingsOpen = useSession((s) => s.settingsOpen);
  const setSettingsOpen = useSession((s) => s.setSettingsOpen);
  const [showManager, setShowManager] = useState(false);
  useAutoQuery();
  useTailFollow();
  useTailStatsRefresh();
  useAutoOpenRecent();
  useGlobalShortcuts();
  usePrefsSync();
  const isDragging = useFileDrop();

  // 启动时：迁移历史存储 + 异步拉真实偏好 reapply
  useEffectInit(() => {
    (async () => {
      await migrateLegacyLocalStorage();
      const p = await loadUiPrefs();
      applyUiPrefs(p);
    })();
  }, []);

  // 启动时拉字号偏好；变化时（⌘+/-/0 触发）静默保存
  const fontSize = useSession((s) => s.fontSize);
  const setFontSize = useSession((s) => s.setFontSize);
  useEffectInit(() => {
    getFontSize().then((n) => { if (typeof n === 'number') setFontSize(n); }).catch(() => {});
  }, [setFontSize]);
  useEffectInit(() => {
    // 默认 12 不写盘（区分"未保存"与"显式选择 12"无关紧要 — 默认就是 12）
    if (fontSize !== 12) {
      saveFontSize(fontSize).catch(() => {});
    }
  }, [fontSize]);

  // 多窗口启动：从 URL ?path= 读取初始文件（cmd_open_in_new_window 创建新窗口时拼的 URL）
  useEffectInit(() => {
    const params = new URLSearchParams(window.location.search);
    const initialPath = params.get('path');
    if (initialPath) {
      openFile(decodeURIComponent(initialPath))
        .then((md) => useSession.getState().loadFile(md))
        .catch(() => {});
    }
  }, []);

  // SSH host-key 确认弹窗状态
  const [hostKeyDialog, setHostKeyDialog] = useState<
    { host: string; port: number; fingerprint: string } | null>(null);
  // 缓存"等待确认 host-key 后需要重试的连接参数" — trust/session-only 后 retry
  const pendingRetryRef = useRef<{
    params: SshConnectionParams;
    path: string;
    tailLines: number;
  } | null>(null);

  // mount 时尝试消费 pending connection（cmd_open_remote_in_new_window 流程）
  useEffect(() => {
    takePendingConnection().then(async (pending) => {
      if (!pending) return;
      try {
        await openRemoteFile(pending.params, pending.path, pending.tail_lines);
      } catch (e: any) {
        // Tauri cmd 抛 AppError 时 e 大致是 { kind, message } 形态
        const err = e as { kind?: string; message?: any };
        if (err?.kind === 'HostKeyUnknown' && typeof err.message === 'object') {
          // 缓存原始连接参数 — dialog 关闭时根据用户选择决定 retry
          pendingRetryRef.current = {
            params: pending.params,
            path: pending.path,
            tailLines: pending.tail_lines,
          };
          setHostKeyDialog({
            host: err.message.host, port: err.message.port,
            fingerprint: err.message.fingerprint,
          });
        } else {
          console.error('open remote failed', e);
        }
      }
    }).catch((e) => console.error('takePendingConnection failed', e));
  }, []);

  // 监听后端主动推的 host-key-unknown 事件（RemoteReader 重试中遇到的 case）
  useEffect(() => {
    const unlisten = listen<{ host: string; port: number; fingerprint: string }>(
      'lv:host-key-unknown',
      ({ payload }) => setHostKeyDialog(payload)
    );
    return () => { unlisten.then((f) => f()).catch(() => {}); };
  }, []);

  // host-key dialog 关闭回调：confirmed=true（trust/session-only）时 retry openRemoteFile
  const handleHostKeyDialogClose = async (confirmed: boolean) => {
    const retry = pendingRetryRef.current;
    pendingRetryRef.current = null;
    setHostKeyDialog(null);
    if (confirmed && retry) {
      try {
        await openRemoteFile(retry.params, retry.path, retry.tailLines);
      } catch (e) {
        console.error('retry openRemoteFile failed', e);
      }
    }
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 px-4 py-2 border-b bg-white">
        <h1 className="text-base font-semibold flex items-baseline gap-1.5">
          <span>Lumen</span>
          <span className="text-[11px] font-normal text-slate-400">日志查看</span>
        </h1>
        <OpenFileMenu />
        {metadata && <TemplateMenu onOpenManager={() => setShowManager(true)} />}
        {metadata && <FollowToggle />}
        {metadata && <NotifyToggle />}
        <button
          onClick={() => setSettingsOpen(true)}
          className="ctl"
          title="设置 (⌘,)"
          style={{ marginLeft: 4 }}
        >⚙</button>
        <div className="ml-auto text-xs text-slate-500 truncate max-w-[50%]" title={metadata?.path}>
          {metadata ? metadata.path : '未打开文件'}
        </div>
      </header>
      {error && (
        <div className="px-4 py-2 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
      )}
      {metadata && <SniffQualityBanner />}
      {metadata && <FilterBar />}
      {/* Raw 模式（sniff=NoMatch）下 StatsPanel 没意义（level 全 unknown / scope 空）— 直接隐藏 */}
      {metadata && metadata.sniff_kind !== 'NoMatch' && <StatsPanel />}
      {metadata ? <LogList /> : (
        <main className="flex-1 flex items-center justify-center text-slate-400">
          {loading ? '加载中…' : '点击"打开日志文件"开始'}
        </main>
      )}

      {showManager && <TemplateManagerDialog onClose={() => setShowManager(false)} />}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onOpenTemplateManager={() => setShowManager(true)}
        />
      )}
      <DetailDrawer />
      <RotationDialog />
      <ShortcutsHelp />
      <GotoLineDialog />

      {hostKeyDialog && (
        <HostKeyDialog
          host={hostKeyDialog.host}
          port={hostKeyDialog.port}
          fingerprint={hostKeyDialog.fingerprint}
          onClose={handleHostKeyDialogClose}
        />
      )}

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
