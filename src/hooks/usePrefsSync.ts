// 监听后端 lv:prefs-changed 事件 → 按 payload kind 触发对应 refetch
// 只订阅 zustand-cached 状态（ui / templates / font_size）
// saved_filters / recent_files / column_prefs 走 menu lazy-load，不订阅

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { loadUiPrefs, applyUiPrefs } from '../lib/uiPrefs';
import { getFontSize } from '../api/commands';
import { useSession } from '../state/session';

type PrefsKind = 'ui' | 'templates' | 'saved_filters' | 'recent_files' | 'column_prefs' | 'font_size' | 'ssh_hosts';

export function usePrefsSync(): void {
  useEffect(() => {
    const unlistenP = listen<PrefsKind>('lv:prefs-changed', ({ payload }) => {
      switch (payload) {
        case 'ui':
          loadUiPrefs().then(applyUiPrefs);
          break;
        case 'templates':
          useSession.getState().refetchTemplates?.();
          break;
        case 'font_size':
          getFontSize().then((n) => { if (typeof n === 'number') useSession.getState().setFontSize(n); });
          break;
        case 'ssh_hosts': break; // lazy-load — Settings 远程 tab 打开时重读
        // saved_filters / recent_files / column_prefs: lazy-load 模式
        default:
          break;
      }
    });
    return () => { unlistenP.then((f) => f()).catch(() => {}); };
  }, []);
}
