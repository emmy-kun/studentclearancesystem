import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';

/** The student's clearance (GET /api/clearance/mine), with reload. */
export function useClearance() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(
    () =>
      api
        .get('/clearance/mine')
        .then((d) => {
          setData(d);
          setError(null);
          return d;
        })
        .catch(setError),
    []
  );
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, setData, error, reload };
}

/** Unread notification count for the bell badge. */
export function useUnreadCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    api
      .get('/notifications?unread=1&limit=1', { quiet: true })
      .then((d) => setCount(d.unread_count))
      .catch(() => {});
  }, []);
  return count;
}
