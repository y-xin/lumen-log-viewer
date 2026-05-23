// 桌面通知开关：仅 tail-follow 模式下 + 当前窗口未聚焦 时，新 ERROR 触发系统通知
// 关闭时不打扰；开启时浏览器原生 Notification API（首次会弹权限请求）

import { useSession } from '../state/session';

export function NotifyToggle() {
  const { notifyOnError, setNotifyOnError, metadata } = useSession();
  if (!metadata) return null;

  const handleToggle = async () => {
    const next = !notifyOnError;
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      // 首次开启：预先求一次权限，避免第一条 error 来时弹窗才请求
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    setNotifyOnError(next);
  };

  return (
    <button
      onClick={handleToggle}
      style={{ height: 'var(--h-control)' }}
      className={[
        'box-border inline-flex items-center gap-1 px-2 text-xs rounded-[5px] border transition-colors',
        notifyOnError
          ? 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
          : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50',
      ].join(' ')}
      title={notifyOnError
        ? 'tail 模式新 ERROR 桌面通知：开（窗口未聚焦时触发）'
        : 'tail 模式新 ERROR 桌面通知：关'}
    >
      {notifyOnError ? '🔔' : '🔕'}
    </button>
  );
}
