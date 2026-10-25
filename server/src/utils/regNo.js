/**
 * Reg numbers are stored as "2022/248400". Phones and hurried typing produce
 * "2022 248400", "2022-248400", "2022\248400" or "2022248400"; read them all as the
 * stored form. Anything else is returned trimmed and unchanged.
 */
export function normalizeRegNo(value) {
  const v = String(value ?? '').trim();
  const m = /^(\d{4})\s*[\/\\\-. ]?\s*(\d{5,7})$/.exec(v);
  return m ? `${m[1]}/${m[2]}` : v;
}
