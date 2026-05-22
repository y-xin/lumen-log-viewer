// 顶部模板下拉：显示当前模板 + 列出所有可选 + "管理模板" 入口

import { useEffect, useState } from 'react';
import { listTemplates, reparseWithTemplate } from '../api/commands';
import { useSession } from '../state/session';

interface Props {
  onOpenManager: () => void;
}

export function TemplateMenu({ onOpenManager }: Props) {
  const { templates, setTemplates, currentTemplateId, metadata, setMetadata, setError } = useSession();
  const [open, setOpen] = useState(false);

  // 文件打开后刷新模板列表（自定义模板可能在管理器里新增）
  useEffect(() => {
    if (!metadata) return;
    listTemplates().then(setTemplates).catch((e) => setError(String(e)));
  }, [metadata, setTemplates, setError]);

  if (!metadata) return null;

  const builtins = templates.filter((t) => t.builtin);
  const customs = templates.filter((t) => !t.builtin);
  const current = templates.find((t) => t.id === currentTemplateId);

  const reparse = async (id: string) => {
    setOpen(false);
    if (id === currentTemplateId) return;
    try {
      const md = await reparseWithTemplate(id);
      setMetadata(md);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-1.5 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50"
      >
        模板：{current?.name ?? currentTemplateId ?? '—'} ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-64 bg-white border rounded shadow-lg z-20 text-sm">
            <div className="px-3 py-1 text-xs text-slate-500 border-b">内置</div>
            {builtins.map((t) => (
              <button
                key={t.id}
                onClick={() => reparse(t.id)}
                className={[
                  'w-full text-left px-3 py-1.5 hover:bg-slate-100',
                  t.id === currentTemplateId ? 'font-semibold text-blue-700' : '',
                ].join(' ')}
              >
                {t.id === currentTemplateId ? '✓ ' : '  '}{t.name}
              </button>
            ))}
            {customs.length > 0 && (
              <>
                <div className="px-3 py-1 text-xs text-slate-500 border-t border-b">自定义</div>
                {customs.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => reparse(t.id)}
                    className={[
                      'w-full text-left px-3 py-1.5 hover:bg-slate-100',
                      t.id === currentTemplateId ? 'font-semibold text-blue-700' : '',
                    ].join(' ')}
                  >
                    {t.id === currentTemplateId ? '✓ ' : '  '}{t.name}
                  </button>
                ))}
              </>
            )}
            <div className="border-t">
              <button
                onClick={() => { setOpen(false); onOpenManager(); }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700"
              >
                ⚙ 管理模板…
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
