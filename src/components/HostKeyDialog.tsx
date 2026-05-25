import { confirmHostKey } from '../api/remote';

interface Props {
  host: string;
  port: number;
  fingerprint: string;
  /**
   * confirmed=true 表示用户选了 trust / session-only —— 上层应 retry 之前的连接动作；
   * confirmed=false 表示拒绝，不重试。
   */
  onClose: (confirmed: boolean) => void;
}

export function HostKeyDialog({ host, port, fingerprint, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded shadow-xl p-5 max-w-md">
        <h3 className="text-sm font-semibold text-amber-700 mb-2">⚠ 未知主机指纹</h3>
        <p className="text-xs text-slate-600 mb-2">
          <code className="bg-slate-100 px-1 rounded">{host}:{port}</code> 不在 known_hosts
        </p>
        <div className="bg-slate-50 border rounded p-2 mb-3 font-mono text-[11px] break-all">
          {fingerprint}
        </div>
        <p className="text-xs text-slate-600 mb-3">是否信任并保存？</p>
        <div className="flex gap-2 justify-end">
          <button className="ctl" onClick={() => onClose(false)}>拒绝</button>
          <button className="ctl" onClick={async () => {
            try {
              await confirmHostKey(host, port, fingerprint, 'session-only');
              onClose(true);
            } catch (e) {
              console.error('confirmHostKey session-only failed', e);
              onClose(false);
            }
          }}>仅本次</button>
          <button className="ctl ctl-primary" onClick={async () => {
            try {
              await confirmHostKey(host, port, fingerprint, 'trust');
              onClose(true);
            } catch (e) {
              console.error('confirmHostKey trust failed', e);
              onClose(false);
            }
          }}>信任并保存</button>
        </div>
      </div>
    </div>
  );
}
