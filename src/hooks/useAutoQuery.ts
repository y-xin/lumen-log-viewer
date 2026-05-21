// QuerySpec / metadata 变化时自动调 cmd_query；
// 用 ref + 计数器丢弃过期回包，避免回包错位

import { useEffect, useRef } from 'react';
import { query } from '../api/commands';
import { useSession } from '../state/session';

const PAGE_SIZE = 200;

export function useAutoQuery() {
  const { metadata, spec, setResult, setLoading, setError } = useSession();
  const reqId = useRef(0);

  useEffect(() => {
    if (!metadata) { setResult(null); return; }
    const my = ++reqId.current;
    setLoading(true);
    query(spec, 0, PAGE_SIZE)
      .then((r) => {
        if (my !== reqId.current) return;
        setResult(r);
        setError(null);
      })
      .catch((e) => {
        if (my !== reqId.current) return;
        setError(typeof e === 'string' ? e : JSON.stringify(e));
      })
      .finally(() => {
        if (my === reqId.current) setLoading(false);
      });
  }, [metadata, spec, setResult, setLoading, setError]);
}
