// 实时跟踪时，定时刷新 result.stats（含 sparkline 的 time_buckets）。
// appendEntries 只更新 page_entries + total_matched，不会动 stats，
// 所以 sparkline 在 follow 期间不会自动更新。
// 这里每 2s 后台跑一次 query，只把 stats + total_matched merge 回 result，
// 保留 page_entries 现状（避免 LogList 闪烁 / 丢已加载条目）。
// 不走 useAutoQuery 是为了避免 loading=true 闪一下。

import { useEffect, useRef } from 'react';
import { query } from '../api/commands';
import { useSession } from '../state/session';

const REFRESH_MS = 2000;
const PAGE_SIZE = 200;

export function useTailStatsRefresh() {
  const follow = useSession((s) => s.follow);
  const path = useSession((s) => s.metadata?.path ?? null);
  const timer = useRef<number | null>(null);
  const inflight = useRef(false);

  useEffect(() => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    if (!follow || !path) return;

    const tick = async () => {
      if (inflight.current) return; // 上一次还没回来，跳过
      inflight.current = true;
      try {
        const s = useSession.getState();
        if (!s.metadata) return;
        const r = await query(s.spec, 0, PAGE_SIZE);
        const cur = useSession.getState().result;
        if (!cur) return;
        useSession.setState({
          result: {
            ...cur,
            total_matched: r.total_matched,
            stats: r.stats,
          },
        });
      } catch {
        // 静默：刷新失败不打扰用户，下次 tick 再试
      } finally {
        inflight.current = false;
      }
    };

    timer.current = window.setInterval(tick, REFRESH_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [follow, path]);
}
