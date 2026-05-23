// 视觉偏好（主题 / 强调色 / 高亮色）的本地持久化
// 选 localStorage 而不是 prefs.json 的原因：这些偏好 (a) 不需要跨设备同步
// (b) 启动时需立即生效（无后端等待）(c) 避免再加 6 个 tauri cmd
//
// 字段：
//   - theme: 'light' | 'dark'   — dark 当前是"实验性" 半完成
//   - accent: 主色调（影响 .ctl-primary / 选中态 / focus ring）
//   - highlight: 关键词命中色（HighlightedText / mark）

export type Theme = 'light' | 'dark';
export type AccentName = 'blue' | 'violet' | 'teal' | 'rose';
export type HighlightName = 'yellow' | 'emerald' | 'pink' | 'sky';

export interface UiPrefs {
  theme: Theme;
  accent: AccentName;
  highlight: HighlightName;
}

const KEY = 'lv:ui-prefs';

const DEFAULT: UiPrefs = { theme: 'light', accent: 'blue', highlight: 'yellow' };

// ─── 色板（CSS 值，注入到 :root 的 var） ──────────────────
// bg: 亮色模式选中态浅底（蓝 50 / 紫 50 …）
// bgDark: 暗色模式选中态 — 半透明 accent，叠在 surface 上既不发白也不糊
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

export function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw);
    return {
      theme:     parsed.theme === 'dark' ? 'dark' : 'light',
      accent:    (parsed.accent in ACCENT_PALETTE) ? parsed.accent : DEFAULT.accent,
      highlight: (parsed.highlight in HIGHLIGHT_PALETTE) ? parsed.highlight : DEFAULT.highlight,
    };
  } catch {
    return DEFAULT;
  }
}

export function saveUiPrefs(p: UiPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* localStorage 满或被禁 */ }
}

/** 把当前 prefs 应用到 :root —— 设 data-theme + 注入 CSS var */
export function applyUiPrefs(p: UiPrefs): void {
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  const a = ACCENT_PALETTE[p.accent];
  const h = HIGHLIGHT_PALETTE[p.highlight];
  root.style.setProperty('--accent',       a.main);
  root.style.setProperty('--accent-hover', a.hover);
  // dark 走半透明 accent —— 避免浅色蓝 50 在暗底发白
  root.style.setProperty('--accent-bg',    p.theme === 'dark' ? a.bgDark : a.bg);
  root.style.setProperty('--hl-bg',        h.bg);
  root.style.setProperty('--hl-text',      h.text);
}
