// Student auth provider for simulated data: a student is identified when matric
// number, email, full name and department all match one imported record
// (case-insensitive, trimmed, inner spaces collapsed; department by name).
//
// LIMITATION (state in the report): none of these four details is a secret, so
// this is only acceptable for simulated data. Production would swap in
// uniSsoProvider.js (university SSO) or a password + one-time code provider.
//
// Provider contract: authenticate(credentials) -> student record | null
import pool from '../config/db.js';
import { normalize, requireFields } from '../utils/httpError.js';

export const name = 'localRecord';

export async function authenticate(body) {
  requireFields(body, ['matric_no', 'email', 'full_name', 'department']);

  // utf8mb4_unicode_ci makes these comparisons case-insensitive.
  const [rows] = await pool.query(
    `SELECT s.student_id, s.matric_no, s.full_name, s.email, s.department_id,
            d.name AS department, d.faculty_id, f.name AS faculty
       FROM students s
       JOIN departments d ON d.department_id = s.department_id
       JOIN faculties f ON f.faculty_id = d.faculty_id
      WHERE s.matric_no = ? AND s.email = ?`,
    [body.matric_no.trim(), body.email.trim()]
  );
  const student = rows[0];
  if (!student) return null;

  const nameMatches = normalize(student.full_name) === normalize(body.full_name);
  const deptMatches = normalize(student.department) === normalize(body.department);
  return nameMatches && deptMatches ? student : null;
}
