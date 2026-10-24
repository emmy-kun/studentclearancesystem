// Student auth provider: reg (matric) number + the password the student chose
// at sign-up. Sign-up itself (routes/auth.js) checks the reg number and name
// against the imported class list before an account can be created.
//
// LIMITATION (state in the report): a reg number and name are not secrets, so
// someone could sign up as another student before they do. The real student is
// told the account exists and the Admin can reset it; every sign-up is audit-logged.
// Production would replace this with the university's SSO (uniSsoProvider.js).
//
// Provider contract: authenticate(credentials) -> student record | null
import bcrypt from 'bcrypt';
import pool from '../config/db.js';
import { requireFields } from '../utils/httpError.js';

export const name = 'password';

// Compared against when there is no account, so timing does not reveal which reg numbers have signed up.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export async function authenticate(body) {
  requireFields(body, ['matric_no', 'password']);
  const [[student]] = await pool.query(
    `SELECT s.student_id, s.department_id, d.faculty_id, s.password_hash
       FROM students s JOIN departments d ON d.department_id = s.department_id
      WHERE s.matric_no = ?`,
    [body.matric_no.trim()]
  );
  const ok = await bcrypt.compare(body.password, student?.password_hash ?? DUMMY_HASH);
  return student?.password_hash && ok ? student : null;
}
