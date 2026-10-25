// Registry: the last step, done in person. The student brings the clearance
// certificate (printed or on a phone); the Registry officer looks it up here,
// confirms it is genuine, and records that the signed degree certificate was
// handed over. Each certificate can be marked collected once.
import pool, { withTransaction } from '../config/db.js';
import httpError from '../utils/httpError.js';
import { logAudit, actorFrom } from './auditLog.js';
import { notifyStudent } from './notificationService.js';
import { longDate } from './pdfFiles.js';
import { normalizeRegNo } from '../utils/regNo.js';

const CERT_NO = /^(UNN-)?CLR-\d{4}-\d{6}$/;
const MATRIC = /^\d{4}\/\d{5,7}$/;
const CODE = /^[a-f0-9]{64}$/;

const SELECT = `SELECT c.certificate_id, c.certificate_no, c.issue_date, c.degree_issued_at, c.degree_serial_no, c.degree_note,
       iss.full_name AS degree_issued_by_name,
       cr.session, cr.completed_at, s.student_id, s.full_name, s.matric_no, s.email, d.name AS department, f.name AS faculty
  FROM certificates c
  JOIN clearance_requests cr ON cr.request_id = c.request_id
  JOIN students s ON s.student_id = cr.student_id
  JOIN departments d ON d.department_id = s.department_id
  JOIN faculties f ON f.faculty_id = d.faculty_id
  LEFT JOIN staff iss ON iss.staff_id = c.degree_issued_by
 WHERE cr.status = 'completed' AND `;

function view(row) {
  return {
    certificate_id: row.certificate_id,
    certificate_no: row.certificate_no,
    issue_date: row.issue_date,
    session: row.session,
    student: { full_name: row.full_name, matric_no: row.matric_no, email: row.email, department: row.department, faculty: row.faculty },
    collection: row.degree_issued_at
      ? { issued_at: row.degree_issued_at, issued_by: row.degree_issued_by_name, serial_no: row.degree_serial_no, note: row.degree_note }
      : null,
  };
}

/**
 * GET /api/registry/lookup?q=  q is a certificate number, a reg number, or the
 * verification code / address from the certificate's QR code.
 */
export async function lookup(q) {
  const raw = normalizeRegNo(q);
  const last = raw.split('/verify/').pop().split(/[?#]/)[0].trim();
  let row;
  if (CODE.test(last.toLowerCase())) {
    [[row]] = await pool.query(`${SELECT} c.verification_code = ?`, [last.toLowerCase()]);
  } else if (CERT_NO.test(raw.toUpperCase())) {
    [[row]] = await pool.query(`${SELECT} c.certificate_no = ?`, [raw.toUpperCase()]);
  } else if (MATRIC.test(raw)) {
    [[row]] = await pool.query(`${SELECT} s.matric_no = ? ORDER BY c.issue_date DESC LIMIT 1`, [raw]);
    if (!row) {
      const [[s]] = await pool.query('SELECT full_name FROM students WHERE matric_no = ?', [raw]);
      return { found: false, reason: s ? `${s.full_name} has not completed clearance yet, so there is no clearance certificate.` : 'No student has this reg number.' };
    }
  } else {
    throw httpError(400, 'Enter a certificate number (e.g. CLR-2026-000020), a reg number, or the code from the QR code.');
  }
  return row ? { found: true, ...view(row) } : { found: false, reason: 'No clearance certificate matches. Check for typing mistakes; the certificate may not be genuine.' };
}

/** POST /api/registry/certificates/:id/issue  { identity_checked, serial_no?, note? } */
export async function recordCollection(user, certificateId, body = {}) {
  if (body.identity_checked !== true) throw httpError(400, "Confirm that you have checked the student's ID card first.");
  const serial = String(body.serial_no || '').trim().slice(0, 40) || null;
  const note = String(body.note || '').trim().slice(0, 255) || null;

  const result = await withTransaction(async (conn) => {
    const [[row]] = await conn.query(`${SELECT} c.certificate_id = ? FOR UPDATE`, [certificateId]);
    if (!row) throw httpError(404, 'Certificate not found');
    if (row.degree_issued_at) {
      throw httpError(409, `The degree certificate was already collected on ${longDate(row.degree_issued_at)}${row.degree_issued_by_name ? ` (recorded by ${row.degree_issued_by_name})` : ''}.`);
    }
    await conn.query(
      'UPDATE certificates SET degree_issued_at = NOW(), degree_issued_by = ?, degree_serial_no = ?, degree_note = ? WHERE certificate_id = ?',
      [user.sub, serial, note, certificateId]
    );
    await logAudit({ ...actorFrom(user), action: 'degree.issue', entity: 'certificate', entityId: certificateId, detail: { certificate_no: row.certificate_no, matric_no: row.matric_no, serial_no: serial, note } }, conn);
    await notifyStudent(row.student_id, `Your degree certificate was collected at the Registry on ${longDate(new Date())}. Congratulations!`, conn, '/student');
    const [[updated]] = await conn.query(`${SELECT} c.certificate_id = ?`, [certificateId]);
    return view(updated);
  });
  return result;
}

/** GET /api/registry/collected  most recent collections first. */
export async function listCollections({ limit = 100 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [rows] = await pool.query(`${SELECT} c.degree_issued_at IS NOT NULL ORDER BY c.degree_issued_at DESC LIMIT ${max}`);
  return rows.map(view);
}
