// Admin API (build step 9/10). Removes everything it creates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.LOGIN_RATE_LIMIT = '1000';
const { default: app } = await import('../src/app.js');
const { default: env } = await import('../src/config/env.js');
const { default: pool } = await import('../src/config/db.js');
const { signToken } = await import('../src/middleware/auth.js');
const { startRequest } = await import('../src/services/workflowEngine.js');

const STUDENT = '2022/246818';
const tok = {};
const ids = {};
let server, base, original;

async function api(method, p, { body, token = tok.admin } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

async function cleanup() {
  const [[s]] = await pool.query('SELECT student_id FROM students WHERE matric_no = ?', [STUDENT]);
  const [reqs] = await pool.query('SELECT request_id FROM clearance_requests WHERE student_id = ?', [s.student_id]);
  for (const { request_id } of reqs) {
    await pool.query('DELETE FROM payments WHERE request_id = ?', [request_id]);
    for (const sl of (await pool.query('SELECT sl.file_path FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [request_id]))[0]) fs.rmSync(path.join(env.uploads.dir, sl.file_path), { force: true });
    await pool.query('DELETE sl FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [request_id]);
    await pool.query('DELETE FROM clearance_stages WHERE request_id = ?', [request_id]);
    await pool.query('DELETE FROM clearance_requests WHERE request_id = ?', [request_id]);
  }
  await pool.query("DELETE FROM notifications WHERE recipient_type = 'student' AND recipient_id = ?", [s.student_id]);
  await pool.query("DELETE FROM students WHERE matric_no LIKE '1999/%'");
  await pool.query("DELETE FROM departments WHERE name LIKE 'Admin Test %'");
  await pool.query("DELETE FROM faculties WHERE name LIKE 'Admin Test %'");
  await pool.query("DELETE FROM required_documents WHERE name LIKE 'Admin test %'");
  await pool.query("DELETE n FROM notifications n JOIN staff s ON s.staff_id = n.recipient_id WHERE n.recipient_type = 'staff' AND s.email LIKE 'admin.test.%@clearance.test'");
  await pool.query("DELETE FROM import_batches WHERE imported_by IN (SELECT staff_id FROM staff WHERE email LIKE 'admin.test.%@clearance.test')");
  await pool.query("DELETE FROM staff WHERE email LIKE 'admin.test.%@clearance.test'");
}

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await cleanup();
  for (const role of ['admin', 'library']) {
    const [r] = await pool.query("INSERT INTO staff (full_name, email, role, password_hash, must_change_password) VALUES (?, ?, ?, 'x', FALSE)", [`Admin Test ${role}`, `admin.test.${role}@clearance.test`, role]);
    ids[role] = r.insertId;
    tok[role] = signToken({ sub: r.insertId, userType: 'staff', role, department_id: null, faculty_id: null });
  }
  const [[s]] = await pool.query('SELECT s.student_id, s.department_id, s.results_released, s.password_hash, s.registered_at, d.faculty_id FROM students s JOIN departments d USING (department_id) WHERE matric_no = ?', [STUDENT]);
  ids.student = s.student_id;
  ids.cs = s.department_id;
  original = s;
  tok.student = signToken({ sub: s.student_id, userType: 'student', role: 'student', department_id: s.department_id, faculty_id: s.faculty_id });
});

after(async () => {
  await pool.query('UPDATE students SET results_released = ?, password_hash = ?, registered_at = ? WHERE student_id = ?', [original.results_released, original.password_hash, original.registered_at, ids.student]);
  await cleanup();
  server.close();
  await pool.end();
});

test('only the admin can use admin routes', async () => {
  for (const who of ['library', 'student']) assert.equal((await api('GET', '/admin/dashboard', { token: tok[who] })).status, 403, who);
  assert.equal((await api('GET', '/admin/dashboard', { token: null })).status, 401);
});

test('dashboard reports counts, stages, bottleneck and departments', async () => {
  const res = await api('GET', '/admin/dashboard');
  assert.equal(res.status, 200);
  assert.ok(res.body.students.total >= 557);
  assert.equal(res.body.stages.length, 9);
  assert.ok('completion_rate' in res.body.requests);
  assert.ok(res.body.departments.some((d) => d.department === 'Computer Science'));
});

test('admin creates a departmental officer; scope rules are enforced; the temp password works once', async () => {
  assert.equal((await api('POST', '/admin/staff', { body: { full_name: 'X', email: 'admin.test.bad@clearance.test', role: 'departmental' } })).status, 400, 'department required');
  assert.equal((await api('POST', '/admin/staff', { body: { full_name: 'X', email: 'admin.test.bad@clearance.test', role: 'bursary' } })).status, 400, 'no bursary role');
  const res = await api('POST', '/admin/staff', { body: { full_name: 'Mr. Obi', email: 'admin.test.obi@clearance.test', role: 'departmental', department_id: ids.cs } });
  assert.equal(res.status, 201);
  assert.equal(res.body.temporary_password.length, 12);
  ids.obi = res.body.staff_id;
  assert.equal((await api('POST', '/admin/staff', { body: { full_name: 'Again', email: 'admin.test.obi@clearance.test', role: 'library' } })).status, 409);

  const login = await api('POST', '/auth/staff/login', { token: null, body: { email: 'admin.test.obi@clearance.test', password: res.body.temporary_password } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.must_change_password, true);
  assert.equal(login.body.user.department, 'Computer Science');
});

test('admin deactivates and reactivates staff, resets passwords, but cannot lock themself out', async () => {
  assert.equal((await api('PATCH', `/admin/staff/${ids.obi}`, { body: { is_active: false } })).status, 200);
  const list = (await api('GET', '/admin/staff')).body.items;
  assert.equal(list.find((s) => s.staff_id === ids.obi).is_active, false);
  assert.equal((await api('PATCH', `/admin/staff/${ids.obi}`, { body: { is_active: true } })).status, 200);
  const reset = await api('POST', `/admin/staff/${ids.obi}/reset-password`);
  assert.equal(reset.status, 200);
  assert.ok(reset.body.temporary_password);
  assert.equal((await api('PATCH', `/admin/staff/${ids.admin}`, { body: { is_active: false } })).status, 400);
  assert.equal((await api('PATCH', `/admin/staff/${ids.admin}`, { body: { role: 'library' } })).status, 400);
});

test('faculties and departments can be added and renamed; duplicates are refused', async () => {
  const f = await api('POST', '/admin/faculties', { body: { name: 'Admin Test Faculty' } });
  assert.equal(f.status, 201);
  assert.equal((await api('POST', '/admin/faculties', { body: { name: 'Admin Test Faculty' } })).status, 409);
  const d = await api('POST', '/admin/departments', { body: { name: 'Admin Test Dept', faculty_id: f.body.faculty_id } });
  assert.equal(d.status, 201);
  assert.equal((await api('PATCH', `/admin/departments/${d.body.department_id}`, { body: { name: 'Admin Test Dept Renamed', faculty_id: f.body.faculty_id } })).status, 200);
  const structure = (await api('GET', '/admin/faculties')).body.items;
  assert.ok(structure.find((x) => x.faculty_id === f.body.faculty_id).departments.some((x) => x.name === 'Admin Test Dept Renamed'));
  assert.equal((await api('DELETE', `/admin/departments/${d.body.department_id}`)).status, 200);
  assert.equal((await api('DELETE', `/admin/departments/${ids.cs}`)).status, 409, 'department with students cannot be deleted');
});

test('required documents can be added, edited and removed (if unused)', async () => {
  const res = await api('POST', '/admin/required-documents', { body: { stage_key: 'alumni', name: 'Admin test alumni form', reference_label: 'Form no.', is_required: false } });
  assert.equal(res.status, 201);
  const id = res.body.required_doc_id;
  assert.equal((await api('PATCH', `/admin/required-documents/${id}`, { body: { name: 'Admin test alumni form v2', collects_amount: true } })).status, 200);
  const stages = (await api('GET', '/admin/required-documents')).body.stages;
  const doc = stages.find((s) => s.stage_key === 'alumni').documents.find((d) => d.required_doc_id === id);
  assert.equal(doc.name, 'Admin test alumni form v2');
  assert.equal(doc.collects_amount, true);
  assert.equal(doc.is_required, false);
  assert.equal((await api('POST', '/admin/required-documents', { body: { stage_key: 'nowhere', name: 'Admin test x' } })).status, 400);
  assert.equal((await api('DELETE', `/admin/required-documents/${id}`)).status, 200);
});

test('CSV import through the admin route adds students and reports problems', async () => {
  const csv = 'matric_no,full_name,email,department,faculty\n1999/000001,ADMIN TEST ONE,admin.one@clearance.test,Admin Test Imported,Admin Test Imported Faculty\n1999/000002,ADMIN TEST TWO,,Computer Science,Physical Sciences\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'class.csv');
  const res = await fetch(`${base}/admin/students/import`, { method: 'POST', headers: { authorization: `Bearer ${tok.admin}` }, body: form });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.rows_imported, 1);
  assert.equal(body.rows_failed, 1);
  assert.equal(body.departments_created, 1);
  const list = (await api('GET', '/admin/students?search=1999/000001')).body;
  assert.equal(list.items[0].department, 'Admin Test Imported');
});


test('admin can reset a student account so they can sign up again', async () => {
  await pool.query("UPDATE students SET password_hash = 'x', registered_at = NOW() WHERE student_id = ?", [ids.student]);
  assert.equal((await api('POST', `/admin/students/${ids.student}/reset-account`)).status, 200);
  const [[s]] = await pool.query('SELECT password_hash, registered_at FROM students WHERE student_id = ?', [ids.student]);
  assert.equal(s.password_hash, null);
  assert.equal(s.registered_at, null);
});

test('requests list, audit log and PDF report', async () => {
  await startRequest(ids.student);
  const reqs = (await api('GET', '/admin/requests?search=2022/246818')).body;
  assert.equal(reqs.items.length, 1);
  assert.equal(reqs.items[0].total_stages, 9);
  const logs = (await api('GET', '/admin/audit-logs?action=staff.')).body;
  assert.ok(logs.items.some((l) => l.action === 'staff.create' && l.actor_name === 'Admin Test admin'));
  const pdf = await api('GET', '/admin/reports/clearance.pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
});
