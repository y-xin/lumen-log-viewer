// 模板管理模态：左侧列表 + 右侧表单 + 试解析预览

import { useEffect, useState } from 'react';
import {
  listTemplates, saveCustomTemplate, deleteCustomTemplate, testTemplate,
} from '../api/commands';
import { useSession } from '../state/session';
import type { CustomTemplate, TemplateInfo, TestResult, TailParserKind } from '../types/log';

interface Props {
  onClose: () => void;
}

const EMPTY_TEMPLATE: CustomTemplate = {
  id: '',
  name: '',
  pattern: '',
  start_pattern: '',
  time_formats: [],
  field_map: { timestamp: null, level: null, scope: null, message: null },
  tail_parser: 'none',
};

export function TemplateManagerDialog({ onClose }: Props) {
  const { setTemplates: setStoreTemplates } = useSession();
  const [list, setList] = useState<TemplateInfo[]>([]);
  const [editing, setEditing] = useState<CustomTemplate>(EMPTY_TEMPLATE);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    const ts = await listTemplates();
    setList(ts);
    setStoreTemplates(ts);
  };
  useEffect(() => { refresh(); }, []);

  const startNew = () => {
    setEditing(EMPTY_TEMPLATE);
    setTestResult(null);
    setError(null);
  };

  const startEdit = (info: TemplateInfo) => {
    if (info.builtin) {
      setError('内置模板不可编辑（只能复制为新模板）');
      return;
    }
    setError('编辑自定义模板：MVP 阶段请删除后重建');
  };

  const handleTest = async () => {
    setError(null);
    setTestResult(null);
    try {
      const r = await testTemplate(editing, 10);
      setTestResult(r);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    }
  };

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await saveCustomTemplate(editing);
      await refresh();
      setEditing(EMPTY_TEMPLATE);
      setTestResult(null);
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await deleteCustomTemplate(id);
      await refresh();
    } catch (e) {
      setError(typeof e === 'string' ? e : JSON.stringify(e));
    }
  };

  const updateField = <K extends keyof CustomTemplate>(k: K, v: CustomTemplate[K]) => {
    setEditing((prev) => ({ ...prev, [k]: v }));
  };

  const updateFieldMap = (k: keyof CustomTemplate['field_map'], v: string) => {
    setEditing((prev) => ({ ...prev, field_map: { ...prev.field_map, [k]: v || null } }));
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30">
      <div className="bg-white w-[70vw] h-[80vh] rounded shadow-xl flex flex-col">
        <header className="flex items-center justify-between px-4 py-2 border-b">
          <h2 className="font-semibold">模板管理</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700">✕</button>
        </header>
        <div className="flex-1 flex overflow-hidden">
          <aside className="w-56 border-r overflow-y-auto p-2 text-sm">
            <div className="text-xs text-slate-500 px-2 py-1">内置（只读）</div>
            {list.filter((t) => t.builtin).map((t) => (
              <button
                key={t.id}
                onClick={() => startEdit(t)}
                className="w-full text-left px-2 py-1 rounded hover:bg-slate-100"
              >
                {t.name}
              </button>
            ))}
            <div className="text-xs text-slate-500 px-2 py-1 mt-3">自定义</div>
            {list.filter((t) => !t.builtin).length === 0 && (
              <div className="px-2 py-1 text-slate-400 italic">(空)</div>
            )}
            {list.filter((t) => !t.builtin).map((t) => (
              <div key={t.id} className="flex items-center gap-1">
                <button
                  onClick={() => startEdit(t)}
                  className="flex-1 text-left px-2 py-1 rounded hover:bg-slate-100"
                >
                  {t.name}
                </button>
                <button
                  onClick={() => handleDelete(t.id)}
                  className="px-1 text-red-500 hover:bg-red-50 rounded"
                  title="删除"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={startNew}
              className="w-full mt-3 px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              + 新建自定义
            </button>
          </aside>

          <section className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
            {error && <div className="px-3 py-2 bg-red-50 text-red-700 rounded">{error}</div>}

            <Field label="名称">
              <input
                value={editing.name}
                onChange={(e) => updateField('name', e.target.value)}
                className="w-full border rounded px-2 py-1"
              />
            </Field>
            <Field label="模板 ID">
              <input
                value={editing.id}
                onChange={(e) => updateField('id', e.target.value)}
                className="w-full border rounded px-2 py-1 font-mono text-xs"
                placeholder="my-renderer-log"
              />
            </Field>
            <Field label="正则（命名捕获组）">
              <textarea
                value={editing.pattern}
                onChange={(e) => updateField('pattern', e.target.value)}
                rows={3}
                className="w-full border rounded px-2 py-1 font-mono text-xs"
                placeholder="^\[(?P<ts>[^\]]+)\] \[(?P<level>[^\]]+)\] (?P<message>.*)$"
              />
            </Field>
            <Field label="起始行正则">
              <input
                value={editing.start_pattern}
                onChange={(e) => updateField('start_pattern', e.target.value)}
                className="w-full border rounded px-2 py-1 font-mono text-xs"
                placeholder="^\[\d{4}-\d{2}-\d{2}"
              />
            </Field>
            <Field label="时间格式（每行一个 chrono format string）">
              <textarea
                value={editing.time_formats.join('\n')}
                onChange={(e) => updateField('time_formats', e.target.value.split('\n').filter((s) => s.trim()))}
                rows={2}
                className="w-full border rounded px-2 py-1 font-mono text-xs"
                placeholder="%Y-%m-%d %H:%M:%S%.3f"
              />
            </Field>

            <div className="space-y-1">
              <div className="text-xs text-slate-500">字段映射（→ 正则里的命名捕获组）</div>
              {(['timestamp', 'level', 'scope', 'message'] as const).map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <span className="w-20 text-xs">{k}</span>
                  <input
                    value={editing.field_map[k] ?? ''}
                    onChange={(e) => updateFieldMap(k, e.target.value)}
                    className="flex-1 border rounded px-2 py-0.5 font-mono text-xs"
                    placeholder={k}
                  />
                </div>
              ))}
            </div>

            <Field label="Tail 解析">
              <select
                value={editing.tail_parser}
                onChange={(e) => updateField('tail_parser', e.target.value as TailParserKind)}
                className="border rounded px-2 py-1"
              >
                <option value="none">无</option>
                <option value="json_object">严格 JSON</option>
                <option value="json_like">JsonLike（JSON + JSON5 + raw 兜底）</option>
              </select>
            </Field>

            <div className="flex gap-2 pt-2">
              <button onClick={handleTest} className="ctl">测试解析</button>
              <button
                onClick={handleSave}
                disabled={saving || !editing.id || !editing.pattern}
                className="ctl ctl-primary"
              >
                {saving ? '保存中…' : '保存'}
              </button>
              <button onClick={onClose} className="ctl ml-auto">取消</button>
            </div>

            {testResult && (
              <div className="border rounded p-2 mt-2">
                <div className="text-xs text-slate-500 mb-1">
                  命中率 {(testResult.hit_rate * 100).toFixed(0)}% · 字段完整度 {(testResult.field_completeness * 100).toFixed(0)}%
                </div>
                <ul className="space-y-0.5">
                  {testResult.samples.map((s) => (
                    <li key={s.line_no} className="font-mono text-xs flex gap-2">
                      <span className="text-slate-400 w-12">#{s.line_no}{s.line_count > 1 ? `-${s.line_no + s.line_count - 1}` : ''}</span>
                      <span className={s.ok ? 'text-green-600' : 'text-red-600'}>{s.ok ? '✓' : '✗'}</span>
                      <span className="truncate flex-1">{s.ok ? `${s.level} [${s.scope ?? '-'}] ${s.message}` : s.raw.slice(0, 80)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500 mb-0.5">{label}</div>
      {children}
    </div>
  );
}
