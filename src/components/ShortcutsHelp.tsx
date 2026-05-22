// 快捷键一览 modal：?/Esc/遮罩点击 → 关
// 显示由 useSession.helpOpen 控制；toggle 由 useGlobalShortcuts 处理

import { useSession } from '../state/session';

interface Item { keys: string; desc: string; }

// macOS 显示 ⌘，其他平台显示 Ctrl
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const M = isMac ? '⌘' : 'Ctrl';

const ITEMS: Item[] = [
  { keys: `${M} O`, desc: '打开文件' },
  { keys: `${M} R`, desc: '刷新当前查询' },
  { keys: `${M} F`, desc: '聚焦关键词搜索' },
  { keys: `${M} K`, desc: '清空所有筛选' },
  { keys: `${M} T`, desc: '切换实时跟踪' },
  { keys: `${M} E`, desc: '打开导出菜单' },
  { keys: `${M} S`, desc: '打开 saved-filter 菜单' },
  { keys: `${M} =`, desc: '日志字号 +' },
  { keys: `${M} -`, desc: '日志字号 -' },
  { keys: `${M} 0`, desc: '日志字号重置' },
  { keys: '?',      desc: '本帮助' },
  { keys: 'Esc',    desc: '关闭抽屉 / 弹窗 / 本帮助' },
];

export function ShortcutsHelp() {
  const { helpOpen, setHelpOpen } = useSession();
  if (!helpOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
      onClick={() => setHelpOpen(false)}
    >
      <div
        className="bg-white rounded shadow-xl p-5 min-w-[360px] max-w-[480px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">键盘快捷键</h3>
          <button onClick={() => setHelpOpen(false)} className="text-slate-400 hover:text-slate-700" title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <table className="w-full text-xs">
          <tbody>
            {ITEMS.map((it) => (
              <tr key={it.keys} className="border-b border-slate-100 last:border-b-0">
                <td className="py-1.5 pr-4 font-mono text-slate-700 whitespace-nowrap">{it.keys}</td>
                <td className="py-1.5 text-slate-600">{it.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
