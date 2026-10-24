// Forgot password: emailed one-time link, then a new password. Uses a fake SMTP
// transport to catch the emails. Restores everything it changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';

process.env.LOGIN_RATE_LIMIT = '1000';
process.env.LOOKUP_RATE_LIMIT = '1000';
process.env.RESET_RATE_LIMIT = '1000';
const { default: app } = await import('../src/app.js');
const { default: pool } = await import('../src/config/db.js');
const { default: env } = await import('../src/config/env.js');
const { setTransport } = await import('../src/services/emailService.js');

const STAFF_EMAIL = 'reset.test.officer@gmail.com';
const STUDENT_EMAIL = 'reset.test.student@gmail.com';
const sent = [];
const fakeTransport = { sendMail: async (m) => sent.push(m) };
let server, base, student, original, staffId;
const saved = { enabled: env.email.enabled, provider: env.email.provider };

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const linkIn = (mail) => /reset-password\?token=([a-f0-9]{64})/.exec(mail.text)?.[1];
const clearResets = () => pool.query("DELETE FROM password_resets WHERE (user_type = 'student' AND user_id = ?) OR (user_type = 'staff' AND user_id = ?)", [student.student_id, staffId]);

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  // A class-list student who is not used by the other test files.
  [[student]] = await pool.query("SELECT student_id, matric_no FROM students WHERE matric_no LIKE '2022/%' ORDER BY matric_no DESC LIMIT 1");
  [[original]] = await pool.query('SELECT email, password_hash, registered_at FROM students WHERE student_id = ?', [student.student_id]);
  await pool.query('UPDATE students SET email = ?, password_hash = ?, registered_at = NOW() WHERE student_id = ?', [STUDENT_EMAIL, await bcrypt.hash('OldStudentPass1', 4), student.student_id]);
  await pool.query('DELETE FROM staff WHERE email = ?', [STAFF_EMAIL]);
  const [r] = await pool.query("INSERT INTO staff (full_name, email, role, password_hash, must_change_password) VALUES ('Reset Test Officer', ?, 'library', ?, TRUE)", [STAFF_EMAIL, await bcrypt.hash('OldStaffPass1', 4)]);
  staffId = r.insertId;
  await clearResets();
  env.email.enabled = true;
  env.email.provider = 'smtp';
  setTransport(fakeTransport);
});

after(async () => {
  env.email.enabled = saved.enabled;
  env.email.provider = saved.provider;
  setTransport();
  await clearResets();
  await pool.query('DELETE FROM staff WHERE staff_id = ?', [staffId]);
  await pool.query('UPDATE students SET email = ?, password_hash = ?, registered_at = ? WHERE student_id = ?', [original.email, original.password_hash, original.registered_at, student.student_id]);
  server.close();
  await pool.end();
});

test('unknown accounts get the same reply, and no email', async () => {
  for (const body of [
    { user_type: 'student', identifier: '2022/000001' },
    { user_type: 'student', identifier: 'nobody@gmail.com' },
    { user_type: 'staff', identifier: 'nobody@gmail.com' },
  ]) {
    const res = await api('POST', '/auth/forgot-password', body);
    assert.equal(res.status, 200);
    assert.match(res.body.message, /If an account matches/);
  }
  assert.equal(sent.length, 0);
  assert.equal((await api('POST', '/auth/forgot-password', { user_type: 'admin', identifier: 'x' })).status, 400);
});

test('a student asks with their reg number and gets a one-time link by email', async () => {
  const res = await api('POST', '/auth/forgot-password', { user_type: 'student', identifier: student.matric_no });
  assert.equal(res.status, 200);
  assert.match(res.body.message, /If an account matches/, 'same reply as for unknown accounts');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, STUDENT_EMAIL);
  const token = linkIn(sent[0]);
  assert.ok(token, 'the email contains the reset link');
  assert.match(sent[0].text, /\/student\/reset-password\?token=/);

  const [[row]] = await pool.query("SELECT token_hash FROM password_resets WHERE user_type = 'student' AND user_id = ? AND used_at IS NULL", [student.student_id]);
  assert.notEqual(row.token_hash, token, 'only a hash is stored');

  // Asking again straight away does not send another email.
  await api('POST', '/auth/forgot-password', { user_type: 'student', identifier: STUDENT_EMAIL });
  assert.equal(sent.length, 1);

  assert.deepEqual((await api('GET', `/auth/reset-password/check?token=${token}`)).body, { valid: true, user_type: 'student' });
  assert.equal((await api('POST', '/auth/reset-password', { token, password: 'short' })).status, 400);

  const done = await api('POST', '/auth/reset-password', { token, password: 'NewStudentPass2' });
  assert.equal(done.status, 200);
  assert.equal(done.body.user_type, 'student');
  assert.match(sent[1].text, /password for your clearance account was just changed/, 'the owner is told');

  assert.equal((await api('POST', '/auth/student/login', { matric_no: student.matric_no, password: 'OldStudentPass1' })).status, 401);
  assert.equal((await api('POST', '/auth/student/login', { matric_no: student.matric_no, password: 'NewStudentPass2' })).status, 200);

  // The link works once.
  assert.deepEqual((await api('GET', `/auth/reset-password/check?token=${token}`)).body, { valid: false });
  assert.equal((await api('POST', '/auth/reset-password', { token, password: 'AnotherPass3' })).status, 400);
  const [[log]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.password_reset' AND entity = 'student' AND entity_id = ?", [student.student_id]);
  assert.ok(log.n >= 1);
});

test('staff reset by email; the new password needs no forced change; only the newest link works', async () => {
  sent.length = 0;
  await api('POST', '/auth/forgot-password', { user_type: 'staff', identifier: STAFF_EMAIL.toUpperCase() });
  const first = linkIn(sent[0]);
  assert.match(sent[0].text, /\/staff\/reset-password\?token=/);
  // Pretend a minute has passed, then ask again: the first link stops working.
  await pool.query("UPDATE password_resets SET created_at = NOW() - INTERVAL 2 MINUTE WHERE user_type = 'staff' AND user_id = ?", [staffId]);
  await api('POST', '/auth/forgot-password', { user_type: 'staff', identifier: STAFF_EMAIL });
  const second = linkIn(sent[1]);
  assert.notEqual(first, second);
  assert.equal((await api('GET', `/auth/reset-password/check?token=${first}`)).body.valid, false);

  assert.equal((await api('POST', '/auth/reset-password', { token: second, password: 'NewStaffPass2' })).status, 200);
  const login = await api('POST', '/auth/staff/login', { email: STAFF_EMAIL, password: 'NewStaffPass2' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.must_change_password, false);
});

test('expired links, malformed tokens and deactivated staff are refused', async () => {
  sent.length = 0;
  await pool.query("UPDATE password_resets SET created_at = NOW() - INTERVAL 2 MINUTE WHERE user_type = 'staff' AND user_id = ?", [staffId]);
  await api('POST', '/auth/forgot-password', { user_type: 'staff', identifier: STAFF_EMAIL });
  const token = linkIn(sent[0]);
  await pool.query("UPDATE password_resets SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE user_type = 'staff' AND user_id = ?", [staffId]);
  assert.equal((await api('POST', '/auth/reset-password', { token, password: 'Whatever123' })).status, 400);
  assert.equal((await api('GET', '/auth/reset-password/check?token=abc')).body.valid, false);

  await pool.query('UPDATE staff SET is_active = FALSE WHERE staff_id = ?', [staffId]);
  await pool.query("UPDATE password_resets SET created_at = NOW() - INTERVAL 2 MINUTE WHERE user_type = 'staff' AND user_id = ?", [staffId]);
  sent.length = 0;
  await api('POST', '/auth/forgot-password', { user_type: 'staff', identifier: STAFF_EMAIL });
  assert.equal(sent.length, 0, 'no link for a deactivated account');
});
