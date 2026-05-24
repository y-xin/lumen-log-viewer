import { confirmHostKey } from '../api/remote';

interface Props {
  host: string;
  port: number;
  fingerprint: string;
  onClose: () => void;
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
          <button className="ctl" onClick={onClose}>拒绝</button>
          <button className="ctl" onClick={async () => {
            await confirmHostKey(host, port, fingerprint, 'session-only');
            onClose();
          }}>仅本次</button>
          <button className="ctl ctl-primary" onClick={async () => {
            await confirmHostKey(host, port, fingerprint, 'trust');
            onClose();
          }}>信任并保存</button>
        </div>
      </div>
    </div>
  );
}
