// ⌘G 跳到指定行号：modal 输入数字 → 滚动列表到匹配 entry
// 行号 = entry.line_no（文件原始行号）。不在当前 matched 集时显示提示，让用户清筛选再试。
// 通过 lv:goto-line CustomEvent 触发 LogList 内部 scroll。

import { useEffect, useState } from 'react';
import { useSession } from '../state/session';

export function GotoLineDialog() {
  const { gotoOpen, setGotoOpen } = useSession();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (gotoOpen) { setInput(''); setError(null); }
  }, [gotoOpen]);

  if (!gotoOpen) return null;

  const handleSubmit = () => {
    const n = Number(input);
    if (!Number.isInteger(n) || n < 1) {
      setError('请输入正整数行号');
      return;
    }
    window.dispatchEvent(new CustomEvent('lv:goto-line', { detail: { lineNo: n } }));
    setGotoOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={() => setGotoOpen(false)}>
      <div
        className="bg-white rounded shadow-xl p-4 min-w-[280px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-2">跳到行号</div>
        <input
          autoFocus
          type="number"
          min={1}
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
            if (e.key === 'Escape') setGotoOpen(false);
          }}
          placeholder="例如：1234"
          className="input-ctl w-full"
        />
        {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
        <div className="mt-3 flex gap-2">
          <button onClick={handleSubmit} className="ctl ctl-primary">跳转</button>
          <button onClick={() => setGotoOpen(false)} className="ctl ml-auto">取消</button>
        </div>
      </div>
    </div>
  );
}
