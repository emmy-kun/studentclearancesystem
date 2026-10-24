// Notifications and optional email (build step 8). Removes everything it creates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { default: app } = await import('../src/app.js');
const { default: pool, withTransaction } = await import('../src/config/db.js');
const { default: env } = await import('../src/config/env.js');
const { signToken } = await import('../src/middleware/auth.js');
const { startRequest } = await import('../src/services/workflowEngine.js');
const { notifyStudent } = await import('../src/services/notificationService.js');
const { setTransport } = await import('../src/services/emailService.js');

const A = '2022/246092';
const B = '2022/241268';
const tok = {};
const ids = {};
let server, base, originalEmail;
const sent = [];
const fakeTransport = { async sendMail(m) { sent.push(m); return { messageId: 'x' }; } };
const tick = () => new Promise((r) => setTimeout(r, 50));

async function api(method, p, { token } = {}) {
  const res = await fetch(base + p, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
}

async function cleanup() {
  for (const matric of [A, B]) {
    const [[s]] = await pool.query('SELECT student_id FROM students WHERE matric_no = ?', [matric]);
    const [reqs] = await pool.query('SELECT request_id FROM clearance_requests WHERE student_id = ?', [s.student_id]);
    for (const { request_id } of reqs) {
      await pool.query('DELETE FROM payments WHERE request_id = ?', [request_id]);
      for (const sl of (await pool.query('SELECT sl.file_path FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [request_id]))[0]) fs.rmSync(path.join(env.uploads.dir, sl.file_path), { force: true });
      await pool.query('DELETE sl FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [request_id]);
      await pool.query('DELETE FROM clearance_stages WHERE request_id = ?', [request_id]);
      await pool.query('DELETE FROM clearance_requests WHERE request_id = ?', [request_id]);
    }
    await pool.query("DELETE FROM notifications WHERE recipient_type = 'student' AND recipient_id = ?", [s.student_id]);
  }
  await pool.query("DELETE n FROM notifications n JOIN staff s ON s.staff_id = n.recipient_id WHERE n.recipient_type = 'staff' AND s.email LIKE 'notif.test.%@clearance.test'");
  await pool.query("DELETE FROM staff WHERE email LIKE 'notif.test.%@clearance.test'");
}

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await cleanup();
  for (const [key, matric] of [['a', A], ['b', B]]) {
    const [[s]] = await pool.query('SELECT s.student_id, s.email, s.department_id, d.faculty_id FROM students s JOIN departments d USING (department_id) WHERE matric_no = ?', [matric]);
    tok[key] = signToken({ sub: s.student_id, userType: 'student', role: 'student', department_id: s.department_id, faculty_id: s.faculty_id });
    ids[key] = s.student_id;
    if (key === 'a') originalEmail = s.email;
  }
  const [[cs]] = await pool.query("SELECT department_id FROM departments WHERE name = 'Computer Science'");
  const [r] = await pool.query("INSERT INTO staff (full_name, email, role, department_id, password_hash, must_change_password) VALUES ('Notif Test', 'notif.test.dept@clearance.test', 'departmental', ?, 'x', FALSE)", [cs.department_id]);
  ids.staff = r.insertId;
  tok.staff = signToken({ sub: r.insertId, userType: 'staff', role: 'departmental', department_id: cs.department_id, faculty_id: null });
});

const originalProvider = env.email.provider;
const originalEmailJs = { ...env.email.emailjs };

after(async () => {
  env.email.enabled = false;
  env.email.provider = originalProvider;
  env.email.emailjs = originalEmailJs;
  setTransport();
  await pool.query('UPDATE students SET email = ? WHERE student_id = ?', [originalEmail, ids.a]);
  await cleanup();
  server.close();
  await pool.end();
});

test('starting clearance notifies the student; list shows newest first with an unread count', async () => {
  await startRequest(ids.a);
  const res = await api('GET', '/notifications', { token: tok.a });
  assert.equal(res.status, 200);
  assert.equal(res.body.unread_count, 2, 'departmental + convocation opened');
  assert.equal(res.body.items.length, 2);
  assert.ok(res.body.items[0].notification_id > res.body.items[1].notification_id);
  assert.ok(res.body.items.every((n) => n.is_read === false));
  assert.ok(res.body.items.some((n) => /Convocation Fee is now open/.test(n.message)));
  // Each one opens the stage it is about.
  const [stages] = await pool.query("SELECT cs.stage_id, cs.stage_key FROM clearance_stages cs JOIN clearance_requests cr ON cr.request_id = cs.request_id WHERE cr.student_id = ?", [ids.a]);
  const conv = stages.find((x) => x.stage_key === 'convocation');
  assert.equal(res.body.items.find((n) => /Convocation Fee is now open/.test(n.message)).link, `/student/stage/${conv.stage_id}`);
});

test("users never see or change other people's notifications", async () => {
  assert.equal((await api('GET', '/notifications', { token: tok.b })).body.items.length, 0);
  assert.equal((await api('GET', '/notifications', { token: tok.staff })).body.items.length, 0);
  const id = (await api('GET', '/notifications', { token: tok.a })).body.items[0].notification_id;
  assert.equal((await api('PATCH', `/notifications/${id}/read`, { token: tok.b })).status, 404);
  assert.equal((await api('PATCH', `/notifications/${id}/read`, { token: tok.staff })).status, 404, 'same id space, different recipient type');
  assert.equal((await api('GET', '/notifications')).status, 401);
});

test('mark one as read, filter unread, then mark all read', async () => {
  const list = (await api('GET', '/notifications', { token: tok.a })).body.items;
  assert.equal((await api('PATCH', `/notifications/${list[0].notification_id}/read`, { token: tok.a })).status, 200);
  const unread = (await api('GET', '/notifications?unread=1', { token: tok.a })).body;
  assert.equal(unread.unread_count, 1);
  assert.deepEqual(unread.items.map((n) => n.notification_id), [list[1].notification_id]);

  const all = await api('PATCH', '/notifications/read-all', { token: tok.a });
  assert.equal(all.body.updated, 1);
  assert.equal((await api('GET', '/notifications', { token: tok.a })).body.unread_count, 0);
});

test('staff see their own notifications', async () => {
  await pool.query("INSERT INTO notifications (recipient_id, recipient_type, message) VALUES (?, 'staff', 'New Departmental Clearance submission: test')", [ids.staff]);
  const res = await api('GET', '/notifications', { token: tok.staff });
  assert.equal(res.body.unread_count, 1);
  assert.match(res.body.items[0].message, /New Departmental Clearance submission/);
});

test('with email off, nothing is emailed', async () => {
  env.email.enabled = false;
  env.email.provider = 'smtp';
  setTransport(fakeTransport);
  await notifyStudent(ids.a, 'Email-off check');
  await tick();
  assert.equal(sent.length, 0);
});

test('with email on, a copy is sent only after the change commits', async () => {
  env.email.enabled = true;
  await pool.query("UPDATE students SET email = 'notif.check@gmail.com' WHERE student_id = ?", [ids.a]);

  await withTransaction(async (conn) => {
    await notifyStudent(ids.a, 'Library Clearance approved.', conn);
    await tick();
    assert.equal(sent.length, 0, 'not sent before commit');
  });
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'notif.check@gmail.com');
  assert.equal(sent[0].subject, 'Clearance: Library Clearance approved.');
  assert.match(sent[0].text, /Library Clearance approved\./);
});

test('a rolled-back change sends no email and leaves no notification', async () => {
  sent.length = 0;
  await assert.rejects(
    withTransaction(async (conn) => {
      await notifyStudent(ids.a, 'This should never arrive', conn);
      throw new Error('simulated failure');
    }),
    /simulated failure/
  );
  await tick();
  assert.equal(sent.length, 0);
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND message = 'This should never arrive'", [ids.a]);
  assert.equal(n.n, 0);
});

test('reserved test addresses are never emailed, and SMTP failures do not break the workflow', async () => {
  sent.length = 0;
  await pool.query("UPDATE students SET email = 'someone@clearance.test' WHERE student_id = ?", [ids.a]);
  await notifyStudent(ids.a, 'To a .test address');
  await tick();
  assert.equal(sent.length, 0);

  await pool.query("UPDATE students SET email = 'notif.check@gmail.com' WHERE student_id = ?", [ids.a]);
  setTransport({ async sendMail() { throw new Error('SMTP down'); } });
  const origError = console.error;
  console.error = () => {};
  try {
    await notifyStudent(ids.a, 'SMTP is down but this still saves');
    await tick();
  } finally {
    console.error = origError;
  }
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND message = 'SMTP is down but this still saves'", [ids.a]);
  assert.equal(n.n, 1);
});

test('EmailJS provider posts the template parameters to the EmailJS API', async () => {
  env.email.enabled = true;
  env.email.provider = 'emailjs';
  env.email.emailjs = { serviceId: 'service_test', templateId: 'template_test', publicKey: 'pub_test', privateKey: 'priv_test' };
  await pool.query("UPDATE students SET email = 'notif.check@gmail.com' WHERE student_id = ?", [ids.a]);

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.emailjs.com/')) {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('OK', { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    await notifyStudent(ids.a, 'Alumni Clearance approved.', undefined, '/student/stage/42');
    await tick();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.emailjs.com/api/v1.0/email/send');
  assert.deepEqual(calls[0].body, {
    service_id: 'service_test',
    template_id: 'template_test',
    user_id: 'pub_test',
    accessToken: 'priv_test',
    template_params: {
      to_email: 'notif.check@gmail.com',
      to_name: 'ADOYI PRAISE OWOICHO-EGBE',
      subject: 'Clearance: Alumni Clearance approved.',
      message: 'Alumni Clearance approved.',
      app_url: `${env.appBaseUrl}/student/stage/42`,
    },
  });
});
