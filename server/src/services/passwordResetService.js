// Forgot password: email a one-time link, then set a new password with it.
// The request step never says whether an account exists (same answer either way),
// so it cannot be used to find out who has an account.
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import pool, { withTransaction } from '../config/db.js';
import env from '../config/env.js';
import httpError from '../utils/httpError.js';
import { logAudit } from './auditLog.js';
import { sendEmail } from './emailService.js';

export const RESET_MINUTES = 30;
const RESEND_SECONDS = 60; // at most one new link per account per minute
const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_ROUNDS = 10;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const GENERIC_REPLY = `If an account matches what you entered, we have emailed it a link to reset the password. The link works once and expires in ${RESET_MINUTES} minutes.`;

/** The account for the reset request: students by reg number or email, staff by email. */
async function findAccount(userType, identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;
  if (userType === 'student') {
    const byEmail = value.includes('@');
    const [[s]] = await pool.query(
      `SELECT student_id AS id, full_name, email FROM students WHERE ${byEmail ? 'LOWER(email) = LOWER(?)' : 'matric_no = ?'} AND password_hash IS NOT NULL`,
      [value]
    );
    return s || null; // students who never signed up have no password to reset
  }
  const [[st]] = await pool.query('SELECT staff_id AS id, full_name, email FROM staff WHERE LOWER(email) = LOWER(?) AND is_active = TRUE', [value]);
  return st || null;
}

/** POST /api/auth/forgot-password { user_type, identifier } */
export async function requestReset(userType, identifier, ip) {
  if (!['student', 'staff'].includes(userType)) throw httpError(400, 'user_type must be student or staff');
  const account = await findAccount(userType, identifier);
  if (!account) return { sent: false };

  const [[recent]] = await pool.query(
    'SELECT reset_id FROM password_resets WHERE user_type = ? AND user_id = ? AND used_at IS NULL AND created_at > NOW() - INTERVAL ? SECOND',
    [userType, account.id, RESEND_SECONDS]
  );
  if (recent) return { sent: false }; // a link was just sent; do not flood the inbox

  const token = crypto.randomBytes(32).toString('hex');
  await withTransaction(async (conn) => {
    // Only the newest link works.
    await conn.query('UPDATE password_resets SET used_at = NOW() WHERE user_type = ? AND user_id = ? AND used_at IS NULL', [userType, account.id]);
    await conn.query('INSERT INTO password_resets (user_type, user_id, token_hash, expires_at) VALUES (?, ?, ?, NOW() + INTERVAL ? MINUTE)', [userType, account.id, hashToken(token), RESET_MINUTES]);
    await logAudit({ actorType: userType, actorId: account.id, action: 'auth.password_reset_request', entity: userType, entityId: account.id, detail: { ip } }, conn);
  });

  const link = `/${userType}/reset-password?token=${token}`;
  const message =
    'We received a request to reset the password for your clearance account. ' +
    `Open this link to choose a new password: ${env.appBaseUrl}${link} ` +
    `The link works once and expires in ${RESET_MINUTES} minutes. If you did not ask for this, ignore this email; your password stays the same.`;
  const emailed = await sendEmail({ to: account.email, name: account.full_name, message, link });
  // Without email (e.g. a local demo with EMAIL_ENABLED=false), print the link so it can still be used.
  if (!emailed && !process.env.NODE_TEST_CONTEXT) console.log(`[password reset] ${account.email}: ${env.appBaseUrl}${link}`);
  return { sent: true, emailed };
}

async function findValidReset(token, db = pool, lock = false) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const [[row]] = await db.query(
    `SELECT reset_id, user_type, user_id FROM password_resets
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()${lock ? ' FOR UPDATE' : ''}`,
    [hashToken(token)]
  );
  return row || null;
}

/** GET /api/auth/reset-password/check?token=  Is the link still usable? */
export async function checkReset(token) {
  const row = await findValidReset(token);
  return row ? { valid: true, user_type: row.user_type } : { valid: false };
}

/** POST /api/auth/reset-password { token, password } */
export async function resetPassword(token, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) throw httpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const account = await withTransaction(async (conn) => {
    const row = await findValidReset(token, conn, true);
    if (!row) throw httpError(400, 'This reset link is invalid or has expired. Ask for a new one.');
    if (row.user_type === 'student') {
      await conn.query('UPDATE students SET password_hash = ? WHERE student_id = ?', [hash, row.user_id]);
    } else {
      // They chose this password themselves, so no forced change at the next login.
      await conn.query('UPDATE staff SET password_hash = ?, must_change_password = FALSE WHERE staff_id = ?', [hash, row.user_id]);
    }
    await conn.query('UPDATE password_resets SET used_at = NOW() WHERE user_type = ? AND user_id = ? AND used_at IS NULL', [row.user_type, row.user_id]);
    await logAudit({ actorType: row.user_type, actorId: row.user_id, action: 'auth.password_reset', entity: row.user_type, entityId: row.user_id }, conn);
    const [[a]] =
      row.user_type === 'student'
        ? await conn.query('SELECT full_name, email FROM students WHERE student_id = ?', [row.user_id])
        : await conn.query('SELECT full_name, email FROM staff WHERE staff_id = ?', [row.user_id]);
    return { ...a, user_type: row.user_type };
  });

  // Tell the owner, in case it was not them.
  await sendEmail({
    to: account.email,
    name: account.full_name,
    message: 'The password for your clearance account was just changed. If this was not you, reset it again straight away and contact the clearance administrator.',
    link: `/${account.user_type}/login`,
  });
  return { user_type: account.user_type };
}
