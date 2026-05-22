// 顶部实时跟踪 chip：28px 等高
// - 开启：绿底 + 绿边 + 绿色 dot 脉冲 + "实时跟踪"
// - 关闭：灰底 + 灰边 + 灰色 dot（无脉冲）+ "实时跟踪"

import { useSession } from '../state/session';

export function FollowToggle() {
  const { follow, setFollow, metadata } = useSession();
  if (!metadata) return null;

  return (
    <button
      onClick={() => setFollow(!follow)}
      style={{ height: 'var(--h-control)' }}
      className={[
        'box-border inline-flex items-center gap-1.5 px-2.5 text-xs rounded-[5px] border transition-colors',
        follow
          ? 'bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100'
          : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50',
      ].join(' ')}
      title={follow ? '实时跟踪中（点击关闭）' : '实时跟踪关闭（点击开启）'}
    >
      <span className="relative inline-flex items-center justify-center w-2.5 h-2.5">
        {follow && (
          <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-75 animate-ping" />
        )}
        <span className={[
          'relative inline-block w-1.5 h-1.5 rounded-full',
          follow ? 'bg-emerald-500' : 'bg-slate-400',
        ].join(' ')} />
      </span>
      实时跟踪
    </button>
  );
}
