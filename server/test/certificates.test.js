// Application letter, certificate and public verification (build step 7).
// Stages 1-7 are fast-forwarded in the database; the letter and Audit steps go
// through the real API. Removes everything it creates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.VERIFY_RATE_LIMIT = '1000';
const { default: app } = await import('../src/app.js');
const { default: pool } = await import('../src/config/db.js');
const { default: env } = await import('../src/config/env.js');
const { signToken } = await import('../src/middleware/auth.js');
const { startRequest, recheckRequest } = await import('../src/services/workflowEngine.js');

const MATRIC = '2022/243991';
const OTHER = '2022/241385';
const tok = {};
let server, base, student, requestId, certificate;

async function api(method, p, { body, token } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const download = (p, who) => fetch(base + p, { headers: who ? { authorization: `Bearer ${tok[who]}` } : {} });
const mine = async () => (await api('GET', '/clearance/mine', { token: tok.student })).body;
const stageOf = (view, key) => view.stages.find((s) => s.stage_key === key);

async function cleanup() {
  for (const matric of [MATRIC, OTHER]) {
    const [[s]] = await pool.query('SELECT student_id FROM students WHERE matric_no = ?', [matric]);
    const [reqs] = await pool.query('SELECT request_id, letter_path FROM clearance_requests WHERE student_id = ?', [s.student_id]);
    for (const r of reqs) {
      const [certs] = await pool.query('SELECT file_path FROM certificates WHERE request_id = ?', [r.request_id]);
      for (const f of [...certs.map((c) => c.file_path), r.letter_path].filter(Boolean)) fs.rmSync(path.join(env.uploads.dir, f), { force: true });
      await pool.query('DELETE FROM certificates WHERE request_id = ?', [r.request_id]);
      await pool.query('DELETE FROM payments WHERE request_id = ?', [r.request_id]);
      const [docs] = await pool.query('SELECT sd.file_path FROM stage_documents sd JOIN clearance_stages cs ON cs.stage_id = sd.stage_id WHERE cs.request_id = ?', [r.request_id]);
      for (const d of docs) fs.rmSync(path.join(env.uploads.dir, d.file_path), { force: true });
      await pool.query('DELETE sd FROM stage_documents sd JOIN clearance_stages cs ON cs.stage_id = sd.stage_id WHERE cs.request_id = ?', [r.request_id]);
      for (const sl of (await pool.query('SELECT sl.file_path FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [r.request_id]))[0]) fs.rmSync(path.join(env.uploads.dir, sl.file_path), { force: true });
      await pool.query('DELETE sl FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [r.request_id]);
      await pool.query('DELETE FROM clearance_stages WHERE request_id = ?', [r.request_id]);
      await pool.query('DELETE FROM clearance_requests WHERE request_id = ?', [r.request_id]);
    }
    await pool.query("DELETE FROM notifications WHERE recipient_type = 'student' AND recipient_id = ?", [s.student_id]);
  }
  await pool.query("DELETE n FROM notifications n JOIN staff s ON s.staff_id = n.recipient_id WHERE n.recipient_type = 'staff' AND s.email LIKE 'cert.test.%@clearance.test'");
  await pool.query("DELETE FROM staff WHERE email LIKE 'cert.test.%@clearance.test'");
}

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await cleanup();
  for (const [key, matric] of [['student', MATRIC], ['other', OTHER]]) {
    const [[s]] = await pool.query('SELECT s.student_id, s.department_id, d.faculty_id FROM students s JOIN departments d USING (department_id) WHERE matric_no = ?', [matric]);
    tok[key] = signToken({ sub: s.student_id, userType: 'student', role: 'student', department_id: s.department_id, faculty_id: s.faculty_id });
    if (key === 'student') student = s;
  }
  for (const role of ['audit', 'library', 'admin', 'registry']) {
    const [r] = await pool.query("INSERT INTO staff (full_name, email, role, password_hash, must_change_password) VALUES (?, ?, ?, 'x', FALSE)", [`Cert Test ${role}`, `cert.test.${role}@clearance.test`, role]);
    tok[role] = signToken({ sub: r.insertId, userType: 'staff', role, department_id: null, faculty_id: null });
  }
  const [d] = await pool.query("INSERT INTO staff (full_name, email, role, department_id, password_hash, must_change_password) VALUES ('Cert Test dept', 'cert.test.dept@clearance.test', 'departmental', ?, 'x', FALSE)", [student.department_id]);
  tok.dept = signToken({ sub: d.insertId, userType: 'staff', role: 'departmental', department_id: student.department_id, faculty_id: null });
  requestId = await startRequest(student.student_id);
  // Fast-forward stages 1-6 and convocation (covered by workflow.test.js).
  await pool.query(
    "UPDATE clearance_stages SET status = 'approved', unlocked_at = NOW(), submitted_at = NOW(), reviewed_at = NOW() WHERE request_id = ? AND stage_key NOT IN ('letter', 'audit')",
    [requestId]
  );
  await pool.query(
    "UPDATE clearance_stages SET form_data = ? WHERE request_id = ? AND stage_key = 'security'",
    [JSON.stringify({ phone: '08031234567', hostel_or_address: 'Eni Njoku Hall, Room 214' }), requestId]
  );
});

after(async () => {
  await cleanup();
  server.close();
  await pool.end();
});

test('the graduation list stage opens once Security is approved', async () => {
  assert.equal(stageOf(await mine(), 'letter').status, 'locked');
  await recheckRequest(requestId); // stages 1-6 were fast-forwarded in the database
  const letter = stageOf(await mine(), 'letter');
  assert.equal(letter.status, 'awaiting_submission');
  assert.equal(stageOf(await mine(), 'audit').status, 'locked');
});

test('the department verifies the graduation list; approval generates the letter stating where the name is', async () => {
  const letter = stageOf(await mine(), 'letter');
  assert.equal((await api('PUT', `/stages/${letter.stage_id}/form`, { token: tok.student, body: { page_no: 12, serial_no: '301' } })).status, 200);
  const form = new FormData();
  form.append('required_doc_id', letter.slots[0].required_doc_id);
  form.append('level', 0);
  form.append('file', new Blob([Buffer.from('%PDF-1.4\n% graduation list\n')], { type: 'application/pdf' }), 'graduation-list.pdf');
  const up = await fetch(`${base}/stages/${letter.stage_id}/documents`, { method: 'POST', headers: { authorization: `Bearer ${tok.student}` }, body: form });
  assert.equal(up.status, 201);
  assert.equal((await api('POST', `/stages/${letter.stage_id}/submit`, { token: tok.student })).status, 200);

  const review = (await api('GET', `/review/stages/${letter.stage_id}`, { token: tok.dept })).body;
  const docId = review.stage.slots[0].document.document_id;
  assert.equal((await api('PATCH', `/review/documents/${docId}`, { token: tok.dept, body: { status: 'accepted', identity_confirmed: true } })).status, 200);
  assert.equal((await api('POST', `/review/stages/${letter.stage_id}/approve`, { token: tok.dept })).status, 200);

  const view = await mine();
  assert.equal(stageOf(view, 'letter').status, 'approved');
  assert.equal(view.request.has_letter, true);
  assert.equal(stageOf(view, 'audit').status, 'pending', 'all others approved, so Audit receives the file');

  // The generated letter says where the name appears on the list.
  const pdf = Buffer.from(await (await download(`/letter/${requestId}/download`, 'student')).arrayBuffer());
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
  assert.match(text, /graduation list for the 2025\/2026 session on page 12, number 301/);
  await task.destroy();
});

test('the letter PDF is served to the student, Audit and Admin only', async () => {
  const own = await download(`/letter/${requestId}/download`, 'student');
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'application/pdf');
  assert.match(own.headers.get('content-disposition'), /Application-letter-2022-243991\.pdf/);
  const bytes = Buffer.from(await own.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 1500);

  assert.equal((await download(`/letter/${requestId}/download`, 'audit')).status, 200);
  assert.equal((await download(`/letter/${requestId}/download`, 'admin')).status, 200);
  assert.equal((await download(`/letter/${requestId}/download`, 'other')).status, 404);
  assert.equal((await download(`/letter/${requestId}/download`, 'library')).status, 403);
  assert.equal((await download(`/letter/${requestId}/download`, null)).status, 401);
});

test('no certificate before Audit approves', async () => {
  assert.equal((await api('GET', '/certificate/mine', { token: tok.student })).body.certificate, null);
});

test('Audit approval completes the request and issues a certificate', async () => {
  const audit = stageOf(await mine(), 'audit');
  const res = await api('POST', `/review/stages/${audit.stage_id}/approve`, { token: tok.audit });
  assert.equal(res.status, 200);

  const view = await mine();
  assert.equal(view.request.status, 'completed');
  certificate = (await api('GET', '/certificate/mine', { token: tok.student })).body.certificate;
  assert.ok(certificate);
  assert.match(certificate.certificate_no, /^CLR-\d{4}-\d{6}$/);
  assert.match(certificate.verification_code, /^[a-f0-9]{64}$/);
  assert.equal(certificate.verify_url, `${env.appBaseUrl}/verify/${certificate.verification_code}`);

  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE recipient_type = 'student' AND recipient_id = ? AND message LIKE 'Congratulations%'", [student.student_id]);
  assert.equal(n.n, 1);
});

test('the certificate PDF is served to the student, Audit and Admin only', async () => {
  const p = `/certificate/${certificate.certificate_id}/download`;
  const own = await download(p, 'student');
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'application/pdf');
  assert.match(own.headers.get('content-disposition'), new RegExp(certificate.certificate_no));
  const bytes = Buffer.from(await own.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.toString('latin1').includes('/Subtype /Image'), 'contains the QR image');

  assert.equal((await download(p, 'audit')).status, 200);
  assert.equal((await download(p, 'admin')).status, 200);
  assert.equal((await download(p, 'other')).status, 404);
  assert.equal((await download(p, 'library')).status, 403);
});

test('anyone can verify a certificate by its code, without logging in', async () => {
  const res = await api('GET', `/verify/${certificate.verification_code}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.valid, true);
  assert.equal(res.body.matric_no, MATRIC);
  assert.equal(res.body.name, 'ACHIMUGU JOSEPH OJONUGWA');
  assert.equal(res.body.department, 'Computer Science');
  assert.equal(res.body.certificate_no, certificate.certificate_no);
  assert.equal(res.body.session, '2025/2026');
  assert.equal((await api('GET', `/verify/${certificate.verification_code.toUpperCase()}`)).body.valid, true, 'case-insensitive');
});

test('anyone can verify a certificate by its number together with the reg number', async () => {
  const check = (no, matric) => api('GET', `/verify?certificate_no=${encodeURIComponent(no)}&matric_no=${encodeURIComponent(matric)}`);
  const res = await check(certificate.certificate_no, MATRIC);
  assert.equal(res.status, 200);
  assert.equal(res.body.valid, true);
  assert.equal(res.body.certificate_no, certificate.certificate_no);
  assert.equal(res.body.name, 'ACHIMUGU JOSEPH OJONUGWA');
  assert.equal((await check(` ${certificate.certificate_no.toLowerCase()} `, MATRIC)).body.valid, true, 'case and spaces ignored');
  // The number alone, or with someone else's reg number, reveals nothing.
  for (const [no, matric] of [[certificate.certificate_no, ''], [certificate.certificate_no, '2022/000001'], ['CLR-2026-999999', MATRIC], ["x' OR '1'='1", MATRIC]]) {
    assert.deepEqual((await check(no, matric)).body, { valid: false });
  }
});

test('unknown, malformed or altered codes are reported invalid', async () => {
  const altered = certificate.verification_code.slice(0, -1) + (certificate.verification_code.endsWith('0') ? '1' : '0');
  for (const code of [altered, 'abc', "x' OR '1'='1", '0'.repeat(64)]) {
    const res = await api('GET', `/verify/${encodeURIComponent(code)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { valid: false });
  }
});

test('the Registry finds a clearance certificate by number, QR code or reg number', async () => {
  const look = (q, who = 'registry') => api('GET', `/registry/lookup?q=${encodeURIComponent(q)}`, { token: tok[who] });
  for (const q of [certificate.certificate_no, certificate.certificate_no.toLowerCase(), certificate.verification_code, certificate.verify_url, MATRIC]) {
    const res = await look(q);
    assert.equal(res.status, 200, q);
    assert.equal(res.body.found, true, q);
    assert.equal(res.body.certificate_no, certificate.certificate_no);
    assert.equal(res.body.student.matric_no, MATRIC);
    assert.equal(res.body.student.full_name, 'ACHIMUGU JOSEPH OJONUGWA');
    assert.equal(res.body.collection, null);
  }
  const notCleared = await look(OTHER);
  assert.equal(notCleared.body.found, false);
  assert.match(notCleared.body.reason, /has not completed clearance/);
  assert.equal((await look('CLR-2026-999999')).body.found, false);
  assert.equal((await look('2022/000001')).body.found, false);
  assert.equal((await look('hello')).status, 400);
  assert.equal((await look(certificate.certificate_no, 'admin')).status, 200, 'the Admin may look');
  assert.equal((await look(certificate.certificate_no, 'library')).status, 403);
  assert.equal((await look(certificate.certificate_no, 'student')).status, 403);
  assert.equal((await download(`/certificate/${certificate.certificate_id}/download`, 'registry')).status, 200, 'the Registry can open the certificate');
});

test('the Registry records the degree certificate collection once, and the student is told', async () => {
  const issue = (body, who = 'registry') => api('POST', `/registry/certificates/${certificate.certificate_id}/issue`, { token: tok[who], body });
  assert.equal((await issue({ serial_no: 'D 000123' })).status, 400, 'ID check must be confirmed');
  assert.equal((await issue({ identity_checked: true }, 'admin')).status, 403, 'only the Registry records');
  assert.equal((await issue({ identity_checked: true }, 'library')).status, 403);

  const res = await issue({ identity_checked: true, serial_no: ' D 000123 ', note: 'Collected in person' });
  assert.equal(res.status, 200);
  assert.ok(res.body.certificate.collection.issued_at);
  assert.equal(res.body.certificate.collection.issued_by, 'Cert Test registry');
  assert.equal(res.body.certificate.collection.serial_no, 'D 000123');

  const again = await issue({ identity_checked: true });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already collected/);

  assert.ok((await api('GET', '/certificate/mine', { token: tok.student })).body.certificate.degree_issued_at);
  const [[n]] = await pool.query("SELECT message, link FROM notifications WHERE recipient_type = 'student' AND recipient_id = ? AND message LIKE '%degree certificate was collected%'", [student.student_id]);
  assert.equal(n.link, '/student');
  const [[log]] = await pool.query("SELECT detail FROM audit_logs WHERE action = 'degree.issue' AND entity_id = ? ORDER BY log_id DESC LIMIT 1", [certificate.certificate_id]);
  assert.equal(log.detail.serial_no, 'D 000123');

  const list = await api('GET', '/registry/collected', { token: tok.registry });
  assert.ok(list.body.items.some((c) => c.certificate_no === certificate.certificate_no));
  assert.equal((await api('GET', `/registry/lookup?q=${encodeURIComponent(MATRIC)}`, { token: tok.registry })).body.collection.serial_no, 'D 000123');
});

test('the whole run is in the audit log', async () => {
  const [logs] = await pool.query(
    "SELECT action FROM audit_logs WHERE (entity = 'clearance_request' AND entity_id = ?) OR (entity = 'clearance_stage' AND entity_id IN (SELECT stage_id FROM clearance_stages WHERE request_id = ?))",
    [requestId, requestId]
  );
  const actions = new Set(logs.map((l) => l.action));
  for (const a of ['request.create', 'letter.generate', 'stage.approve', 'request.complete']) assert.ok(actions.has(a), a);
});
