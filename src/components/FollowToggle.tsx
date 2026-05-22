// 顶部实时跟踪开关 + 脉冲指示器

import { useSession } from '../state/session';

export function FollowToggle() {
  const { follow, setFollow, metadata } = useSession();
  if (!metadata) return null;

  return (
    <button
      onClick={() => setFollow(!follow)}
      className={[
        'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border',
        follow
          ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
          : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50',
      ].join(' ')}
      title={follow ? '实时跟踪中（点击关闭）' : '实时跟踪关闭（点击开启）'}
    >
      <span className="relative inline-flex items-center justify-center w-3 h-3">
        {follow && (
          <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-75 animate-ping" />
        )}
        <span className={[
          'relative inline-block w-2 h-2 rounded-full',
          follow ? 'bg-emerald-500' : 'bg-slate-400',
        ].join(' ')} />
      </span>
      ⚡ 实时跟踪 {follow ? 'ON' : 'OFF'}
    </button>
  );
}
