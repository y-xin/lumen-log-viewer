// 筛选栏：level toggle + scope（字段+模式+模式选择） + 关键词 + 时间区间
// 输入有 150ms debounce，对外通过 useSession 的 patchSpec 暴露

import { useEffect, useMemo, useRef, useState } from 'react';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { useSession } from '../state/session';
import type { LogLevel, MatchMode } from '../types/log';
import { ExportMenu } from './ExportMenu';
import { SavedFiltersMenu } from './SavedFiltersMenu';
import { getSearchHistory, pushSearchHistory } from '../lib/searchHistory';

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'unknown'];
const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: 'bg-slate-200 text-slate-700',
  debug: 'bg-cyan-200 text-cyan-800',
  info: 'bg-blue-200 text-blue-800',
  warn: 'bg-amber-200 text-amber-800',
  error: 'bg-red-200 text-red-800',
  unknown: 'bg-slate-100 text-slate-500',
};

// react-datepicker 用 Date 对象，spec.time_range 存 ISO；只在 UI 边界做转换
function isoToDate(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
function dateToIso(d: Date | null): string {
  return d ? d.toISOString() : '';
}

export function FilterBar() {
  const { spec, patchSpec, metadata } = useSession();
  const keywordRef = useRef<HTMLInputElement>(null);

  // 本地输入态（debounce 后再写 store）
  const [keyword, setKeyword] = useState(spec.text_search ?? '');
  const [keywordMode, setKeywordMode] = useState<'substring' | 'regex'>(spec.text_search_mode ?? 'substring');
  const [scopeField, setScopeField] = useState(spec.scope_filter?.field_name ?? 'scope');
  const [scopePattern, setScopePattern] = useState(spec.scope_filter?.pattern ?? '');
  const [scopeMode, setScopeMode] = useState<MatchMode>(spec.scope_filter?.mode ?? 'glob');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // 关键词 regex 模式下校验语法（仅用于 input 红边框提示；非法时仍 patchSpec，后端会静默放行）
  const keywordRegexInvalid = keywordMode === 'regex' && keyword.length > 0 && (() => {
    try { new RegExp(keyword); return false; } catch { return true; }
  })();

  // debounce 关键词 + mode
  useEffect(() => {
    const t = setTimeout(() => patchSpec({
      text_search: keyword || null,
      text_search_mode: keywordMode === 'regex' ? 'regex' : null,
    }), 150);
    return () => clearTimeout(t);
  }, [keyword, keywordMode, patchSpec]);

  // 搜索历史：长度 >= 3 + 停手 1s 后才记入（避免每个字符都写盘 + 太短噪音）
  useEffect(() => {
    if (!keyword || keyword.length < 3) return;
    const t = setTimeout(() => pushSearchHistory(keyword), 1000);
    return () => clearTimeout(t);
  }, [keyword]);
  const [historyTick, setHistoryTick] = useState(0);
  const searchHistory = useMemo(() => getSearchHistory(), [historyTick]);
  // input 聚焦时刷新一次 history（拿到本会话其他写入）
  const onKeywordFocus = () => setHistoryTick((n) => n + 1);

  // debounce scope 三联：local 输入 → 写入 store
  useEffect(() => {
    const t = setTimeout(() => {
      patchSpec({
        scope_filter: scopePattern
          ? { field_name: scopeField, pattern: scopePattern, mode: scopeMode }
          : null,
      });
    }, 150);
    return () => clearTimeout(t);
  }, [scopeField, scopePattern, scopeMode, patchSpec]);

  // 反向同步：spec.scope_filter 外部变化（如 StatsPanel/DetailDrawer 点击）→ 回填 local
  // 用 JSON 比对当前 local 衍生值与 spec 是否一致，避免无限循环
  useEffect(() => {
    const localDerived = scopePattern
      ? { field_name: scopeField, pattern: scopePattern, mode: scopeMode }
      : null;
    if (JSON.stringify(localDerived) === JSON.stringify(spec.scope_filter)) return;
    setScopeField(spec.scope_filter?.field_name ?? 'scope');
    setScopePattern(spec.scope_filter?.pattern ?? '');
    setScopeMode(spec.scope_filter?.mode ?? 'glob');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.scope_filter]);

  // debounce 时间
  useEffect(() => {
    const t = setTimeout(() => {
      const tr: [string, string] | null = from && to ? [from, to] : null;
      patchSpec({ time_range: tr });
    }, 150);
    return () => clearTimeout(t);
  }, [from, to, patchSpec]);

  // 反向同步：spec.text_search 外部变化（如 ⌘K 清空）→ 回填 local
  useEffect(() => {
    if ((spec.text_search ?? '') === keyword) return;
    setKeyword(spec.text_search ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.text_search]);

  // 反向同步：spec.time_range 外部变化 → 回填 local
  useEffect(() => {
    const localTr: [string, string] | null = from && to ? [from, to] : null;
    if (JSON.stringify(localTr) === JSON.stringify(spec.time_range)) return;
    setFrom(spec.time_range?.[0] ?? '');
    setTo(spec.time_range?.[1] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.time_range]);

  // 接收 ⌘F 全局快捷键：聚焦关键词输入框并全选当前内容
  useEffect(() => {
    const handler = () => {
      const el = keywordRef.current;
      if (!el) return;
      el.focus();
      el.select();
    };
    window.addEventListener('lv:focus-keyword', handler);
    return () => window.removeEventListener('lv:focus-keyword', handler);
  }, []);

  // 字段补全候选：scope 在前，加常见结构化字段名（用户可自由输入任意值，datalist 仅补全提示）
  const fieldOptions = useMemo(() => {
    const common = ['scope', 'request_id', 'trace_id', 'span_id', 'user_id', 'session_id', 'service', 'logger', 'thread'];
    return common;
  }, []);

  // scope 值补全候选：仅 exact 模式 + 当前 field 是 scope 时，提示当前文件出现过的 scope 名
  // glob/regex 模式下用户在输 pattern 而非具体值，提示会反而干扰，所以不给
  const scopeValueOptions = useMemo(() => {
    if (scopeMode !== 'exact' || scopeField !== 'scope' || !metadata) return [];
    return Object.keys(metadata.scope_counts ?? {}).sort();
  }, [scopeMode, scopeField, metadata]);

  const toggleLevel = (lv: LogLevel) => {
    const current = new Set(spec.levels ?? LEVELS);
    if (current.has(lv)) current.delete(lv); else current.add(lv);
    patchSpec({ levels: Array.from(current) });
  };

  const activeLevels = new Set(spec.levels ?? LEVELS);

  // 高级筛选（scope_filter 行）折叠：
  // - 默认收起；如果 spec.scope_filter 已经有值，自动展开避免用户找不到当前生效的筛选
  // - localStorage 记忆用户偏好（展开 / 收起）
  const [advOpen, setAdvOpen] = useState<boolean>(() => {
    if (spec.scope_filter) return true;
    try { return localStorage.getItem('lv:adv-filter-open') === '1'; } catch { return false; }
  });
  // spec.scope_filter 外部变化（如 saved-filter 应用、DetailDrawer "应用 scope 筛选"）→ 强制展开
  useEffect(() => {
    if (spec.scope_filter && !advOpen) setAdvOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.scope_filter]);
  const toggleAdv = () => {
    setAdvOpen((v) => {
      const next = !v;
      try { localStorage.setItem('lv:adv-filter-open', next ? '1' : '0'); } catch {}
      return next;
    });
  };

  return (
    <div className="p-2 border-b bg-white space-y-1">
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-slate-500">级别：</span>
        {LEVELS.map((lv) => (
          <button
            key={lv}
            onClick={() => toggleLevel(lv)}
            className={[
              'px-2 py-0.5 rounded text-xs uppercase tracking-wide',
              activeLevels.has(lv) ? LEVEL_COLOR[lv] : 'bg-slate-50 text-slate-400 line-through',
            ].join(' ')}
          >
            {lv}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={toggleAdv}
            className={['ctl', spec.scope_filter ? 'ctl-primary' : ''].join(' ')}
            title="高级筛选（按字段 + glob/regex；scope 多选用下方 StatsPanel tag 更快）"
          >
            {advOpen ? '▾' : '▸'} 高级筛选{spec.scope_filter ? ' ●' : ''}
          </button>
          <SavedFiltersMenu />
          <ExportMenu />
        </div>
      </div>

      {advOpen && (
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-slate-500">Scope：</span>
        <input
          value={scopeField}
          onChange={(e) => setScopeField(e.target.value || 'scope')}
          list="lv-scope-field-options"
          className="input-ctl"
          style={{ width: 110 }}
          placeholder="字段名"
          title="可输入任意字段名（如 request_id），匹配 entry.fields[字段名]"
        />
        <datalist id="lv-scope-field-options">
          {fieldOptions.map((f) => <option key={f} value={f} />)}
        </datalist>
        <div className="relative flex-1 max-w-xs">
          <input
            value={scopePattern}
            onChange={(e) => setScopePattern(e.target.value)}
            placeholder="模式（如 auth.* 或 user-service）"
            className="input-ctl w-full pr-6"
            list={scopeValueOptions.length > 0 ? 'lv-scope-value-options' : undefined}
          />
          {scopeValueOptions.length > 0 && (
            <datalist id="lv-scope-value-options">
              {scopeValueOptions.map((v) => <option key={v} value={v} />)}
            </datalist>
          )}
          {scopePattern && (
            <button
              onClick={() => setScopePattern('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 text-xs leading-none px-1"
              title="清除 scope 筛选"
            >
              ✕
            </button>
          )}
        </div>
        <div className="ctl-segment">
          {(['exact', 'glob', 'regex'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setScopeMode(m)}
              className={scopeMode === m ? 'active' : ''}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      )}

      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-slate-500">关键词：</span>
        <input
          ref={keywordRef}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onFocus={onKeywordFocus}
          placeholder={keywordMode === 'regex' ? '正则（大小写不敏感）' : '在 message / 原始行中搜索'}
          className={['input-ctl flex-1 max-w-md', keywordRegexInvalid ? 'border-red-400' : ''].join(' ')}
          title={keywordRegexInvalid ? '正则语法非法（已被忽略）' : ''}
          list={searchHistory.length > 0 ? 'lv-search-history' : undefined}
        />
        {searchHistory.length > 0 && (
          <datalist id="lv-search-history">
            {searchHistory.map((h) => <option key={h} value={h} />)}
          </datalist>
        )}
        <button
          onClick={() => setKeywordMode((m) => (m === 'regex' ? 'substring' : 'regex'))}
          className={['ctl', keywordMode === 'regex' ? 'ctl-primary' : ''].join(' ')}
          title={keywordMode === 'regex' ? '当前 regex 模式（点切换为 substring）' : '当前 substring 模式（点切换为 regex）'}
        >.Rx</button>
        <span className="text-slate-500 ml-2">时间：</span>
        <DatePicker
          selected={isoToDate(from)}
          onChange={(d: Date | null) => setFrom(dateToIso(d))}
          selectsStart
          startDate={isoToDate(from) ?? undefined}
          endDate={isoToDate(to) ?? undefined}
          showTimeSelect
          timeFormat="HH:mm"
          timeIntervals={5}
          dateFormat="yyyy-MM-dd HH:mm"
          placeholderText="开始时间"
          className="input-ctl text-[11px]"
          wrapperClassName="lv-dp"
          isClearable={false}
        />
        <span className="text-slate-400">~</span>
        <DatePicker
          selected={isoToDate(to)}
          onChange={(d: Date | null) => setTo(dateToIso(d))}
          selectsEnd
          startDate={isoToDate(from) ?? undefined}
          endDate={isoToDate(to) ?? undefined}
          minDate={isoToDate(from) ?? undefined}
          showTimeSelect
          timeFormat="HH:mm"
          timeIntervals={5}
          dateFormat="yyyy-MM-dd HH:mm"
          placeholderText="结束时间"
          className="input-ctl text-[11px]"
          wrapperClassName="lv-dp"
          isClearable={false}
        />
        {(from || to) && (
          <button
            onClick={() => { setFrom(''); setTo(''); }}
            className="text-slate-400 hover:text-slate-700 text-xs leading-none px-1"
            title="清除时间区间"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
