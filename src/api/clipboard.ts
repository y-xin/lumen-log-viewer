// 复制文本到系统剪贴板。
//
// 背景：Tauri 的 macOS WKWebView 里 navigator.clipboard.writeText 经常 reject
// （安全上下文/焦点限制），旧代码 .catch(()=>{}) 把失败吞掉 → 点了没反应。
// 这里优先用异步剪贴板 API（dev 浏览器可用），失败再退回临时 textarea + execCommand，
// 后者走 macOS 原生响应链（与已恢复的 Edit 菜单 copy 同路径），在 WKWebView 下可靠。
// 返回是否成功，调用方可据此给"已复制/复制失败"反馈。

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的兜底
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  // 全局 body{user-select:none}，但 CSS 已把 input/textarea 列入可选区，故无需额外覆盖。
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  // 复位焦点，避免打断详情面板的 Esc / ↑↓ 导航
  prev?.focus?.();
  return ok;
}
