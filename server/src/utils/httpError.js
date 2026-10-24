// Errors created here are safe to show to the client (expose = true).
export default function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (extra) err.extra = extra;
  return err;
}

/** Trim, collapse inner whitespace, lowercase: used for case-insensitive matching. */
export function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Parse a positive integer route parameter, or throw 404. */
export function intParam(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw httpError(404, 'Not found');
  return n;
}

/** Throws 400 if any of the named body fields is missing or blank. */
export function requireFields(body, fields) {
  const missing = fields.filter((f) => typeof body?.[f] !== 'string' || body[f].trim() === '');
  if (missing.length) throw httpError(400, `Please fill in: ${missing.join(', ')}`);
}
