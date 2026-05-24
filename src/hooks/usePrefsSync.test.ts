import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// mock @tauri-apps/api/event
const listeners: Array<(evt: { payload: string }) => void> = [];
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_name: string, cb: (evt: { payload: string }) => void) => {
    listeners.push(cb);
    return Promise.resolve(() => {
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    });
  }),
}));

// 用 vi.hoisted 避免 hoisting 导致的 TDZ 问题
const { applyUiPrefs, loadUiPrefs, getFontSize, setFontSize, refetchTemplates } = vi.hoisted(() => ({
  applyUiPrefs: vi.fn(),
  loadUiPrefs: vi.fn(async () => ({ theme: 'dark', accent: 'blue', highlight: 'yellow' })),
  getFontSize: vi.fn(async () => 14),
  setFontSize: vi.fn(),
  refetchTemplates: vi.fn(),
}));

vi.mock('../lib/uiPrefs', () => ({ applyUiPrefs, loadUiPrefs }));
vi.mock('../api/commands', () => ({ getFontSize }));
vi.mock('../state/session', () => ({
  useSession: {
    getState: () => ({ setFontSize, refetchTemplates }),
  },
}));

import { usePrefsSync } from './usePrefsSync';

describe('usePrefsSync', () => {
  beforeEach(() => {
    listeners.length = 0;
    applyUiPrefs.mockClear();
    loadUiPrefs.mockClear();
    getFontSize.mockClear();
    setFontSize.mockClear();
    refetchTemplates.mockClear();
  });

  it('payload=ui triggers loadUiPrefs + applyUiPrefs', async () => {
    renderHook(() => usePrefsSync());
    await Promise.resolve();
    expect(listeners.length).toBe(1);
    listeners[0]({ payload: 'ui' });
    await Promise.resolve();
    expect(loadUiPrefs).toHaveBeenCalled();
    await Promise.resolve();
    expect(applyUiPrefs).toHaveBeenCalledWith({ theme: 'dark', accent: 'blue', highlight: 'yellow' });
  });

  it('payload=font_size refetches and updates store', async () => {
    renderHook(() => usePrefsSync());
    await Promise.resolve();
    listeners[0]({ payload: 'font_size' });
    await Promise.resolve();
    expect(getFontSize).toHaveBeenCalled();
    await Promise.resolve();
    expect(setFontSize).toHaveBeenCalledWith(14);
  });

  it('payload=saved_filters / recent_files / column_prefs are ignored', async () => {
    renderHook(() => usePrefsSync());
    await Promise.resolve();
    listeners[0]({ payload: 'saved_filters' });
    listeners[0]({ payload: 'recent_files' });
    listeners[0]({ payload: 'column_prefs' });
    await Promise.resolve();
    expect(loadUiPrefs).not.toHaveBeenCalled();
    expect(getFontSize).not.toHaveBeenCalled();
    expect(refetchTemplates).not.toHaveBeenCalled();
  });
});
