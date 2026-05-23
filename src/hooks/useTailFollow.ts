// follow=true 时启动后端 watcher 并监听 entries_appended / file_rotated event
// follow=false 时停止
//
// 收到 entries_appended 后：
//  1. appendEntries → 仅更新 metadata.total（文件原始行数）
//  2. 250ms debounced 重跑 cmd_query → setResult 让后端按当前 spec 过滤
//     setResult 会自动按 total_matched 差额累加 newEntriesPending
// 直接走 cmd_query 而不是 useAutoQuery 是为了避免 loading=true 闪一下。
// 修 README 已知 bug "tail 追加的新条目不走 spec filter"。

import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { startFollow, stopFollow, getMetadata, query } from '../api/commands';
import { useSession } from '../state/session';
import type { LogEntry } from '../types/log';

interface AppendPayload { entries: LogEntry[]; total: number; }
interface RotatePayload { kind: string; }

const REQUERY_DEBOUNCE_MS = 250;
const PAGE_SIZE = 200;

export function useTailFollow() {
  const { metadata, follow, appendEntries, setRotationKind, setError, setFollow } = useSession();
  const requeryTimer = useRef<number | null>(null);
  // 只关心"打开的文件是否变了"——不能依赖 metadata 对象本身，
  // 因为 appendEntries 每来一条新日志都会重建 metadata（{...s.metadata, total}），
  // 导致 effect 整轮重跑 + setMetadata 把 selectedEntry 清掉，抽屉闪一下就关了。
  const path = metadata?.path ?? null;

  useEffect(() => {
    if (!path) return;
    if (!follow) {
      stopFollow().catch(() => {});
      return;
    }

    let unsubAppend: UnlistenFn | null = null;
    let unsubRotate: UnlistenFn | null = null;

    const scheduleFollowRequery = () => {
      if (requeryTimer.current != null) window.clearTimeout(requeryTimer.current);
      requeryTimer.current = window.setTimeout(async () => {
        requeryTimer.current = null;
        const s = useSession.getState();
        if (!s.metadata) return;
        const targetPath = s.metadata.path;
        try {
          const r = await query(s.spec, 0, PAGE_SIZE);
          const cur = useSession.getState();
          if (cur.metadata?.path !== targetPath) return;  // 文件已切，丢弃
          cur.setResult(r);
        } catch {
          // 静默失败：下一次 append 会再触发；不打扰用户
        }
      }, REQUERY_DEBOUNCE_MS);
    };

    const maybeNotifyError = (entries: LogEntry[]) => {
      if (!useSession.getState().notifyOnError) return;
      if (typeof document === 'undefined' || document.hasFocus()) return;   // 已聚焦无需通知
      if (typeof Notification === 'undefined') return;                       // 环境不支持
      const errors = entries.filter((en) => en.level === 'error').length;
      if (errors === 0) return;
      const fire = () => new Notification('Log Viewer · 新 ERROR', {
        body: `${errors} 条新 error 日志`,
        tag: 'lv-tail-error',                                                // 同 tag 后续覆盖，不堆叠
      });
      if (Notification.permission === 'granted') {
        try { fire(); } catch { /* ignore */ }
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((p) => { if (p === 'granted') { try { fire(); } catch {} } });
      }
    };

    const setup = async () => {
      try {
        unsubAppend = await listen<AppendPayload>('entries_appended', (e) => {
          appendEntries(e.payload.entries, e.payload.total);
          scheduleFollowRequery();
          maybeNotifyError(e.payload.entries);
        });
        unsubRotate = await listen<RotatePayload>('file_rotated', (e) => {
          setRotationKind(e.payload.kind);
          setFollow(false);
        });
        await startFollow();
        const md = await getMetadata();
        useSession.getState().setMetadata(md);
      } catch (err) {
        setError(typeof err === 'string' ? err : JSON.stringify(err));
        setFollow(false);
      }
    };
    setup();

    return () => {
      unsubAppend?.();
      unsubRotate?.();
      if (requeryTimer.current != null) {
        window.clearTimeout(requeryTimer.current);
        requeryTimer.current = null;
      }
      stopFollow().catch(() => {});
    };
  }, [path, follow, appendEntries, setRotationKind, setError, setFollow]);
}
