// FilterBar 末尾的"保存筛选"下拉：按文件路径独立管理 SavedFilter
// 应用 saved 时只 patch levels / scope_filter / text_search
// time_range 与 scope_in 保持不变（瞬时探索语义）

import { useEffect, useState } from 'react';
import {
  listSavedFilters,
  saveFilter,
  deleteSavedFilter,
  renameSavedFilter,
} from '../api/commands';
import { useSession } from '../state/session';
import type { SavedFilter } from '../types/log';

type View = 'list' | 'save' | 'manage';

// 判断当前 spec 三项是否与 saved filter 严格一致（用于 ✓ 高亮）
function specMatches(
  s: { levels?: string[] | null; scope_filter?: object | null; text_search?: string | null },
  f: SavedFilter,
): boolean {
  const norm = <T,>(v: T | null | undefined): T | null => (v == null ? null : v);
  return (
    JSON.stringify(norm(s.levels)?.slice().sort()) ===
      JSON.stringify(norm(f.levels)?.slice().sort()) &&
    JSON.stringify(norm(s.scope_filter)) === JSON.stringify(norm(f.scope_filter)) &&
    norm(s.text_search) === norm(f.text_search)
  );
}

export function SavedFiltersMenu() {
  const { spec, metadata, patchSpec, setError } = useSession();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('list');
  const [filters, setFilters] = useState<SavedFilter[]>([]);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const path = metadata?.path ?? null;

  // 打开 / 路径变化时刷新
  useEffect(() => {
    if (!open || !path) return;
    listSavedFilters(path).then(setFilters).catch((e) => setError(String(e)));
  }, [open, path, setError]);

  if (!metadata || !path) return null;

  const close = () => {
    setOpen(false);
    setView('list');
    setNewName('');
    setEditingId(null);
  };

  const handleSave = async () => {
    if (!newName.trim() || !path) return;
    const filter: SavedFilter = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      created_at: new Date().toISOString(),
      levels: spec.levels ?? null,
      scope_filter: spec.scope_filter ?? null,
      text_search: spec.text_search ?? null,
    };
    try {
      const updated = await saveFilter(path, filter);
      setFilters(updated);
      setNewName('');
      setView('list');
    } catch (e) {
      setError(String(e));
    }
  };

  const canSave =
    newName.trim().length > 0 &&
    (spec.levels != null || spec.scope_filter != null || spec.text_search != null);

  const handleDelete = async (id: string) => {
    if (!path) return;
    if (!confirm('删除这个筛选器？')) return;
    try {
      const updated = await deleteSavedFilter(path, id);
      setFilters(updated);
    } catch (e) {
      setError(String(e));
    }
  };

  const startRename = (f: SavedFilter) => {
    setEditingId(f.id);
    setEditName(f.name);
  };

  const commitRename = async () => {
    if (!editingId || !editName.trim() || !path) {
      setEditingId(null);
      return;
    }
    try {
      const updated = await renameSavedFilter(path, editingId, editName.trim());
      setFilters(updated);
    } catch (e) {
      setError(String(e));
    } finally {
      setEditingId(null);
    }
  };

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="ctl" title="保存的筛选器">
        📌 筛选器 ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute top-full right-0 mt-1 w-80 bg-white border rounded shadow-lg z-20 text-xs">
            {view === 'list' && (
              <>
                <div className="px-3 py-1.5 text-slate-500 border-b">当前文件的筛选器</div>
                {filters.length === 0 && (
                  <div className="px-3 py-3 text-slate-400 italic">(无)</div>
                )}
                {filters.map((f) => {
                  const active = specMatches(spec, f);
                  return (
                    <button
                      key={f.id}
                      onClick={() => {
                        patchSpec({
                          levels: f.levels ?? undefined,
                          scope_filter: f.scope_filter,
                          text_search: f.text_search,
                        });
                        close();
                      }}
                      className={[
                        'w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center gap-2',
                        active ? 'bg-blue-50 font-medium text-blue-700' : '',
                      ].join(' ')}
                    >
                      <span className="w-3 inline-block">{active ? '✓' : ''}</span>
                      <span className="truncate flex-1">{f.name}</span>
                    </button>
                  );
                })}
                <div className="border-t">
                  <button
                    onClick={() => setView('save')}
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700"
                  >
                    + 保存当前筛选...
                  </button>
                  <button
                    onClick={() => setView('manage')}
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={filters.length === 0}
                  >
                    ⚙ 管理...
                  </button>
                </div>
              </>
            )}

            {view === 'save' && (
              <div className="p-3 space-y-2">
                <div className="text-slate-500">保存当前筛选为：</div>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSave) handleSave();
                  }}
                  placeholder="筛选器名字"
                  autoFocus
                  className="input-ctl w-full"
                />
                <div className="flex gap-2">
                  <button onClick={handleSave} disabled={!canSave} className="ctl ctl-primary">
                    保存
                  </button>
                  <button
                    onClick={() => {
                      setView('list');
                      setNewName('');
                    }}
                    className="ctl ml-auto"
                  >
                    取消
                  </button>
                </div>
                {!canSave && newName.trim() && (
                  <div className="text-slate-400 italic">当前 spec 三项都为空，无可保存内容</div>
                )}
              </div>
            )}

            {view === 'manage' && (
              <>
                <div className="px-3 py-1.5 text-slate-500 border-b flex items-center">
                  <span>管理筛选器</span>
                  <button
                    onClick={() => {
                      setView('list');
                      setEditingId(null);
                    }}
                    className="ml-auto text-slate-400 hover:text-slate-700"
                  >
                    ← 返回
                  </button>
                </div>
                {filters.map((f) => (
                  <div
                    key={f.id}
                    className="px-3 py-1.5 border-b last:border-b-0 flex items-center gap-2"
                  >
                    {editingId === f.id ? (
                      <>
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename();
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          autoFocus
                          className="input-ctl flex-1"
                        />
                        <button onClick={commitRename} className="ctl ctl-primary">
                          保存
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="truncate flex-1">{f.name}</span>
                        <button
                          onClick={() => startRename(f)}
                          className="text-slate-500 hover:text-slate-800"
                          title="重命名"
                        >
                          ✎
                        </button>
                        <button
                          onClick={() => handleDelete(f.id)}
                          className="text-red-500 hover:text-red-700"
                          title="删除"
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
