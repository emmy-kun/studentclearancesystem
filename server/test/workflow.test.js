// End-to-end workflow test (build step 4) through the HTTP API, for one real
// imported student. Uploads (step 5) and payments (step 6) are not built yet, so
// the test writes those rows directly. All data created here is removed after.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { default: app } = await import('../src/app.js');
const { default: env } = await import('../src/config/env.js');
const { default: pool } = await import('../src/config/db.js');
const { signToken } = await import('../src/middleware/auth.js');
const { recheckRequest } = await import('../src/services/workflowEngine.js');

const MATRIC = '2022/245074';
const STAFF = {
  dept: { role: 'departmental', dept: 'Computer Science' },
  otherDept: { role: 'departmental', dept: 'Mathematics' },
  faculty: { role: 'faculty', faculty: 'Physical Sciences' },
  otherFaculty: { role: 'faculty', faculty: 'Engineering' },
  library: { role: 'library' },
  alumni: { role: 'alumni' },
  affairs: { role: 'student_affairs' },
  security: { role: 'security' },
  audit: { role: 'audit' },
  admin: { role: 'admin' },
};
const tokens = {};
let server, base, student, studentToken, originalStudent;

async function api(method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function cleanup() {
  const [reqs] = await pool.query('SELECT request_id FROM clearance_requests WHERE student_id = ?', [student.student_id]);
  for (const { request_id } of reqs) {
    const [files] = await pool.query(
      `SELECT file_path FROM certificates WHERE request_id = ?
       UNION ALL SELECT letter_path FROM clearance_requests WHERE request_id = ? AND letter_path IS NOT NULL`,
      [request_id, request_id]
    );
    for (const f of files) fs.rmSync(path.join(env.uploads.dir, f.file_path), { force: true });
    await pool.query('DELETE sd FROM stage_documents sd JOIN clearance_stages cs ON cs.stage_id = sd.stage_id WHERE cs.request_id = ?', [request_id]);
    await pool.query('DELETE FROM payments WHERE request_id = ?', [request_id]);
    await pool.query('DELETE FROM certificates WHERE request_id = ?', [request_id]);
    for (const sl of (await pool.query('SELECT sl.file_path FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [request_id]))[0]) fs.rmSync(path.join(env.uploads.dir, sl.file_path), { force: true });
    await pool.query('DELETE sl FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [request_id]);
    await pool.query('DELETE FROM clearance_stages WHERE request_id = ?', [request_id]);
    await pool.query('DELETE FROM clearance_requests WHERE request_id = ?', [request_id]);
  }
  await pool.query("DELETE FROM notifications WHERE recipient_type = 'student' AND recipient_id = ?", [student.student_id]);
  const [staff] = await pool.query("SELECT staff_id FROM staff WHERE email LIKE 'wf.test.%@clearance.test'");
  for (const { staff_id } of staff) await pool.query("DELETE FROM notifications WHERE recipient_type = 'staff' AND recipient_id = ?", [staff_id]);
  await pool.query("DELETE FROM staff WHERE email LIKE 'wf.test.%@clearance.test'");
}

before(async () => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;

  [[student]] = await pool.query(
    `SELECT s.student_id, s.department_id, d.faculty_id FROM students s JOIN departments d ON d.department_id = s.department_id WHERE matric_no = ?`,
    [MATRIC]
  );
  [[originalStudent]] = await pool.query('SELECT accommodation_type, results_released FROM students WHERE student_id = ?', [student.student_id]);
  await cleanup();
  studentToken = signToken({ sub: student.student_id, userType: 'student', role: 'student', department_id: student.department_id, faculty_id: student.faculty_id });

  for (const [key, s] of Object.entries(STAFF)) {
    const [[dept]] = s.dept ? await pool.query('SELECT department_id FROM departments WHERE name = ?', [s.dept]) : [[null]];
    const [[fac]] = s.faculty ? await pool.query('SELECT faculty_id FROM faculties WHERE name = ?', [s.faculty]) : [[null]];
    const [r] = await pool.query(
      `INSERT INTO staff (full_name, email, role, department_id, faculty_id, password_hash, must_change_password)
       VALUES (?, ?, ?, ?, ?, 'x', FALSE)`,
      [`WF Test ${key}`, `wf.test.${key}@clearance.test`, s.role, dept?.department_id ?? null, fac?.faculty_id ?? null]
    );
    tokens[key] = signToken({ sub: r.insertId, userType: 'staff', role: s.role, department_id: dept?.department_id ?? null, faculty_id: fac?.faculty_id ?? null });
  }
});

after(async () => {
  await cleanup();
  await pool.query('UPDATE students SET accommodation_type = ?, results_released = ? WHERE student_id = ?', [originalStudent.accommodation_type, originalStudent.results_released, student.student_id]);
  server.close();
  await pool.end();
});

// ---- helpers ----
const mine = async () => (await api('GET', '/clearance/mine', { token: studentToken })).body;
const stageOf = (view, key) => view.stages.find((s) => s.stage_key === key);

/** Simulate step 5: put a file in every empty (or rejected) slot of a stage. */
async function uploadAll(key) {
  const stage = stageOf(await mine(), key);
  for (const slot of stage.slots) {
    if (slot.document && slot.document.status !== 'rejected') continue;
    await pool.query(
      `INSERT INTO stage_documents (stage_id, required_doc_id, level, file_path, original_name, mime_type, reference_no)
       VALUES (?, ?, ?, 'test/fake.jpg', 'fake.jpg', 'image/jpeg', ?)
       ON DUPLICATE KEY UPDATE file_path = VALUES(file_path), status = 'pending', reviewer_note = NULL`,
      [stage.stage_id, slot.required_doc_id, slot.level, `REF-${stage.stage_id}-${slot.required_doc_id}-${slot.level}`]
    );
  }
  return stage.stage_id;
}

/** Simulate step 6: mark every unpaid payment on a stage as paid. */
async function payAll(stageId) {
  await pool.query("UPDATE payments SET status = 'success', paid_at = NOW() WHERE stage_id = ? AND status = 'unpaid'", [stageId]);
}

async function acceptAll(stageId, token) {
  const review = (await api('GET', `/review/stages/${stageId}`, { token })).body;
  for (const slot of review.stage.slots) {
    if (slot.document.status !== 'accepted') {
      const r = await api('PATCH', `/review/documents/${slot.document.document_id}`, { token, body: { status: 'accepted', identity_confirmed: true } });
      assert.equal(r.status, 200);
    }
  }
}

/** Upload, pay, submit, accept everything and approve one stage. */
async function clearStage(key, token) {
  const stageId = await uploadAll(key);
  await payAll(stageId);
  const sub = await api('POST', `/stages/${stageId}/submit`, { token: studentToken });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  await acceptAll(stageId, token);
  const ok = await api('POST', `/review/stages/${stageId}/approve`, { token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return stageId;
}

// ---- the flow (tests run in order and share state) ----

test('no request yet', async () => {
  assert.equal((await mine()).request, null);
});

test('starting clearance creates 9 stages; departmental and convocation open', async () => {
  const res = await api('POST', '/clearance', { token: studentToken });
  assert.equal(res.status, 201);
  const statuses = Object.fromEntries(res.body.stages.map((s) => [s.stage_key, s.status]));
  assert.deepEqual(statuses, {
    departmental: 'awaiting_submission', faculty: 'locked', library: 'locked', alumni: 'locked', student_affairs: 'locked',
    security: 'locked', convocation: 'awaiting_submission', letter: 'locked', audit: 'locked',
  });
  assert.equal(res.body.request.session, '2025/2026');
  assert.deepEqual(stageOf(res.body, 'departmental').slots.map((s) => s.level), [100, 200, 300, 400]);
  assert.equal(stageOf(res.body, 'faculty').slots.length, 0, 'locked stages show no slots');
  const conv = stageOf(res.body, 'convocation');
  assert.equal(conv.payments.length, 1);
  assert.equal(conv.payments[0].amount, 10000);
  assert.equal(conv.payments[0].purpose, 'convocation');
  assert.equal(conv.payments[0].status, 'unpaid');
});

test('a second request for the same session is refused', async () => {
  assert.equal((await api('POST', '/clearance', { token: studentToken })).status, 409);
});

test('staff cannot use student routes and students cannot use review routes', async () => {
  assert.equal((await api('GET', '/clearance/mine', { token: tokens.dept })).status, 403);
  assert.equal((await api('GET', '/review/queue', { token: studentToken })).status, 403);
});

test('departmental cannot be submitted until every level has a receipt', async () => {
  const stage = stageOf(await mine(), 'departmental');
  assert.equal(stage.can_submit, false);
  assert.equal(stage.blockers.length, 4);
  const res = await api('POST', `/stages/${stage.stage_id}/submit`, { token: studentToken });
  assert.equal(res.status, 400);
  assert.equal(res.body.blockers.length, 4);
});

test('submitted departmental stage reaches only the right departmental officer', async () => {
  const stageId = await uploadAll('departmental');
  const res = await api('POST', `/stages/${stageId}/submit`, { token: studentToken });
  assert.equal(res.status, 200);
  assert.equal(stageOf(res.body, 'departmental').status, 'pending');

  const q = (await api('GET', '/review/queue', { token: tokens.dept })).body.items;
  assert.ok(q.some((i) => i.stage_id === stageId));
  const other = (await api('GET', '/review/queue', { token: tokens.otherDept })).body.items;
  assert.ok(!other.some((i) => i.stage_id === stageId), 'Mathematics officer must not see a CS student');
  const lib = (await api('GET', '/review/queue', { token: tokens.library })).body.items;
  assert.ok(!lib.some((i) => i.stage_id === stageId), 'library must not see departmental stages');
  const adminQ = (await api('GET', '/review/queue', { token: tokens.admin })).body.items;
  assert.ok(adminQ.some((i) => i.stage_id === stageId), 'admin sees everything');

  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM notifications n JOIN staff s ON s.staff_id = n.recipient_id WHERE n.recipient_type = 'staff' AND s.email = 'wf.test.dept@clearance.test'");
  assert.ok(n.n >= 1, 'departmental officer was notified');
});

test('wrong-scope and wrong-role staff are refused', async () => {
  const stage = stageOf(await mine(), 'departmental');
  assert.equal((await api('GET', `/review/stages/${stage.stage_id}`, { token: tokens.otherDept })).status, 403);
  assert.equal((await api('POST', `/review/stages/${stage.stage_id}/approve`, { token: tokens.otherDept })).status, 403);
  assert.equal((await api('POST', `/review/stages/${stage.stage_id}/approve`, { token: tokens.library })).status, 403);
  assert.equal((await api('POST', `/review/stages/${stage.stage_id}/approve`, { token: tokens.admin })).status, 403, 'admin is read-only');
  const docId = stage.slots[0].document.document_id;
  assert.equal((await api('PATCH', `/review/documents/${docId}`, { token: tokens.otherDept, body: { status: 'accepted', identity_confirmed: true } })).status, 403);
  // admin can view read-only
  const view = await api('GET', `/review/stages/${stage.stage_id}`, { token: tokens.admin });
  assert.equal(view.status, 200);
  assert.equal(view.body.can_review, false);
});

test('approve is blocked until every document is accepted', async () => {
  const stage = stageOf(await mine(), 'departmental');
  const res = await api('POST', `/review/stages/${stage.stage_id}/approve`, { token: tokens.dept });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Accept every document/);
});

test('reviewer rejects one receipt and the stage; student sees why', async () => {
  const stage = stageOf(await mine(), 'departmental');
  const [d100, d200, d300, d400] = stage.slots.map((s) => s.document.document_id);
  for (const id of [d100, d200, d400]) {
    assert.equal((await api('PATCH', `/review/documents/${id}`, { token: tokens.dept, body: { status: 'accepted', identity_confirmed: true } })).status, 200);
  }
  assert.equal((await api('PATCH', `/review/documents/${d300}`, { token: tokens.dept, body: { status: 'rejected' } })).status, 400, 'note required');
  assert.equal((await api('POST', `/review/stages/${stage.stage_id}/reject`, { token: tokens.dept, body: {} })).status, 400, 'comment required');

  const rej = await api('POST', `/review/stages/${stage.stage_id}/reject`, {
    token: tokens.dept,
    body: { comment: 'The 300 level receipt is blurry.', documentNotes: [{ document_id: d300, note: 'Photo is blurry' }] },
  });
  assert.equal(rej.status, 200);

  const view = await mine();
  const dept = stageOf(view, 'departmental');
  assert.equal(dept.status, 'rejected');
  assert.equal(dept.comment, 'The 300 level receipt is blurry.');
  assert.equal(stageOf(view, 'faculty').status, 'locked');
  assert.equal(view.action_needed.length, 1);
  assert.deepEqual(view.action_needed[0].rejected_documents, [{ name: 'Departmental dues receipt (original)', level: 300, reviewer_note: 'Photo is blurry' }]);
  assert.deepEqual(dept.blockers, ['Replace rejected document: Departmental dues receipt (original) (300 level)']);
});

test('after replacing the rejected receipt the student resubmits and the officer approves', async () => {
  const stageId = await uploadAll('departmental'); // replaces only the rejected slot
  const res = await api('POST', `/stages/${stageId}/submit`, { token: studentToken });
  assert.equal(res.status, 200);
  const review = (await api('GET', `/review/stages/${stageId}`, { token: tokens.dept })).body;
  assert.deepEqual(review.stage.slots.map((s) => s.document.status), ['accepted', 'accepted', 'pending', 'accepted']);
  await acceptAll(stageId, tokens.dept);
  assert.equal((await api('POST', `/review/stages/${stageId}/approve`, { token: tokens.dept })).status, 200);

  const view = await mine();
  assert.equal(stageOf(view, 'departmental').status, 'approved');
  const fac = stageOf(view, 'faculty');
  assert.equal(fac.status, 'awaiting_submission');
  assert.equal(fac.slots.length, 13, '3 receipts x 4 levels + homecoming');
  assert.equal(view.progress.approved, 1);

  // Approval issues the office's clearance slip, downloadable by the right people only.
  const slip = stageOf(view, 'departmental').slip;
  assert.equal(slip.title, 'Departmental Clearance Slip');
  assert.match(slip.slip_no, /^DEP-\d{4}-\d{6}$/);
  assert.equal(slip.issued_by, 'WF Test dept');
  const dl = (token) => fetch(`${base}/slips/${slip.slip_id}/download`, { headers: { authorization: `Bearer ${token}` } });
  const own = await dl(studentToken);
  assert.equal(own.status, 200);
  assert.equal((await own.arrayBuffer()).byteLength > 1000, true);
  assert.equal((await dl(tokens.dept)).status, 200, 'the issuing office');
  assert.equal((await dl(tokens.security)).status, 200, 'Security receives the slips');
  assert.equal((await dl(tokens.otherDept)).status, 404, 'another department');
  assert.equal((await dl(tokens.library)).status, 404, 'an unrelated office');

  // Clicking a notification opens the page it is about.
  const notes = (await api('GET', '/notifications', { token: studentToken })).body.items;
  assert.equal(notes.find((n) => /^Departmental Clearance approved/.test(n.message)).link, `/student/stage/${stageId}`);
  const officerNotes = (await api('GET', '/notifications', { token: tokens.dept })).body.items;
  assert.ok(officerNotes.some((n) => /submission/.test(n.message) && n.link === `/staff/review/${stageId}`));

  const hist = (await api('GET', '/review/history', { token: tokens.dept })).body.items;
  assert.ok(hist.some((h) => h.stage_id === stageId));
});

test('faculty officer of another faculty cannot review; correct one approves', async () => {
  const stageId = await uploadAll('faculty');
  await api('POST', `/stages/${stageId}/submit`, { token: studentToken });
  assert.equal((await api('GET', `/review/stages/${stageId}`, { token: tokens.otherFaculty })).status, 403);
  await acceptAll(stageId, tokens.faculty);
  assert.equal((await api('POST', `/review/stages/${stageId}/approve`, { token: tokens.faculty })).status, 200);
  assert.equal(stageOf(await mine(), 'library').status, 'awaiting_submission');
});

test('library slots follow the student\'s choice; switching removes uploads that no longer apply', async () => {
  let lib = stageOf(await mine(), 'library');
  assert.equal(lib.slots.length, 0);
  assert.deepEqual(lib.blockers, ['Fill in: Library registration']);
  assert.equal((await api('PUT', `/stages/${lib.stage_id}/form`, { token: studentToken, body: { library_registered: 'yes' } })).status, 400);

  let res = await api('PUT', `/stages/${lib.stage_id}/form`, { token: studentToken, body: { library_registered: true } });
  assert.equal(res.status, 200);
  lib = stageOf(res.body, 'library');
  assert.deepEqual(lib.slots.map((s) => s.name), ['Library card']);
  assert.equal(lib.slots[0].reference_label, null, 'library card is photo only (it carries the reg number)');
  await uploadAll('library');

  res = await api('PUT', `/stages/${lib.stage_id}/form`, { token: studentToken, body: { library_registered: false } });
  lib = stageOf(res.body, 'library');
  assert.deepEqual(lib.slots.map((s) => s.name), ['School fees receipt', 'Passport photograph']);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM stage_documents WHERE stage_id = ?', [lib.stage_id]);
  assert.equal(n, 0, 'library card upload removed');
});

test('library: an unpaid staff-raised charge blocks approval', async () => {
  const stageId = await uploadAll('library');
  await api('POST', `/stages/${stageId}/submit`, { token: studentToken });
  const [[reqRow]] = await pool.query('SELECT request_id FROM clearance_stages WHERE stage_id = ?', [stageId]);
  await pool.query(
    "INSERT INTO payments (request_id, stage_id, purpose, description, amount, reference, raised_by) VALUES (?, ?, 'library_fee', 'Library fee, 200 and 300 level', 3000, ?, (SELECT staff_id FROM staff WHERE email = 'wf.test.library@clearance.test'))",
    [reqRow.request_id, stageId, `TEST-LIB-${Date.now()}`]
  );
  await acceptAll(stageId, tokens.library);
  const blocked = await api('POST', `/review/stages/${stageId}/approve`, { token: tokens.library });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /unpaid/);
  assert.ok((await mine()).action_needed.some((a) => a.unpaid.some((u) => u.amount === 3000)), 'student sees the fee in Action needed');
  await payAll(stageId);
  assert.equal((await api('POST', `/review/stages/${stageId}/approve`, { token: tokens.library })).status, 200);
});

test('alumni: the N650 fee is created on unlock and must be paid before submitting', async () => {
  const alumni = stageOf(await mine(), 'alumni');
  assert.equal(alumni.payments[0].amount, 650);
  assert.equal(alumni.payments[0].purpose, 'stage_fee');
  await uploadAll('alumni');
  const res = await api('POST', `/stages/${alumni.stage_id}/submit`, { token: studentToken });
  assert.equal(res.status, 400);
  assert.match(res.body.blockers.join(), /650/);
  await payAll(alumni.stage_id);
  assert.equal((await api('POST', `/stages/${alumni.stage_id}/submit`, { token: studentToken })).status, 200);
  await acceptAll(alumni.stage_id, tokens.alumni);
  assert.equal((await api('POST', `/review/stages/${alumni.stage_id}/approve`, { token: tokens.alumni })).status, 200);
});

test('accommodation: choosing off-campus adds the off-campus slot; Security then needs only the School ID card', async () => {
  const sa = stageOf(await mine(), 'student_affairs');
  assert.equal(sa.slots.length, 1);
  const res = await api('PUT', `/stages/${sa.stage_id}/form`, { token: studentToken, body: { accommodation_type: 'off_campus', off_campus_address: '12 Odenigbo Road, Nsukka' } });
  assert.equal(res.status, 200);
  assert.deepEqual(stageOf(res.body, 'student_affairs').slots.map((s) => s.name), ['Accommodation clearance form (filled)', 'Off-campus clearance']);
  await clearStage('student_affairs', tokens.affairs);

  const sec = stageOf(await mine(), 'security');
  assert.deepEqual(sec.slots.map((s) => s.name), ['School ID card'], 'earlier clearance slips are attached by the system, not uploaded');
  assert.equal(sec.payments[0].amount, 1000);

  // Security sees the slips the earlier offices issued.
  const review = (await api('GET', `/review/stages/${sec.stage_id}`, { token: tokens.security })).body;
  const slips = Object.fromEntries(review.earlier_slips.map((e) => [e.stage_key, e.slip?.title || null]));
  assert.deepEqual(slips, {
    departmental: 'Departmental Clearance Slip',
    faculty: 'School Fees Clearance Receipt',
    library: 'Library Clearance Slip',
    alumni: 'Alumni Clearance Slip',
    student_affairs: 'Accommodation Clearance Slip',
  });
});

test('security: details form required, then cleared', async () => {
  const sec = stageOf(await mine(), 'security');
  await uploadAll('security');
  await payAll(sec.stage_id);
  const res = await api('POST', `/stages/${sec.stage_id}/submit`, { token: studentToken });
  assert.equal(res.status, 400);
  assert.ok(res.body.blockers.every((b) => b.startsWith('Fill in')));
  await api('PUT', `/stages/${sec.stage_id}/form`, {
    token: studentToken,
    body: { full_name: 'ABAKPA EMMANUEL ABAH', matric_no: MATRIC, department: 'Computer Science', phone: '08030000000', hostel_or_address: '12 Odenigbo Road' },
  });
  await clearStage('security', tokens.security);
});

test('convocation: nothing to upload; it completes once the fee is paid', async () => {
  const conv = stageOf(await mine(), 'convocation');
  await uploadAll('convocation');
  assert.equal((await api('POST', `/stages/${conv.stage_id}/submit`, { token: studentToken })).status, 400, 'not paid yet');
  await payAll(conv.stage_id);
  const res = await api('POST', `/stages/${conv.stage_id}/submit`, { token: studentToken });
  assert.equal(res.status, 200);
  assert.equal(stageOf(res.body, 'convocation').status, 'approved');
  assert.equal(stageOf(res.body, 'audit').status, 'locked', 'letter still outstanding');
});

test('graduation list: the department verifies the name, the letter is generated, and Audit receives the file', async () => {
  const letter = stageOf(await mine(), 'letter');
  assert.equal(letter.status, 'awaiting_submission', 'opens once Security is approved');
  assert.equal(letter.name, 'Graduation List & Application Letter');
  assert.deepEqual(letter.slots.map((s) => s.name), ['Graduation list']);
  assert.ok(letter.blockers.includes('Fill in: Page your name is on'));

  assert.equal((await api('PUT', `/stages/${letter.stage_id}/form`, { token: studentToken, body: { page_no: 'four' } })).status, 400, 'page must be a number');
  await api('PUT', `/stages/${letter.stage_id}/form`, { token: studentToken, body: { page_no: '4', serial_no: '57' } });
  await uploadAll('letter');
  assert.equal((await api('POST', `/stages/${letter.stage_id}/submit`, { token: studentToken })).status, 200);

  // It goes to the student's own departmental officer, who sees where the name should be.
  assert.ok((await api('GET', '/review/queue', { token: tokens.dept })).body.items.some((i) => i.stage_id === letter.stage_id));
  assert.equal((await api('GET', `/review/stages/${letter.stage_id}`, { token: tokens.otherDept })).status, 403);
  const review = (await api('GET', `/review/stages/${letter.stage_id}`, { token: tokens.dept })).body;
  assert.deepEqual(review.stage.form_data, { page_no: 4, serial_no: '57' });

  await acceptAll(letter.stage_id, tokens.dept);
  assert.equal((await api('POST', `/review/stages/${letter.stage_id}/approve`, { token: tokens.dept })).status, 200);

  const view = await mine();
  assert.equal(stageOf(view, 'letter').status, 'approved');
  assert.equal(view.request.has_letter, true, 'approval generated the application letter');
  const audit = stageOf(view, 'audit');
  assert.equal(audit.status, 'pending');
  assert.ok((await api('GET', '/review/queue', { token: tokens.audit })).body.items.some((i) => i.stage_id === audit.stage_id));
});

test('audit sees the dossier and must choose a stage when rejecting', async () => {
  const audit = stageOf(await mine(), 'audit');
  const view = (await api('GET', `/review/stages/${audit.stage_id}`, { token: tokens.audit })).body;
  assert.deepEqual(view.dossier.map((s) => s.stage_key), ['faculty', 'letter', 'security', 'student_affairs', 'convocation', 'library', 'alumni', 'departmental']);

  assert.equal((await api('POST', `/review/stages/${audit.stage_id}/reject`, { token: tokens.audit, body: { comment: 'Fix library' } })).status, 400);
  assert.equal((await api('POST', `/review/stages/${audit.stage_id}/reject`, { token: tokens.audit, body: { comment: 'x', reopen_stage_key: 'audit' } })).status, 400);

  const res = await api('POST', `/review/stages/${audit.stage_id}/reject`, { token: tokens.audit, body: { comment: 'Library clearance passport is not clear.', reopen_stage_key: 'library' } });
  assert.equal(res.status, 200);
  const after = await mine();
  assert.equal(stageOf(after, 'library').status, 'rejected');
  assert.equal(stageOf(after, 'library').comment, 'Library clearance passport is not clear.');
  assert.equal(stageOf(after, 'audit').status, 'locked');

  // The reopened stage's slip no longer verifies until it is approved again.
  assert.equal(stageOf(after, 'library').slip, null);
  const [[code]] = await pool.query('SELECT verification_code FROM clearance_slips WHERE stage_id = ?', [stageOf(after, 'library').stage_id]);
  assert.deepEqual((await api('GET', `/verify/${code.verification_code}`)).body, { valid: false });
});

test('after the reopened stage is approved again, Audit approves and the request completes', async () => {
  const lib = stageOf(await mine(), 'library');
  assert.equal((await api('POST', `/stages/${lib.stage_id}/submit`, { token: studentToken })).status, 200);
  assert.equal((await api('POST', `/review/stages/${lib.stage_id}/approve`, { token: tokens.library })).status, 200);

  const audit = stageOf(await mine(), 'audit');
  assert.equal(audit.status, 'pending');

  // Re-approval re-issues the library slip under the same number; anyone can verify it.
  const [[code]] = await pool.query('SELECT verification_code, slip_no FROM clearance_slips WHERE stage_id = ?', [lib.stage_id]);
  const verified = (await api('GET', `/verify/${code.verification_code}`)).body;
  assert.equal(verified.valid, true);
  assert.equal(verified.type, 'slip');
  assert.equal(verified.document, 'Library Clearance Slip');
  assert.equal(verified.slip_no, code.slip_no);
  assert.equal(verified.matric_no, MATRIC);

  assert.equal((await api('POST', `/review/stages/${audit.stage_id}/approve`, { token: tokens.audit })).status, 200);

  const done = await mine();
  assert.equal(done.request.status, 'completed');
  assert.ok(done.request.completed_at);
  assert.equal(done.progress.approved, 9);

  const [logs] = await pool.query(
    `SELECT DISTINCT action FROM audit_logs WHERE entity = 'clearance_stage' AND entity_id IN (SELECT stage_id FROM clearance_stages WHERE request_id = ?)`,
    [done.request.request_id]
  );
  const actions = logs.map((l) => l.action);
  for (const a of ['stage.unlock', 'stage.submit', 'stage.resubmit', 'stage.approve', 'stage.reject', 'stage.audit_reject', 'stage.auto_approve', 'stage.form_save']) {
    assert.ok(actions.includes(a), `audit log has ${a}`);
  }
});
