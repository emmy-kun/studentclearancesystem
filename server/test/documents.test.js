// Upload, file access and duplicate-receipt tests (build step 5), through the
// HTTP API with real multipart uploads. Removes everything it creates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { default: app } = await import('../src/app.js');
const { default: pool } = await import('../src/config/db.js');
const { default: env } = await import('../src/config/env.js');
const { signToken } = await import('../src/middleware/auth.js');
const { startRequest } = await import('../src/services/workflowEngine.js');

const STUDENTS = { a: '2022/245261', b: '2022/244823' };
const STAFF = {
  dept: { role: 'departmental', dept: 'Computer Science' },
  otherDept: { role: 'departmental', dept: 'Mathematics' },
  library: { role: 'library' },
  audit: { role: 'audit' },
  admin: { role: 'admin' },
};
const tok = {};
const ids = {};
let server, base;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const JPEG2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(300, 9)]);
const PDF = Buffer.from('%PDF-1.4\n% test receipt\n');
const docsDir = path.join(env.uploads.dir, 'documents');
const fileCount = () => fs.readdirSync(docsDir).length;

async function api(method, p, { body, token } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function upload(who, stageId, { file = JPEG, type = 'image/jpeg', name = 'receipt.jpg', fields = {} } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (file) form.append('file', new Blob([file], { type }), name);
  const res = await fetch(`${base}/stages/${stageId}/documents`, { method: 'POST', headers: { authorization: `Bearer ${tok[who]}` }, body: form });
  return { status: res.status, body: await res.json() };
}

const receipt = (level, ref, extra = {}) => ({ required_doc_id: ids.deptDoc, level, reference_no: ref, amount: '2,500', document_date: '2024-02-09', ...extra });
const mine = async (who) => (await api('GET', '/clearance/mine', { token: tok[who] })).body;
const deptStage = async (who) => (await mine(who)).stages.find((s) => s.stage_key === 'departmental');

async function cleanup() {
  for (const matric of Object.values(STUDENTS)) {
    const [[s]] = await pool.query('SELECT student_id FROM students WHERE matric_no = ?', [matric]);
    const [reqs] = await pool.query('SELECT request_id FROM clearance_requests WHERE student_id = ?', [s.student_id]);
    for (const { request_id } of reqs) {
      const [files] = await pool.query('SELECT file_path FROM stage_documents sd JOIN clearance_stages cs ON cs.stage_id = sd.stage_id WHERE cs.request_id = ?', [request_id]);
      for (const f of files) fs.rmSync(path.join(env.uploads.dir, f.file_path), { force: true });
      await pool.query('DELETE sd FROM stage_documents sd JOIN clearance_stages cs ON cs.stage_id = sd.stage_id WHERE cs.request_id = ?', [request_id]);
      await pool.query('DELETE FROM payments WHERE request_id = ?', [request_id]);
      for (const sl of (await pool.query('SELECT sl.file_path FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [request_id]))[0]) fs.rmSync(path.join(env.uploads.dir, sl.file_path), { force: true });
      await pool.query('DELETE sl FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [request_id]);
      await pool.query('DELETE FROM clearance_stages WHERE request_id = ?', [request_id]);
      await pool.query('DELETE FROM clearance_requests WHERE request_id = ?', [request_id]);
    }
    await pool.query("DELETE FROM notifications WHERE recipient_type = 'student' AND recipient_id = ?", [s.student_id]);
  }
  await pool.query("DELETE n FROM notifications n JOIN staff s ON s.staff_id = n.recipient_id WHERE n.recipient_type = 'staff' AND s.email LIKE 'doc.test.%@clearance.test'");
  await pool.query("DELETE FROM staff WHERE email LIKE 'doc.test.%@clearance.test'");
}

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await cleanup();

  for (const [key, matric] of Object.entries(STUDENTS)) {
    const [[s]] = await pool.query('SELECT s.student_id, s.department_id, d.faculty_id FROM students s JOIN departments d USING (department_id) WHERE matric_no = ?', [matric]);
    tok[key] = signToken({ sub: s.student_id, userType: 'student', role: 'student', department_id: s.department_id, faculty_id: s.faculty_id });
    await startRequest(s.student_id);
  }
  for (const [key, s] of Object.entries(STAFF)) {
    const [[dept]] = s.dept ? await pool.query('SELECT department_id FROM departments WHERE name = ?', [s.dept]) : [[null]];
    const [r] = await pool.query(
      "INSERT INTO staff (full_name, email, role, department_id, password_hash, must_change_password) VALUES (?, ?, ?, ?, 'x', FALSE)",
      [`Doc Test ${key}`, `doc.test.${key}@clearance.test`, s.role, dept?.department_id ?? null]
    );
    tok[key] = signToken({ sub: r.insertId, userType: 'staff', role: s.role, department_id: dept?.department_id ?? null, faculty_id: null });
  }
  [[{ required_doc_id: ids.deptDoc }]] = await pool.query("SELECT required_doc_id FROM required_documents WHERE stage_key = 'departmental'");
  [[{ required_doc_id: ids.facultyDoc }]] = await pool.query("SELECT required_doc_id FROM required_documents WHERE stage_key = 'faculty' LIMIT 1");
  ids.stageA = (await deptStage('a')).stage_id;
  ids.stageB = (await deptStage('b')).stage_id;
});

after(async () => {
  await cleanup();
  server.close();
  await pool.end();
});

test('bad files are refused and nothing is left on disk', async () => {
  const before = fileCount();
  assert.equal((await upload('a', ids.stageA, { file: null, fields: receipt(100, 'R1') })).status, 400, 'no file');
  assert.equal((await upload('a', ids.stageA, { file: Buffer.from('hello'), type: 'text/plain', name: 'a.txt', fields: receipt(100, 'R1') })).status, 400, 'text file');
  const spoof = await upload('a', ids.stageA, { file: Buffer.from('<html>not an image</html>'), type: 'image/jpeg', name: 'fake.jpg', fields: receipt(100, 'R1') });
  assert.equal(spoof.status, 400, 'renamed file');
  assert.match(spoof.body.error, /does not match/);
  const big = await upload('a', ids.stageA, { file: Buffer.concat([JPEG, Buffer.alloc(env.uploads.maxBytes)]), fields: receipt(100, 'R1') });
  assert.equal(big.status, 413, 'too large');
  assert.equal(fileCount(), before);
});

test('the receipt number is required, the slot must exist, and failed uploads leave no file', async () => {
  const before = fileCount();
  assert.match((await upload('a', ids.stageA, { fields: receipt(100, '') })).body.error, /receipt no/);
  assert.equal((await upload('a', ids.stageA, { fields: receipt(500, 'R1') })).status, 400, 'no 500 level for a 4-year student');
  assert.equal((await upload('a', ids.stageA, { fields: { ...receipt(100, 'R1'), required_doc_id: ids.facultyDoc } })).status, 400, 'faculty doc on departmental stage');
  assert.equal((await upload('b', ids.stageA, { fields: receipt(100, 'R1') })).status, 404, "another student's stage");
  assert.equal(fileCount(), before);
});

test('a valid upload is stored with its typed details', async () => {
  const res = await upload('a', ids.stageA, { fields: receipt(100, 'TST/21/0412') });
  assert.equal(res.status, 201);
  assert.equal(res.body.duplicate_flag, false);
  const slot = (await deptStage('a')).slots.find((s) => s.level === 100);
  assert.equal(slot.document.reference_no, 'TST/21/0412');
  assert.equal(slot.document.amount, null, 'amount is read from the photo, not typed');
  assert.equal(slot.document.document_date, null, 'date is read from the photo, not typed');
  assert.equal(slot.collects_amount, false);
  assert.equal(slot.collects_date, false);
  assert.equal(slot.document.status, 'pending');
  assert.equal(slot.document.duplicate_flag, undefined, 'students do not see the duplicate flag');
});

test('re-uploading a pending slot replaces the file and deletes the old one', async () => {
  const [[old]] = await pool.query('SELECT document_id, file_path FROM stage_documents WHERE stage_id = ? AND level = 100', [ids.stageA]);
  const res = await upload('a', ids.stageA, { file: PDF, type: 'application/pdf', name: 'receipt.pdf', fields: receipt(100, 'TST/21/0412') });
  assert.equal(res.status, 201);
  assert.equal(res.body.document_id, old.document_id, 'same slot, same document row');
  const [[now]] = await pool.query('SELECT file_path, mime_type FROM stage_documents WHERE document_id = ?', [old.document_id]);
  assert.equal(now.mime_type, 'application/pdf');
  assert.equal(fs.existsSync(path.join(env.uploads.dir, old.file_path)), false);
  assert.equal(fs.existsSync(path.join(env.uploads.dir, now.file_path)), true);
});

test('a receipt number already used by another student flags both documents', async () => {
  const res = await upload('b', ids.stageB, { fields: receipt(100, 'TST/21/0412') });
  assert.equal(res.status, 201);
  assert.equal(res.body.duplicate_flag, true);
  const [rows] = await pool.query('SELECT stage_id, duplicate_flag FROM stage_documents WHERE reference_no = ?', ['TST/21/0412']);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.duplicate_flag === 1));
  // the same student reusing their own number is not a duplicate
  const own = await upload('b', ids.stageB, { fields: receipt(200, 'TST-OWN-1') });
  const own2 = await upload('b', ids.stageB, { fields: receipt(300, 'TST-OWN-1') });
  assert.equal(own.body.duplicate_flag, false);
  assert.equal(own2.body.duplicate_flag, false);
});

test('files are served only to the owner and reviewers in scope', async () => {
  const [[doc]] = await pool.query('SELECT document_id FROM stage_documents WHERE stage_id = ? AND level = 100', [ids.stageA]);
  const get = (who) => fetch(`${base}/files/${doc.document_id}`, { headers: who ? { authorization: `Bearer ${tok[who]}` } : {} });

  const owner = await get('a');
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get('content-type'), 'application/pdf');
  assert.match(owner.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await owner.arrayBuffer()), PDF);

  assert.equal((await get('dept')).status, 200, 'CS departmental officer');
  assert.equal((await get('audit')).status, 200, 'audit');
  assert.equal((await get('admin')).status, 200, 'admin');
  assert.equal((await get('b')).status, 404, 'another student');
  assert.equal((await get('otherDept')).status, 404, 'Mathematics officer');
  assert.equal((await get('library')).status, 404, 'library cannot open departmental receipts');
  assert.equal((await get(null)).status, 401, 'no login');
  assert.equal((await fetch(`${base}/files/999999999`, { headers: { authorization: `Bearer ${tok.a}` } })).status, 404);
});

test('uploads are not served as static files', async () => {
  const [[doc]] = await pool.query('SELECT file_path FROM stage_documents WHERE stage_id = ? AND level = 100', [ids.stageA]);
  for (const p of [`/uploads/${doc.file_path}`, `/${doc.file_path}`]) {
    assert.equal((await fetch(`http://localhost:${server.address().port}${p}`)).status, 404);
  }
});

test('students can delete their own pending uploads only', async () => {
  const [[doc]] = await pool.query('SELECT document_id, file_path FROM stage_documents WHERE stage_id = ? AND level = 200', [ids.stageB]);
  assert.equal((await api('DELETE', `/documents/${doc.document_id}`, { token: tok.a })).status, 404, "someone else's");
  assert.equal((await api('DELETE', `/documents/${doc.document_id}`, { token: tok.b })).status, 200);
  assert.equal(fs.existsSync(path.join(env.uploads.dir, doc.file_path)), false);
});

test('after rejection only rejected documents can be replaced; accepted ones are locked', async () => {
  for (const level of [200, 300, 400]) assert.equal((await upload('a', ids.stageA, { fields: receipt(level, `A-${level}`) })).status, 201);
  assert.equal((await api('POST', `/stages/${ids.stageA}/submit`, { token: tok.a })).status, 200);
  assert.equal((await upload('a', ids.stageA, { fields: receipt(200, 'A-200') })).status, 409, 'closed while pending');

  const slots = (await deptStage('a')).slots;
  const byLevel = Object.fromEntries(slots.map((s) => [s.level, s.document.document_id]));
  for (const level of [100, 200, 400]) await api('PATCH', `/review/documents/${byLevel[level]}`, { token: tok.dept, body: { status: 'accepted', identity_confirmed: true } });
  const rej = await api('POST', `/review/stages/${ids.stageA}/reject`, {
    token: tok.dept,
    body: { comment: '300 level receipt unreadable', documentNotes: [{ document_id: byLevel[300], note: 'Blurry' }] },
  });
  assert.equal(rej.status, 200);

  assert.equal((await upload('a', ids.stageA, { fields: receipt(200, 'A-200') })).status, 409, 'accepted receipt cannot be replaced');
  assert.equal((await api('DELETE', `/documents/${byLevel[200]}`, { token: tok.a })).status, 409, 'accepted receipt cannot be deleted');
  const fix = await upload('a', ids.stageA, { file: JPEG2, fields: receipt(300, 'A-300') });
  assert.equal(fix.status, 201);
  const fixed = (await deptStage('a')).slots.find((s) => s.level === 300).document;
  assert.equal(fixed.status, 'pending');
  assert.equal(fixed.reviewer_note, null);
  assert.equal((await api('POST', `/stages/${ids.stageA}/submit`, { token: tok.a })).status, 200);

  const [logs] = await pool.query("SELECT DISTINCT action FROM audit_logs WHERE entity = 'stage_document' AND action LIKE 'document.%' AND entity_id IN (SELECT document_id FROM stage_documents WHERE stage_id = ?)", [ids.stageA]);
  for (const a of ['document.upload', 'document.replace', 'document.accept', 'document.reject']) assert.ok(logs.some((l) => l.action === a), a);
});

test('a document rejected during review can be replaced at once, without waiting for the whole stage', async () => {
  for (const level of [200, 400]) assert.equal((await upload('b', ids.stageB, { fields: receipt(level, `B-${level}`) })).status, 201);
  assert.equal((await api('POST', `/stages/${ids.stageB}/submit`, { token: tok.b })).status, 200);

  let slots = (await deptStage('b')).slots;
  const doc = (level) => slots.find((s) => s.level === level).document;
  const r = await api('PATCH', `/review/documents/${doc(300).document_id}`, { token: tok.dept, body: { status: 'rejected', reviewer_note: 'Blurry name, retake it' } });
  assert.equal(r.status, 200);

  // The student is told and sees it under Action needed, while the stage is still under review.
  const view = await api('GET', '/clearance/mine', { token: tok.b });
  const stage = view.body.stages.find((s) => s.stage_key === 'departmental');
  assert.equal(stage.status, 'pending');
  const action = view.body.action_needed.find((a) => a.stage_key === 'departmental');
  assert.deepEqual(action.rejected_documents.map((d) => d.reviewer_note), ['Blurry name, retake it']);
  const [[note]] = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE recipient_type = 'student' AND recipient_id = (SELECT student_id FROM students WHERE matric_no = ?) AND message LIKE '%300 level) was rejected%'", [STUDENTS.b]);
  assert.equal(note.n, 1);

  // Only the rejected one can be replaced during review.
  assert.equal((await upload('b', ids.stageB, { fields: receipt(200, 'B-200') })).status, 409, 'documents still under review are locked');
  const fix = await upload('b', ids.stageB, { file: JPEG2, fields: receipt(300, 'B-300-NEW') });
  assert.equal(fix.status, 201);

  slots = (await deptStage('b')).slots;
  assert.equal(doc(300).status, 'pending', 'replacement goes back to the office');
  assert.equal(doc(300).reviewer_note, null);
  assert.equal((await deptStage('b')).status, 'pending', 'the stage stays under review');
  const [[told]] = await pool.query("SELECT COUNT(*) AS n FROM notifications n JOIN staff s ON s.staff_id = n.recipient_id WHERE n.recipient_type = 'staff' AND s.email = 'doc.test.dept@clearance.test' AND n.message LIKE '%replaced a rejected document%'");
  assert.equal(told.n, 1, 'the reviewer is told a replacement arrived');
});

test('a reviewer cannot accept a document without confirming the name and reg number match', async () => {
  const slot = (await deptStage('b')).slots.find((s) => s.level === 100);
  assert.equal(slot.check_identity, true);
  const id = slot.document.document_id;
  const without = await api('PATCH', `/review/documents/${id}`, { token: tok.dept, body: { status: 'accepted' } });
  assert.equal(without.status, 400);
  assert.match(without.body.error, /name and reg number/);
  assert.equal((await api('PATCH', `/review/documents/${id}`, { token: tok.dept, body: { status: 'accepted', identity_confirmed: true } })).status, 200);
  const [[log]] = await pool.query("SELECT detail FROM audit_logs WHERE action = 'document.accept' AND entity_id = ? ORDER BY log_id DESC LIMIT 1", [id]);
  assert.equal(log.detail.identity_confirmed, true, 'the confirmation is recorded in the audit log');

  // Reviewers see the automatic check result (OCR is off during tests, so none is recorded).
  const review = (await api('GET', `/review/stages/${ids.stageB}`, { token: tok.dept })).body;
  assert.ok('ocr_status' in review.stage.slots[0].document);
  assert.ok(!('ocr_status' in (await deptStage('b')).slots[0].document), 'students do not see it');
});
