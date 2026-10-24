// In-app notifications (the baseline), with an optional email copy.
// Pass the transaction connection as `db` so notifications commit with the
// change; emails are then sent only after that commit.
import pool from '../config/db.js';
import httpError from '../utils/httpError.js';
import { sendEmail, emailEnabled } from './emailService.js';

async function queueEmail(recipientType, recipientId, message, link, db) {
  const table = recipientType === 'student' ? 'students' : 'staff';
  const idCol = recipientType === 'student' ? 'student_id' : 'staff_id';
  const [[r]] = await db.query(`SELECT email, full_name FROM ${table} WHERE ${idCol} = ?`, [recipientId]);
  if (!r) return;
  const send = () => sendEmail({ to: r.email, name: r.full_name, message, link });
  if (typeof db.afterCommit === 'function') db.afterCommit(send);
  else send();
}

/** link: the page in the app this notification opens when clicked (e.g. /student/stage/12). */
export async function notify(recipientType, recipientId, message, db = pool, link = null) {
  await db.query('INSERT INTO notifications (recipient_id, recipient_type, message, link) VALUES (?, ?, ?, ?)', [recipientId, recipientType, message, link]);
  if (emailEnabled()) await queueEmail(recipientType, recipientId, message, link, db);
}

export const notifyStudent = (studentId, message, db = pool, link = null) => notify('student', studentId, message, db, link);

/**
 * Notify every active reviewer of `role` whose scope covers the student
 * (departmental -> same department, faculty -> same faculty, others -> all).
 */
export async function notifyReviewers(role, student, message, db = pool, link = null) {
  const [staff] = await db.query(
    `SELECT staff_id FROM staff
      WHERE role = ? AND is_active = TRUE
        AND (role <> 'departmental' OR department_id = ?)
        AND (role <> 'faculty' OR faculty_id = ?)`,
    [role, student.department_id, student.faculty_id]
  );
  for (const s of staff) await notify('staff', s.staff_id, message, db, link);
  return staff.length;
}

// ---- reading (GET/PATCH /api/notifications) ----

export async function listNotifications(user, { unreadOnly = false, limit = 50, before } = {}) {
  const max = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const params = [user.userType, user.sub];
  let where = 'recipient_type = ? AND recipient_id = ?';
  if (unreadOnly) where += ' AND is_read = FALSE';
  if (before) {
    where += ' AND notification_id < ?';
    params.push(Number(before));
  }
  const [items] = await pool.query(
    `SELECT notification_id, message, link, is_read, created_at FROM notifications WHERE ${where} ORDER BY notification_id DESC LIMIT ?`,
    [...params, max]
  );
  const [[{ unread }]] = await pool.query(
    'SELECT COUNT(*) AS unread FROM notifications WHERE recipient_type = ? AND recipient_id = ? AND is_read = FALSE',
    [user.userType, user.sub]
  );
  return { items: items.map((n) => ({ ...n, is_read: Boolean(n.is_read) })), unread_count: Number(unread) };
}

export async function markRead(user, notificationId) {
  const [res] = await pool.query(
    'UPDATE notifications SET is_read = TRUE WHERE notification_id = ? AND recipient_type = ? AND recipient_id = ?',
    [notificationId, user.userType, user.sub]
  );
  if (res.affectedRows === 0) throw httpError(404, 'Notification not found');
}

export async function markAllRead(user) {
  const [res] = await pool.query(
    'UPDATE notifications SET is_read = TRUE WHERE recipient_type = ? AND recipient_id = ? AND is_read = FALSE',
    [user.userType, user.sub]
  );
  return res.affectedRows;
}
