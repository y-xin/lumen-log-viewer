// 打开远程日志文件的 SSH 连接对话框
// 支持私钥 / 密码两种认证方式，可记住本次会话的密钥口令

import { useState, useEffect } from 'react';
import { useRemoteSession } from '../state/remoteSession';
import { confirmHostKey, listSshHosts, type SshConnectionParams } from '../api/remote';

interface HostKeyUnknownInfo {
  host: string;
  port: number;
  fingerprint: string;
}

/**
 * onTest 返回值：
 * - ok=true → 测试成功
 * - ok=false + hostKeyUnknown → 未知主机指纹，由 dialog 弹 inline TOFU 确认 UI
 * - ok=false + error → 其他错误，红条显示
 */
export interface TestResult {
  ok: boolean;
  error?: string;
  hostKeyUnknown?: HostKeyUnknownInfo;
}

interface Props {
  onClose: () => void;
  onSubmit: (params: SshConnectionParams, path: string, tailLines: number) => void;
  onTest: (params: SshConnectionParams) => Promise<TestResult>;
}

export function OpenRemoteDialog({ onClose, onSubmit, onTest }: Props) {
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [port, setPort] = useState(22);
  const [remotePath, setRemotePath] = useState('');
  const [authKind, setAuthKind] = useState<'key' | 'password'>('key');
  const [keyPath, setKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [tailLines, setTailLines] = useState(5000);
  const [testResult, setTestResult] = useState<string | null>(null);
  // 未知主机指纹弹窗（inline，避免遮盖父 dialog 上下文）
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyUnknownInfo | null>(null);

  // host 变化时自动 prefill 已知 SSH 主机配置
  useEffect(() => {
    if (!host) return;
    listSshHosts().then((hosts) => {
      const cfg = hosts[`${host}:${port}`];
      if (cfg) {
        setUser((u) => u || cfg.user);
        setKeyPath((k) => k || cfg.key_path);
        setRemotePath((p) => p || cfg.last_path || '');
      }
    }).catch(() => {});
  }, [host, port]);

  const buildParams = (): SshConnectionParams => ({
    host, user, port,
    credential: authKind === 'key'
      ? { type: 'key_file', path: keyPath, passphrase: passphrase || null }
      : { type: 'password', password },
  });

  const valid = host.trim() && user.trim() && remotePath.startsWith('/')
    && port >= 1 && port <= 65535
    && (authKind === 'key' ? keyPath.trim() : password);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
         onClick={onClose}>
      <div className="bg-white rounded shadow-xl p-5 w-[480px]" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold mb-3">打开远程日志文件 (SSH)</h3>

        <Row label="Host">
          <input className="input-ctl flex-1" value={host} onChange={(e) => setHost(e.target.value)}
                 placeholder="prod-1.example.com" autoFocus />
        </Row>
        <Row label="User / Port">
          <input className="input-ctl flex-1" value={user} onChange={(e) => setUser(e.target.value)}
                 placeholder="kim" />
          <input className="input-ctl w-20" type="number" value={port}
                 onChange={(e) => setPort(Number(e.target.value))} />
        </Row>
        <Row label="远程路径">
          <input className="input-ctl flex-1" value={remotePath}
                 onChange={(e) => setRemotePath(e.target.value)}
                 placeholder="/var/log/app.log" />
        </Row>
        <Row label="认证">
          <label className="flex items-center gap-1 text-xs">
            <input type="radio" checked={authKind === 'key'}
                   onChange={() => setAuthKind('key')} className="mr-1" />
            私钥
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input type="radio" checked={authKind === 'password'}
                   onChange={() => setAuthKind('password')} className="mr-1" />
            密码
          </label>
        </Row>
        {authKind === 'key' ? (
          <>
            <Row label="私钥路径">
              <input className="input-ctl flex-1" value={keyPath}
                     onChange={(e) => setKeyPath(e.target.value)}
                     placeholder="~/.ssh/id_ed25519" />
            </Row>
            <Row label="Passphrase">
              <input className="input-ctl flex-1" type="password" value={passphrase}
                     onChange={(e) => setPassphrase(e.target.value)} />
            </Row>
          </>
        ) : (
          <Row label="密码">
            <input className="input-ctl flex-1" type="password" value={password}
                   onChange={(e) => setPassword(e.target.value)} />
          </Row>
        )}
        <Row label="初始拉取">
          <select className="select-ctl" value={tailLines}
                  onChange={(e) => setTailLines(Number(e.target.value))}>
            <option value={1000}>末尾 1000 行</option>
            <option value={5000}>末尾 5000 行</option>
            <option value={20000}>末尾 20000 行</option>
            <option value={-1}>全部</option>
          </select>
        </Row>
        <label className="block text-xs text-slate-500 mb-3 pl-20">
          <input type="checkbox" checked={remember}
                 onChange={(e) => setRemember(e.target.checked)} className="mr-1" />
          本次会话记住 passphrase / 密码
        </label>

        {testResult && (
          <div className={`text-xs px-2 py-1 rounded mb-2 ${
            testResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
          }`}>{testResult}</div>
        )}

        <div className="flex justify-between">
          <button className="ctl" disabled={!valid} onClick={async () => {
            setTestResult(null);
            const r = await onTest(buildParams());
            if (r.ok) {
              setTestResult('✅ 连接成功');
            } else if (r.hostKeyUnknown) {
              // 未知指纹 — 弹 inline TOFU 让用户选 trust / session-only / reject
              setHostKeyPrompt(r.hostKeyUnknown);
            } else {
              setTestResult(`❌ ${r.error ?? '未知错误'}`);
            }
          }}>测试连接</button>
          <div className="flex gap-2">
            <button className="ctl" onClick={onClose}>取消</button>
            <button className="ctl ctl-primary" disabled={!valid} onClick={() => {
              if (remember) {
                useRemoteSession.getState().remember(
                  `${host}:${port}:${user}`,
                  authKind === 'key' ? passphrase : password,
                );
              }
              onSubmit(buildParams(), remotePath, tailLines);
            }}>连接</button>
          </div>
        </div>

        {hostKeyPrompt && (
          <div className="mt-4 border-t pt-3">
            <h4 className="text-xs font-semibold text-amber-700 mb-1">⚠ 未知主机指纹</h4>
            <p className="text-xs text-slate-600 mb-2">
              <code className="bg-slate-100 px-1 rounded">{hostKeyPrompt.host}:{hostKeyPrompt.port}</code> 不在 known_hosts
            </p>
            <div className="bg-slate-50 border rounded p-2 mb-2 font-mono text-[11px] break-all">
              {hostKeyPrompt.fingerprint}
            </div>
            <div className="flex gap-2 justify-end">
              <button className="ctl" onClick={() => setHostKeyPrompt(null)}>拒绝</button>
              <button className="ctl" onClick={async () => {
                try {
                  await confirmHostKey(hostKeyPrompt.host, hostKeyPrompt.port,
                    hostKeyPrompt.fingerprint, 'session-only');
                  setHostKeyPrompt(null);
                  // 自动重试测试 —— 此时 bypass 表已记录
                  const r = await onTest(buildParams());
                  setTestResult(r.ok ? '✅ 连接成功' : `❌ ${r.error ?? '重试失败'}`);
                } catch (e) {
                  setTestResult(`❌ 记录失败：${String(e)}`);
                }
              }}>仅本次</button>
              <button className="ctl ctl-primary" onClick={async () => {
                try {
                  await confirmHostKey(hostKeyPrompt.host, hostKeyPrompt.port,
                    hostKeyPrompt.fingerprint, 'trust');
                  setHostKeyPrompt(null);
                  // 自动重试测试 —— 此时 known_hosts 已记录
                  const r = await onTest(buildParams());
                  setTestResult(r.ok ? '✅ 连接成功' : `❌ ${r.error ?? '重试失败'}`);
                } catch (e) {
                  setTestResult(`❌ 写入 known_hosts 失败：${String(e)}`);
                }
              }}>信任并保存</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// 表单行布局辅助组件
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <label className="text-xs text-slate-600 w-16 flex-shrink-0">{label}</label>
      {children}
    </div>
  );
}
