// 视觉偏好（主题 / 强调色 / 高亮色）的本地持久化
// v2：从 localStorage 迁到 prefs.json（多窗口跨窗同步）
// 启动序列：同步立即 apply DEFAULT → 异步拉真实值 reapply

import { getUiPrefs as apiGetUi, saveUiPrefs as apiSaveUi } from '../api/commands';

export type Theme = 'light' | 'dark';
export type AccentName = 'blue' | 'violet' | 'teal' | 'rose';
export type HighlightName = 'yellow' | 'emerald' | 'pink' | 'sky';

export interface UiPrefs {
  theme: Theme;
  accent: AccentName;
  highlight: HighlightName;
}

const LEGACY_KEY = 'lv:ui-prefs';
export const DEFAULT: UiPrefs = { theme: 'light', accent: 'blue', highlight: 'yellow' };

export const ACCENT_PALETTE: Record<AccentName, { name: string; main: string; hover: string; bg: string; bgDark: string }> = {
  blue:   { name: '蓝',    main: '#2563eb', hover: '#1d4ed8', bg: '#eff6ff', bgDark: 'rgba(37,99,235,0.22)' },
  violet: { name: '紫',    main: '#7c3aed', hover: '#6d28d9', bg: '#f5f3ff', bgDark: 'rgba(124,58,237,0.22)' },
  teal:   { name: '青',    main: '#0d9488', hover: '#0f766e', bg: '#f0fdfa', bgDark: 'rgba(13,148,136,0.24)' },
  rose:   { name: '玫红',  main: '#e11d48', hover: '#be123c', bg: '#fff1f2', bgDark: 'rgba(225,29,72,0.22)' },
};

export const HIGHLIGHT_PALETTE: Record<HighlightName, { name: string; bg: string; text: string }> = {
  yellow:  { name: '黄',    bg: '#fef08a', text: '#0f172a' },
  emerald: { name: '绿',    bg: '#a7f3d0', text: '#064e3b' },
  pink:    { name: '粉',    bg: '#fbcfe8', text: '#831843' },
  sky:     { name: '天蓝',  bg: '#bae6fd', text: '#0c4a6e' },
};

function normalize(raw: { theme: string; accent: string; highlight: string }): UiPrefs {
  return {
    theme:     raw.theme === 'dark' ? 'dark' : 'light',
    accent:    (raw.accent in ACCENT_PALETTE)       ? raw.accent as AccentName    : DEFAULT.accent,
    highlight: (raw.highlight in HIGHLIGHT_PALETTE) ? raw.highlight as HighlightName : DEFAULT.highlight,
  };
}

/** 从后端拉 — async，启动时和 prefs-changed 时调 */
export async function loadUiPrefs(): Promise<UiPrefs> {
  try {
    const raw = await apiGetUi();
    return normalize(raw);
  } catch {
    return DEFAULT;
  }
}

/** 写入后端（成功后后端会 emit_to_all 广播触发各窗 reapply） */
export async function saveUiPrefs(p: UiPrefs): Promise<void> {
  await apiSaveUi({ theme: p.theme, accent: p.accent, highlight: p.highlight });
}

/** 把当前 prefs 应用到 :root —— 设 data-theme + 注入 CSS var */
export function applyUiPrefs(p: UiPrefs): void {
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  const a = ACCENT_PALETTE[p.accent];
  const h = HIGHLIGHT_PALETTE[p.highlight];
  root.style.setProperty('--accent',       a.main);
  root.style.setProperty('--accent-hover', a.hover);
  root.style.setProperty('--accent-bg',    p.theme === 'dark' ? a.bgDark : a.bg);
  root.style.setProperty('--hl-bg',        h.bg);
  root.style.setProperty('--hl-text',      h.text);
}

/** 一次性 localStorage → 后端 迁移；首次启动新版本时跑一次 */
export async function migrateLegacyLocalStorage(): Promise<void> {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const cur = await apiGetUi();
    // 后端已有非空值时不覆盖（用户已经在新版本里手动设过）
    if (cur.theme || cur.accent || cur.highlight) {
      localStorage.removeItem(LEGACY_KEY);
      return;
    }
    await apiSaveUi({
      theme:     parsed.theme || '',
      accent:    parsed.accent || '',
      highlight: parsed.highlight || '',
    });
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* 迁移失败静默；下次保存会覆盖 */ }
}
