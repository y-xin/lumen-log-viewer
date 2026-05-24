// 统一设置面板：4 tab — 通用 / 颜色 / 快捷键 / 模板
// 视觉偏好走 prefs.json（后端存储，多窗同步），字号走 zustand+prefs.json，
// 模板入口跳现有 TemplateManagerDialog，快捷键暂只读

import { useState, useEffect } from 'react';
import { useSession } from '../state/session';
import {
  loadUiPrefs, saveUiPrefs,
  ACCENT_PALETTE, HIGHLIGHT_PALETTE, DEFAULT,
  type UiPrefs, type Theme, type AccentName, type HighlightName,
} from '../lib/uiPrefs';

interface Props {
  onClose: () => void;
  onOpenTemplateManager: () => void;
}

type Tab = 'general' | 'colors' | 'shortcuts' | 'templates';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const M = isMac ? '⌘' : 'Ctrl';

const SHORTCUT_ROWS: Array<{ keys: string; desc: string }> = [
  { keys: `${M} O`, desc: '打开文件' },
  { keys: `${M} R`, desc: '刷新当前查询' },
  { keys: `${M} F`, desc: '聚焦关键词搜索' },
  { keys: `${M} K`, desc: '清空所有筛选' },
  { keys: `${M} T`, desc: '切换实时跟踪' },
  { keys: `${M} E`, desc: '打开导出菜单' },
  { keys: `${M} S`, desc: '打开 saved-filter 菜单' },
  { keys: `${M} G`, desc: '跳到行号' },
  { keys: `${M} =`, desc: '日志字号 +' },
  { keys: `${M} -`, desc: '日志字号 -' },
  { keys: `${M} 0`, desc: '日志字号重置' },
  { keys: `${M} ,`, desc: '打开设置' },
  { keys: '↑ / ↓',  desc: '详情抽屉打开时 — 切上/下一条' },
  { keys: '?',      desc: '快捷键帮助' },
  { keys: 'Esc',    desc: '关闭抽屉 / 弹窗 / 本设置' },
];

export function SettingsDialog({ onClose, onOpenTemplateManager }: Props) {
  const [tab, setTab] = useState<Tab>('general');
  const [ui, setUi] = useState<UiPrefs>(DEFAULT);
  const fontSize = useSession((s) => s.fontSize);

  useEffect(() => {
    loadUiPrefs().then(setUi);
  }, []);
  const setFontSize = useSession((s) => s.setFontSize);

  const updateUi = (patch: Partial<UiPrefs>) => {
    const next = { ...ui, ...patch };
    setUi(next);
    saveUiPrefs(next).catch(() => {});
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white rounded shadow-xl w-[680px] max-w-[90vw] h-[480px] flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧 tab 列 */}
        <aside className="w-32 border-r bg-slate-50 flex flex-col text-sm">
          <div className="px-3 py-2 font-semibold text-slate-700 border-b">设置</div>
          {([
            ['general',   '通用'],
            ['colors',    '颜色'],
            ['shortcuts', '快捷键'],
            ['templates', '模板'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={[
                'px-3 py-2 text-left hover:bg-slate-100',
                tab === k ? 'bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-500' : 'text-slate-600',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
          <div className="mt-auto px-3 py-2 text-[10px] text-slate-400 border-t">
            设置实时生效
          </div>
        </aside>

        {/* 右侧内容 */}
        <section className="flex-1 flex flex-col overflow-hidden">
          <header className="flex items-center justify-between px-4 py-2 border-b">
            <h3 className="text-sm font-semibold">
              {tab === 'general' && '通用'}
              {tab === 'colors' && '颜色'}
              {tab === 'shortcuts' && '快捷键'}
              {tab === 'templates' && '解析模板'}
            </h3>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-700">✕</button>
          </header>
          <div className="flex-1 overflow-y-auto p-4 text-sm space-y-5">
            {tab === 'general' && (
              <>
                <Section title="日志字号" hint={`${fontSize}px（范围 10-20，⌘+ / ⌘- / ⌘0 也可调）`}>
                  <input
                    type="range" min={10} max={20} step={1}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="w-full"
                  />
                  <div className="flex items-center gap-2 mt-2">
                    <button onClick={() => setFontSize(12)} className="ctl">重置（12px）</button>
                    <span className="text-xs text-slate-400">影响 LogList 行 + 详情 Message/Raw</span>
                  </div>
                </Section>

                <Section title="主题" hint="dark 模式当前为实验性 — 仅根背景 / 文本切换，部分组件保留浅色">
                  <ThemeRadio value={ui.theme} onChange={(theme) => updateUi({ theme })} />
                </Section>
              </>
            )}

            {tab === 'colors' && (
              <>
                <Section title="主色调（accent）" hint="影响 .ctl-primary / 选中态 / focus ring / 选区蓝条">
                  <SwatchRow
                    options={(Object.keys(ACCENT_PALETTE) as AccentName[]).map((k) => ({
                      key: k, label: ACCENT_PALETTE[k].name, color: ACCENT_PALETTE[k].main,
                    }))}
                    value={ui.accent}
                    onChange={(accent) => updateUi({ accent: accent as AccentName })}
                  />
                </Section>

                <Section title="关键词高亮色" hint="影响搜索命中的 <mark> 背景色">
                  <SwatchRow
                    options={(Object.keys(HIGHLIGHT_PALETTE) as HighlightName[]).map((k) => ({
                      key: k, label: HIGHLIGHT_PALETTE[k].name, color: HIGHLIGHT_PALETTE[k].bg,
                    }))}
                    value={ui.highlight}
                    onChange={(h) => updateUi({ highlight: h as HighlightName })}
                  />
                  <div className="mt-2 text-xs text-slate-500">
                    预览：<mark className="px-0.5 rounded-sm" style={{ backgroundColor: 'var(--hl-bg)', color: 'var(--hl-text)' }}>matched word</mark>
                  </div>
                </Section>
              </>
            )}

            {tab === 'shortcuts' && (
              <>
                <div className="text-xs text-slate-500 mb-2">
                  目前快捷键为内置，暂不支持自定义改键（计划 v2 支持）
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {SHORTCUT_ROWS.map((it) => (
                      <tr key={it.keys} className="border-b border-slate-100 last:border-b-0">
                        <td className="py-1.5 pr-4 font-mono text-slate-700 whitespace-nowrap">{it.keys}</td>
                        <td className="py-1.5 text-slate-600">{it.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {tab === 'templates' && (
              <>
                <div className="text-xs text-slate-500 mb-3">
                  管理 7 种内置 + 任意数量自定义解析模板。支持新建 / 编辑 / 删除 / 导入 / 导出 JSON。
                </div>
                <button
                  onClick={() => { onClose(); onOpenTemplateManager(); }}
                  className="ctl ctl-primary"
                >
                  打开模板管理器 →
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="font-medium text-slate-800">{title}</h4>
        {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function ThemeRadio({ value, onChange }: { value: Theme; onChange: (v: Theme) => void }) {
  return (
    <div className="flex gap-2">
      {([['light', '☀ 亮色'], ['dark', '🌙 暗色（实验性）']] as Array<[Theme, string]>).map(([k, label]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className={['ctl', value === k ? 'ctl-primary' : ''].join(' ')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function SwatchRow({
  options, value, onChange,
}: {
  options: Array<{ key: string; label: string; color: string }>;
  value: string;
  onChange: (k: string) => void;
}) {
  return (
    <div className="flex gap-2">
      {options.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={[
            'flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-all',
            value === opt.key ? 'border-slate-700 ring-2 ring-slate-300' : 'border-slate-200 hover:border-slate-400',
          ].join(' ')}
          title={opt.label}
        >
          <span className="inline-block w-4 h-4 rounded" style={{ backgroundColor: opt.color }} />
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
