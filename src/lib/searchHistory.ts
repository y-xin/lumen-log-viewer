// 关键词搜索历史：localStorage 持久；最多保留 10 个，最新在前；去重大小写敏感
// 给 FilterBar 关键词 input 的 datalist 用

const KEY = 'lv:search-history';
const MAX = 10;

export function getSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function pushSearchHistory(term: string): void {
  const t = term.trim();
  if (!t) return;
  try {
    const prev = getSearchHistory();
    const next = [t, ...prev.filter((s) => s !== t)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 容忍：localStorage 满 / 禁用 等
  }
}

export function clearSearchHistory(): void {
  try { localStorage.removeItem(KEY); } catch {}
}
