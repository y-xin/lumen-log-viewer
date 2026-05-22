// follow=true 时启动后端 watcher 并监听 entries_appended / file_rotated event
// follow=false 时停止

import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { startFollow, stopFollow, getMetadata } from '../api/commands';
import { useSession } from '../state/session';
import type { LogEntry } from '../types/log';

interface AppendPayload { entries: LogEntry[]; total: number; }
interface RotatePayload { kind: string; }

export function useTailFollow() {
  const { metadata, follow, appendEntries, setRotationKind, setError, setFollow } = useSession();

  useEffect(() => {
    if (!metadata) return;
    if (!follow) {
      stopFollow().catch(() => {});
      return;
    }

    let unsubAppend: UnlistenFn | null = null;
    let unsubRotate: UnlistenFn | null = null;

    const setup = async () => {
      try {
        unsubAppend = await listen<AppendPayload>('entries_appended', (e) => {
          appendEntries(e.payload.entries, e.payload.total);
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
      stopFollow().catch(() => {});
    };
  }, [metadata, follow, appendEntries, setRotationKind, setError, setFollow]);
}
