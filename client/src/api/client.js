// Thin fetch wrapper for the REST API. The token is attached to every call;
// the server re-checks role and scope on each request (the UI never decides access).
//
// Two independent sessions can be open in the same browser: the student portal
// (/student/...) and the staff portal (/staff/..., /admin/...). Each keeps its
// own token, so logging into one never logs you out of, or redirects, the other.
const TOKEN_KEYS = { student: 'clearance.token.student', staff: 'clearance.token.staff' };

/** Which portal a page belongs to: staff for /staff and /admin, student for everything else. */
export const portalFor = (pathname = window.location.pathname) => (/^\/(staff|admin)(\/|$)/.test(pathname) ? 'staff' : 'student');

export function getToken(portal = portalFor()) {
  try {
    return localStorage.getItem(TOKEN_KEYS[portal]);
  } catch {
    return null;
  }
}

export function setToken(portal, token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEYS[portal], token);
    else localStorage.removeItem(TOKEN_KEYS[portal]);
    localStorage.removeItem('clearance.token'); // single-session key from an earlier version
  } catch {
    /* storage unavailable (private mode): session lasts until reload */
  }
}

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data || {};
  }
}

let onUnauthorized = () => {};
/** AuthProvider registers what to do when a portal's session has expired: fn(portal). */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

// Requests in flight, so the top loading bar can show while the app waits on the server.
// Background refreshes pass { quiet: true } and are not counted.
let inFlight = 0;
const loadingListeners = new Set();
export function onLoadingChange(fn) {
  loadingListeners.add(fn);
  return () => loadingListeners.delete(fn);
}
function trackLoading(delta) {
  inFlight = Math.max(0, inFlight + delta);
  for (const fn of loadingListeners) fn(inFlight > 0);
}

async function request(method, path, { quiet = false, ...opts } = {}) {
  if (quiet) return send(method, path, opts);
  trackLoading(1);
  try {
    return await send(method, path, opts);
  } finally {
    trackLoading(-1);
  }
}

async function send(method, path, { body, form, raw, portal = portalFor() } = {}) {
  const headers = {};
  const token = getToken(portal);
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, { error: 'Could not reach the server. Check your connection and try again.' });
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized(portal);
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  del: (path) => request('DELETE', path),
  upload: (path, form) => request('POST', path, { form }),
  /** Authenticated binary download (files, letters, certificates). */
  blob: async (path, opts = {}) => (await request('GET', path, { raw: true, ...opts })).blob(),
};

/** Download a protected file and save it with the given name. */
export async function downloadFile(path, filename) {
  const blob = await api.blob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Open a protected file (PDF or image) in a new tab. */
export async function openFile(path) {
  const win = window.open('', '_blank');
  try {
    const blob = await api.blob(path);
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch (err) {
    if (win) win.close();
    throw err;
  }
}

export const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

export const formatDate = (d, withTime = false) =>
  d
    ? new Date(d).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        ...(withTime && { hour: '2-digit', minute: '2-digit' }),
      })
    : '';
