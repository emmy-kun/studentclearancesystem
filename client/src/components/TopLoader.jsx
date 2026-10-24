import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { onLoadingChange } from '../api/client.js';
import brand from '../brand.js';

const MIN_VISIBLE_MS = 1500; // the spinner stays up at least this long once shown

/**
 * Loading feedback:
 *  - a spinner in the middle of the screen while the app waits on the server and on
 *    every page change, shown for at least MIN_VISIBLE_MS;
 *  - remembers which button was pressed (data-pressed), so the spinner shows inside
 *    that button only, even when two buttons share the same busy state.
 */
export default function TopLoader() {
  const location = useLocation();
  const [requests, setRequests] = useState(false);
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef();

  // (Re)start the minimum display time.
  const hold = () => {
    clearTimeout(holdTimer.current);
    setHolding(true);
    holdTimer.current = setTimeout(() => setHolding(false), MIN_VISIBLE_MS);
  };

  // Server requests: show at once; stays until the request ends and the minimum time has passed.
  useEffect(() => {
    const unsubscribe = onLoadingChange((loading) => {
      if (loading) hold();
      setRequests(loading);
    });
    return () => {
      clearTimeout(holdTimer.current);
      unsubscribe();
    };
  }, []);

  // Page changes (links, redirects, first load).
  useEffect(hold, [location.pathname]);

  // Remember the pressed button for the in-button spinner.
  useEffect(() => {
    const mark = (button) => {
      for (const b of document.querySelectorAll('button[data-pressed]')) if (b !== button) b.removeAttribute('data-pressed');
      button?.setAttribute('data-pressed', '');
    };
    const onClick = (e) => mark(e.target.closest?.('button'));
    const onSubmit = (e) => mark(e.submitter || e.target.querySelector('button:not([type="button"])'));
    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('submit', onSubmit, true);
    };
  }, []);

  if (!requests && !holding) return null;
  return (
    <div className="page-loader" role="progressbar" aria-label="Loading">
      <img className="page-loader-img" src={brand.loader} alt="" />
      <div className="page-loader-text">Loading…</div>
    </div>
  );
}
