import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, openFile } from '../api/client.js';
import { Close, FileIcon } from './Icons.jsx';

// ---------- status chips (labels and colours from the mockups) ----------
const STAGE_CHIPS = {
  approved: ['Approved', 'green'],
  rejected: ['Action needed', 'red'],
  locked: ['Locked', 'grey'],
  awaiting_submission: ['Open now', 'blue'],
  pending: ['Under review', 'amber'],
};
export function StageChip({ status }) {
  const [label, color] = STAGE_CHIPS[status] || [status, 'grey'];
  return <span className={`chip ${color}`}>{label}</span>;
}

const DOC_CHIPS_STUDENT = { pending: ['Uploaded', 'blue'], accepted: ['Accepted', 'green'], rejected: ['Rejected', 'red'] };
const DOC_CHIPS_REVIEWER = { pending: ['Awaiting your decision', 'blue'], accepted: ['Accepted', 'green'], rejected: ['Rejected', 'red'] };
export function DocChip({ status, reviewer = false }) {
  if (!status) return <span className="chip grey">Required</span>;
  const [label, color] = (reviewer ? DOC_CHIPS_REVIEWER : DOC_CHIPS_STUDENT)[status] || [status, 'grey'];
  return <span className={`chip ${color}`}>{label}</span>;
}

const PAY_CHIPS = { unpaid: ['Unpaid', 'amber'], success: ['Paid', 'green'], failed: ['Failed', 'red'] };
export function PaymentChip({ status }) {
  const [label, color] = PAY_CHIPS[status] || [status, 'grey'];
  return <span className={`chip ${color}`}>{label}</span>;
}

// ---------- misc ----------
export function Spinner() {
  return <div className="spinner" role="status" aria-label="Loading" />;
}
export function PageLoading() {
  return (
    <div className="page-loading">
      <Spinner />
    </div>
  );
}
export function ErrorText({ error }) {
  if (!error) return null;
  return <p className="error-text" role="alert">{typeof error === 'string' ? error : error.message}</p>;
}

// ---------- protected document thumbnail ----------
/**
 * Shows an uploaded document. Files are behind authentication, so an <img src>
 * cannot load them directly: the file is fetched with the token and shown from
 * a blob URL. PDFs show an icon and open in a new tab.
 */
export function DocThumb({ documentId, mimeType, large = false, label = 'Photo' }) {
  const [url, setUrl] = useState(null);
  const [zoom, setZoom] = useState(false);
  const isImage = mimeType?.startsWith('image/');

  useEffect(() => {
    if (!documentId || !isImage) return undefined;
    let objectUrl;
    let cancelled = false;
    api
      .blob(`/files/${documentId}`, { quiet: true })
      .then((b) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId, isImage]);

  const cls = `thumb${large ? ' lg' : ''}${documentId ? ' clickable' : ''}`;
  if (!documentId) return <div className={cls}>{label}</div>;
  if (!isImage) {
    return (
      <button type="button" className={cls} onClick={() => openFile(`/files/${documentId}`)} title="Open PDF">
        <span className="stack center" style={{ gap: 2, alignItems: 'center' }}>
          <FileIcon />
          <span>PDF</span>
        </span>
      </button>
    );
  }
  return (
    <>
      <button type="button" className={cls} onClick={() => url && setZoom(true)} title="View full size">
        {url ? <img src={url} alt="Uploaded document" /> : label}
      </button>
      {zoom && (
        <div className="modal-back" onClick={() => setZoom(false)} role="dialog" aria-modal="true">
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="btn btn-ghost modal-close" onClick={() => setZoom(false)} aria-label="Close">
              <Close />
            </button>
            <img src={url} alt="Uploaded document, full size" />
          </div>
        </div>
      )}
    </>
  );
}

// ---------- toast ----------
const ToastContext = createContext(() => {});
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const show = useCallback((message, type = 'info') => {
    setToast({ message, type, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast ${toast.type === 'error' ? 'error' : ''}`} role="status">
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
