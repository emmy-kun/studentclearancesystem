import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import pool from '../config/db.js';
import httpError from '../utils/httpError.js';

/** Payload per spec: { sub, userType, role, department_id, faculty_id }. */
export function signToken({ sub, userType, role, department_id = null, faculty_id = null }) {
  return jwt.sign({ sub, userType, role, department_id, faculty_id }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
  });
}

async function loadStaff(staffId) {
  const [[row]] = await pool.query(
    `SELECT staff_id, full_name, email, role, department_id, faculty_id, must_change_password, is_active
       FROM staff WHERE staff_id = ?`,
    [staffId]
  );
  return row;
}

async function loadStudent(studentId) {
  const [[row]] = await pool.query(
    `SELECT s.student_id, s.department_id, d.faculty_id
       FROM students s JOIN departments d ON d.department_id = s.department_id
      WHERE s.student_id = ?`,
    [studentId]
  );
  return row;
}

/**
 * Verifies the Bearer token and sets req.user = { sub, userType, role, department_id, faculty_id, mustChangePassword }.
 *
 * Staff tokens are re-checked against the database on every request, so a
 * deactivated account or a changed role/scope takes effect immediately rather
 * than when the token expires. A staff member who still has to change their
 * password can only reach routes that opt in with allowPendingPasswordChange.
 */
export function authenticate({ allowPendingPasswordChange = false } = {}) {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw httpError(401, 'Authentication required');

    let payload;
    try {
      payload = jwt.verify(token, env.jwt.secret);
    } catch {
      throw httpError(401, 'Session expired or invalid. Please log in again.');
    }

    if (payload.userType === 'staff') {
      const staff = await loadStaff(payload.sub);
      if (!staff || !staff.is_active) throw httpError(401, 'Account is not active');
      if (staff.role !== payload.role || staff.department_id !== payload.department_id || staff.faculty_id !== payload.faculty_id) {
        throw httpError(401, 'Your account was updated. Please log in again.');
      }
      req.user = {
        sub: staff.staff_id,
        userType: 'staff',
        role: staff.role,
        department_id: staff.department_id,
        faculty_id: staff.faculty_id,
        mustChangePassword: Boolean(staff.must_change_password),
      };
      if (req.user.mustChangePassword && !allowPendingPasswordChange) {
        throw httpError(403, 'You must change your password before continuing', { code: 'PASSWORD_CHANGE_REQUIRED' });
      }
    } else if (payload.userType === 'student') {
      const student = await loadStudent(payload.sub);
      if (!student) throw httpError(401, 'Account not found');
      req.user = {
        sub: student.student_id,
        userType: 'student',
        role: 'student',
        department_id: student.department_id,
        faculty_id: student.faculty_id,
        mustChangePassword: false,
      };
    } else {
      throw httpError(401, 'Invalid token');
    }
    next();
  };
}

export const requireAuth = authenticate();
