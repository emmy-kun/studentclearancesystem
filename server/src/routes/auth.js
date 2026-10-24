import { Router } from 'express';
import bcrypt from 'bcrypt';
import pool from '../config/db.js';
import { studentAuthProvider } from '../authProviders/index.js';
import { signToken, authenticate } from '../middleware/auth.js';
import { loginLimiter, lookupLimiter, resetLimiter } from '../middleware/rateLimit.js';
import { requestReset, checkReset, resetPassword, GENERIC_REPLY } from '../services/passwordResetService.js';
import { logAudit } from '../services/auditLog.js';
import httpError, { requireFields, normalize } from '../utils/httpError.js';

const router = Router();

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Reserved test domains (RFC 2606). Paystack refuses them, so students could not pay.
const RESERVED_EMAIL = /\.(test|example|invalid|localhost)$/i;

// What the login page shows after a reg number is typed. Surname + initials
// ("ABAH P. C.") lets the student recognise themselves without exposing every
// classmate's full name. Set to false to show full names instead.
const MASK_LOOKUP_NAMES = true;

export function maskName(fullName) {
  const [surname, ...rest] = fullName.trim().split(/\s+/);
  return [surname, ...rest.map((n) => `${n[0]}.`)].join(' ');
}
// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

/** "2025/2026" -> 2026 (shown as "Class of 2026"). */
function classOf(session) {
  const m = /^\d{4}\/(\d{4})$/.exec(session || '');
  return m ? Number(m[1]) : null;
}

export async function getProfile(user) {
  if (user.userType === 'student') {
    const [[s]] = await pool.query(
      `SELECT s.student_id, s.matric_no, s.full_name, s.email, s.levels_count, s.graduation_session,
              s.accommodation_type, s.phone,
              d.department_id, d.name AS department, f.faculty_id, f.name AS faculty
         FROM students s
         JOIN departments d ON d.department_id = s.department_id
         JOIN faculties f ON f.faculty_id = d.faculty_id
        WHERE s.student_id = ?`,
      [user.sub]
    );
    return {
      userType: 'student',
      role: 'student',
      id: s.student_id,
      full_name: s.full_name,
      matric_no: s.matric_no,
      email: s.email,
      department_id: s.department_id,
      department: s.department,
      faculty_id: s.faculty_id,
      faculty: s.faculty,
      levels_count: s.levels_count,
      graduation_session: s.graduation_session,
      class_of: classOf(s.graduation_session),
      accommodation_type: s.accommodation_type,
      phone: s.phone,
    };
  }

  const [[st]] = await pool.query(
    `SELECT s.staff_id, s.full_name, s.email, s.role, s.must_change_password,
            s.department_id, d.name AS department,
            COALESCE(s.faculty_id, d.faculty_id) AS faculty_id, f.name AS faculty
       FROM staff s
       LEFT JOIN departments d ON d.department_id = s.department_id
       LEFT JOIN faculties f ON f.faculty_id = COALESCE(s.faculty_id, d.faculty_id)
      WHERE s.staff_id = ?`,
    [user.sub]
  );
  return {
    userType: 'staff',
    role: st.role,
    id: st.staff_id,
    full_name: st.full_name,
    email: st.email,
    department_id: st.department_id,
    department: st.department,
    faculty_id: st.faculty_id,
    faculty: st.faculty,
    must_change_password: Boolean(st.must_change_password),
  };
}

// GET /api/auth/student/lookup?matric_no=2022/252133
// Login-page name preview. Only students who have signed up are shown.
router.get('/student/lookup', lookupLimiter, async (req, res) => {
  const matric = String(req.query.matric_no || '').trim();
  if (!matric) throw httpError(400, 'matric_no is required');
  const [[s]] = await pool.query(
    `SELECT s.full_name, s.password_hash, d.name AS department
       FROM students s JOIN departments d ON d.department_id = s.department_id
      WHERE s.matric_no = ?`,
    [matric]
  );
  if (!s?.password_hash) throw httpError(404, 'No account found for this reg number. Sign up first.');
  res.json({ display_name: MASK_LOOKUP_NAMES ? maskName(s.full_name) : s.full_name, department: s.department });
});

// POST /api/auth/student/signup { matric_no, full_name, email, password }
// The reg number and full name must match a student on the imported class list.
router.post('/student/signup', loginLimiter, async (req, res) => {
  requireFields(req.body, ['matric_no', 'full_name', 'email', 'password']);
  const email = req.body.email.trim().toLowerCase();
  const { password } = req.body;
  if (!EMAIL.test(email) || RESERVED_EMAIL.test(email)) throw httpError(400, 'Enter a valid email address you can receive mail at');
  if (password.length < MIN_PASSWORD_LENGTH) throw httpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);

  const [[s]] = await pool.query(
    'SELECT student_id, full_name, department_id, password_hash FROM students WHERE matric_no = ?',
    [req.body.matric_no.trim()]
  );
  if (!s || normalize(s.full_name) !== normalize(req.body.full_name)) {
    throw httpError(404, 'We could not find this reg number and name on the class list. Enter your name exactly as it appears on the list.');
  }
  if (s.password_hash) {
    throw httpError(409, 'An account already exists for this reg number. Log in instead. If you did not create it, contact the clearance administrator.');
  }
  const [[taken]] = await pool.query('SELECT student_id FROM students WHERE email = ? AND student_id <> ?', [email, s.student_id]);
  if (taken) throw httpError(409, 'This email is already used by another student');

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // The imported email is a placeholder; the student's own email replaces it.
  // "password_hash IS NULL" guards against two sign-ups racing for the same record.
  const [result] = await pool.query(
    'UPDATE students SET email = ?, password_hash = ?, registered_at = NOW() WHERE student_id = ? AND password_hash IS NULL',
    [email, hash, s.student_id]
  );
  if (result.affectedRows === 0) throw httpError(409, 'An account already exists for this reg number. Log in instead.');

  const [[d]] = await pool.query('SELECT faculty_id FROM departments WHERE department_id = ?', [s.department_id]);
  const user = { sub: s.student_id, userType: 'student', role: 'student', department_id: s.department_id, faculty_id: d.faculty_id };
  await logAudit({ actorType: 'student', actorId: s.student_id, action: 'student.signup', entity: 'student', entityId: s.student_id, detail: { email, ip: req.ip } });
  res.status(201).json({ token: signToken(user), user: await getProfile(user) });
});

// POST /api/auth/student/login { matric_no, password }
router.post('/student/login', loginLimiter, async (req, res) => {
  const student = await studentAuthProvider.authenticate(req.body);
  if (!student) throw httpError(401, 'Incorrect reg number or password');

  const user = { sub: student.student_id, userType: 'student', role: 'student', department_id: student.department_id, faculty_id: student.faculty_id };
  await logAudit({ actorType: 'student', actorId: student.student_id, action: 'auth.login', entity: 'student', entityId: student.student_id, detail: { provider: studentAuthProvider.name } });
  res.json({ token: signToken(user), user: await getProfile(user) });
});

// POST /api/auth/staff/login { email, password }
router.post('/staff/login', loginLimiter, async (req, res) => {
  requireFields(req.body, ['email', 'password']);
  const [[staff]] = await pool.query(
    'SELECT staff_id, role, department_id, faculty_id, password_hash, is_active FROM staff WHERE email = ?',
    [req.body.email.trim()]
  );
  const ok = await bcrypt.compare(req.body.password, staff?.password_hash ?? DUMMY_HASH);
  if (!staff || !ok) throw httpError(401, 'Incorrect email or password');
  if (!staff.is_active) throw httpError(403, 'This account has been deactivated. Contact the system administrator.');

  const user = { sub: staff.staff_id, userType: 'staff', role: staff.role, department_id: staff.department_id, faculty_id: staff.faculty_id };
  await logAudit({ actorType: 'staff', actorId: staff.staff_id, action: 'auth.login', entity: 'staff', entityId: staff.staff_id });
  res.json({ token: signToken(user), user: await getProfile(user) });
});

// POST /api/auth/staff/change-password { current_password, new_password }
router.post('/staff/change-password', authenticate({ allowPendingPasswordChange: true }), async (req, res) => {
  if (req.user.userType !== 'staff') throw httpError(403, 'Only staff accounts have passwords');
  requireFields(req.body, ['current_password', 'new_password']);
  const { current_password, new_password } = req.body;

  if (new_password.length < MIN_PASSWORD_LENGTH) throw httpError(400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (new_password === current_password) throw httpError(400, 'New password must be different from the current one');

  const [[staff]] = await pool.query('SELECT password_hash FROM staff WHERE staff_id = ?', [req.user.sub]);
  if (!(await bcrypt.compare(current_password, staff.password_hash))) throw httpError(400, 'Current password is incorrect');

  const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
  await pool.query('UPDATE staff SET password_hash = ?, must_change_password = FALSE WHERE staff_id = ?', [hash, req.user.sub]);
  await logAudit({ actorType: 'staff', actorId: req.user.sub, action: 'staff.password_change', entity: 'staff', entityId: req.user.sub });
  res.json({ ok: true, user: await getProfile(req.user) });
});

// POST /api/auth/forgot-password { user_type: 'student'|'staff', identifier }
// identifier: a student's reg number or email, or a staff email. Same reply whether or not it matches.
router.post('/forgot-password', resetLimiter, async (req, res) => {
  requireFields(req.body, ['user_type', 'identifier']);
  await requestReset(req.body.user_type, req.body.identifier, req.ip);
  res.json({ ok: true, message: GENERIC_REPLY });
});

// GET /api/auth/reset-password/check?token=
router.get('/reset-password/check', lookupLimiter, async (req, res) => {
  res.json(await checkReset(req.query.token));
});

// POST /api/auth/reset-password { token, password }
router.post('/reset-password', loginLimiter, async (req, res) => {
  requireFields(req.body, ['token', 'password']);
  res.json({ ok: true, ...(await resetPassword(req.body.token, req.body.password)) });
});

export default router;
