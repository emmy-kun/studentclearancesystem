// Integration tests for step 3 (auth). Needs the local MySQL database with the
// seeded data and imported class list. Creates and removes its own staff account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';

process.env.LOGIN_RATE_LIMIT = '1000';
process.env.LOOKUP_RATE_LIMIT = '1000';
const { default: app } = await import('../src/app.js');
const { default: pool } = await import('../src/config/db.js');

const TEST_EMAIL = 'auth.test.officer@clearance.test';
const TEST_PASSWORD = 'InitialPass123';
const STUDENT_MATRIC = '2022/252133';
const STUDENT_PASSWORD = 'StudentPass789';
let server;
let base;
let student;
let originalStudent;

async function api(method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;

  [[student]] = await pool.query(
    `SELECT s.matric_no, s.email, s.full_name, d.name AS department
       FROM students s JOIN departments d ON d.department_id = s.department_id
      WHERE s.matric_no = ?`,
    [STUDENT_MATRIC]
  );
  [[originalStudent]] = await pool.query('SELECT email, password_hash, registered_at FROM students WHERE matric_no = ?', [STUDENT_MATRIC]);
  await pool.query('UPDATE students SET password_hash = NULL, registered_at = NULL WHERE matric_no = ?', [STUDENT_MATRIC]);
  const [[dept]] = await pool.query("SELECT department_id FROM departments WHERE name = 'Computer Science'");
  await pool.query('DELETE FROM staff WHERE email = ?', [TEST_EMAIL]);
  await pool.query(
    `INSERT INTO staff (full_name, email, role, department_id, password_hash, must_change_password)
     VALUES ('Auth Test Officer', ?, 'departmental', ?, ?, TRUE)`,
    [TEST_EMAIL, dept.department_id, await bcrypt.hash(TEST_PASSWORD, 4)]
  );
});

after(async () => {
  await pool.query('DELETE FROM staff WHERE email = ?', [TEST_EMAIL]);
  await pool.query('UPDATE students SET email = ?, password_hash = ?, registered_at = ? WHERE matric_no = ?', [
    originalStudent.email, originalStudent.password_hash, originalStudent.registered_at, STUDENT_MATRIC,
  ]);
  server.close();
  await pool.end();
});

test('lookup says "sign up first" before the student has an account', async () => {
  const res = await api('GET', `/auth/student/lookup?matric_no=${encodeURIComponent(STUDENT_MATRIC)}`);
  assert.equal(res.status, 404);
  assert.match(res.body.error, /Sign up/);
});

test('sign-up rejects a name that does not match the class list', async () => {
  const res = await api('POST', '/auth/student/signup', {
    body: { matric_no: STUDENT_MATRIC, full_name: 'SOMEONE ELSE', email: 'abah.test@example.com', password: STUDENT_PASSWORD },
  });
  assert.equal(res.status, 404);
});

test('sign-up rejects unknown reg numbers, weak passwords and bad emails', async () => {
  const good = { matric_no: STUDENT_MATRIC, full_name: student.full_name, email: 'abah.test@example.com', password: STUDENT_PASSWORD };
  assert.equal((await api('POST', '/auth/student/signup', { body: { ...good, matric_no: '2022/000000' } })).status, 404);
  assert.equal((await api('POST', '/auth/student/signup', { body: { ...good, password: 'short' } })).status, 400);
  assert.equal((await api('POST', '/auth/student/signup', { body: { ...good, email: 'not-an-email' } })).status, 400);
  assert.equal((await api('POST', '/auth/student/signup', { body: { ...good, email: 'abah@clearance.test' } })).status, 400, 'reserved test domain');
  assert.equal((await api('POST', '/auth/student/signup', { body: { matric_no: STUDENT_MATRIC } })).status, 400);
});

test('student signs up with reg no, name (case/spacing ignored), email and password', async () => {
  const res = await api('POST', '/auth/student/signup', {
    body: {
      matric_no: ` ${STUDENT_MATRIC} `,
      full_name: `  ${student.full_name.toLowerCase().replace(' ', '   ')} `,
      email: 'Abah.Test@Example.com',
      password: STUDENT_PASSWORD,
    },
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.full_name, student.full_name);
  assert.equal(res.body.user.email, 'abah.test@example.com');
  assert.equal(res.body.user.department, 'Computer Science');
  assert.equal(res.body.user.faculty, 'Physical Sciences');
  assert.equal(res.body.user.class_of, 2026);
});

test('a second sign-up for the same reg number is refused', async () => {
  const res = await api('POST', '/auth/student/signup', {
    body: { matric_no: STUDENT_MATRIC, full_name: student.full_name, email: 'intruder@example.com', password: 'IntruderPass1' },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already exists/);
});

test('lookup shows surname and initials once signed up', async () => {
  const res = await api('GET', `/auth/student/lookup?matric_no=${encodeURIComponent(STUDENT_MATRIC)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.display_name, 'ABAH P. C.');
  assert.equal(res.body.department, 'Computer Science');
});

test('student logs in with reg number and password', async () => {
  const res = await api('POST', '/auth/student/login', { body: { matric_no: STUDENT_MATRIC, password: STUDENT_PASSWORD } });
  assert.equal(res.status, 200);
  const me = await api('GET', '/me', { token: res.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.matric_no, STUDENT_MATRIC);
});

test('reg numbers typed with a space, dash or no slash (phone keyboards) still work', async () => {
  const digits = STUDENT_MATRIC.replace('/', '');
  for (const typed of [STUDENT_MATRIC.replace('/', ' '), STUDENT_MATRIC.replace('/', '-'), digits, ` ${STUDENT_MATRIC} `]) {
    assert.equal((await api('GET', `/auth/student/lookup?matric_no=${encodeURIComponent(typed)}`)).status, 200, typed);
    assert.equal((await api('POST', '/auth/student/login', { body: { matric_no: typed, password: STUDENT_PASSWORD } })).status, 200, typed);
  }
});

test('normalizeRegNo leaves anything that is not a reg number alone', async () => {
  const { normalizeRegNo } = await import('../src/utils/regNo.js');
  assert.equal(normalizeRegNo('2022248400'), '2022/248400');
  assert.equal(normalizeRegNo('2022\\248400'), '2022/248400');
  assert.equal(normalizeRegNo('CLR-2026-000020'), 'CLR-2026-000020');
  assert.equal(normalizeRegNo('someone@gmail.com'), 'someone@gmail.com');
  assert.equal(normalizeRegNo(undefined), '');
});

test('student login: wrong password and unregistered reg number give the same error', async () => {
  const a = await api('POST', '/auth/student/login', { body: { matric_no: STUDENT_MATRIC, password: 'WrongPass000' } });
  const b = await api('POST', '/auth/student/login', { body: { matric_no: '2022/245074', password: 'WrongPass000' } });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
  assert.equal((await api('POST', '/auth/student/login', { body: { matric_no: STUDENT_MATRIC } })).status, 400);
});

test('staff wrong password and unknown email give the same error', async () => {
  const a = await api('POST', '/auth/staff/login', { body: { email: TEST_EMAIL, password: 'wrong-password' } });
  const b = await api('POST', '/auth/staff/login', { body: { email: 'nobody@clearance.test', password: 'wrong-password' } });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
});

test('new staff must change password before using other routes', async () => {
  const login = await api('POST', '/auth/staff/login', { body: { email: TEST_EMAIL, password: TEST_PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.must_change_password, true);
  assert.equal(login.body.user.department, 'Computer Science');
  const token = login.body.token;

  // /api/me works so the UI can show the change-password screen
  assert.equal((await api('GET', '/me', { token })).status, 200);

  const weak = await api('POST', '/auth/staff/change-password', { token, body: { current_password: TEST_PASSWORD, new_password: 'short' } });
  assert.equal(weak.status, 400);
  const wrongCurrent = await api('POST', '/auth/staff/change-password', { token, body: { current_password: 'nope', new_password: 'NewSecurePass456' } });
  assert.equal(wrongCurrent.status, 400);

  const changed = await api('POST', '/auth/staff/change-password', { token, body: { current_password: TEST_PASSWORD, new_password: 'NewSecurePass456' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.must_change_password, false);

  const relogin = await api('POST', '/auth/staff/login', { body: { email: TEST_EMAIL, password: 'NewSecurePass456' } });
  assert.equal(relogin.status, 200);
});

test('deactivated staff are locked out immediately, even with a valid token', async () => {
  const login = await api('POST', '/auth/staff/login', { body: { email: TEST_EMAIL, password: 'NewSecurePass456' } });
  const token = login.body.token;
  await pool.query('UPDATE staff SET is_active = FALSE WHERE email = ?', [TEST_EMAIL]);

  assert.equal((await api('GET', '/me', { token })).status, 401);
  const again = await api('POST', '/auth/staff/login', { body: { email: TEST_EMAIL, password: 'NewSecurePass456' } });
  assert.equal(again.status, 403);
  await pool.query('UPDATE staff SET is_active = TRUE WHERE email = ?', [TEST_EMAIL]);
});

test('a changed role or scope invalidates old tokens', async () => {
  const login = await api('POST', '/auth/staff/login', { body: { email: TEST_EMAIL, password: 'NewSecurePass456' } });
  await pool.query("UPDATE staff SET role = 'library', department_id = NULL WHERE email = ?", [TEST_EMAIL]);
  assert.equal((await api('GET', '/me', { token: login.body.token })).status, 401);
});

test('missing, malformed and tampered tokens are rejected', async () => {
  assert.equal((await api('GET', '/me')).status, 401);
  assert.equal((await api('GET', '/me', { token: 'garbage' })).status, 401);
  const login = await api('POST', '/auth/student/login', { body: { matric_no: STUDENT_MATRIC, password: STUDENT_PASSWORD } });
  const [h, p, s] = login.body.token.split('.');
  const forged = JSON.parse(Buffer.from(p, 'base64url'));
  forged.role = 'admin';
  const tampered = [h, Buffer.from(JSON.stringify(forged)).toString('base64url'), s].join('.');
  assert.equal((await api('GET', '/me', { token: tampered })).status, 401);
});
