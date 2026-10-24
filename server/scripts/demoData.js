// Demo data matching the agreed mockups (docs/ui-mockups). Safe to re-run: it
// resets the two demo students' clearance first. Email and automatic document reading are off while it runs.
//
//   node scripts/demoData.js
//
// Creates:
//   Student 2022/248400 (ALIOZOR ...) departmental + faculty approved; library card
//                                    rejected ("photo is blurry") + N3,000 library fee
//   Student 2022/242722 (ALOGO ...)  departmental receipts waiting for review, one a
//                                    duplicate receipt number
//   Staff obi.demo@clearance.test          departmental officer, Computer Science
// All demo passwords: Demo@12345
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import env from '../src/config/env.js';
import pool from '../src/config/db.js';
import { startRequest, saveForm, submitStage, reviewDocument, approveStage, rejectStage } from '../src/services/workflowEngine.js';
import { saveUpload } from '../src/services/documentService.js';
import { raiseCharge } from '../src/services/paymentService.js';

env.email.enabled = false;
env.ocr.enabled = false; // the generated stand-in receipts have no text to read
const PASSWORD = 'Demo@12345';
const A = { matric: '2022/248400', email: 'ceke76795+aliozor@gmail.com' };
const B = { matric: '2022/242722', email: 'ceke76795+alogo@gmail.com' };

// ---- a small "receipt" PNG (white paper, header bar, grey text lines) ----
function receiptPng(seed) {
  const w = 240, h = 320;
  const rows = [];
  const rand = crypto.createHash('sha256').update(String(seed)).digest();
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      let c = [252, 251, 246];
      const line = Math.floor((y - 70) / 18);
      const lineLen = 120 + (rand[line % 32] % 90);
      if (y < 44) c = [20, 108, 60];
      else if (y >= 70 && y < 280 && (y - 70) % 18 < 7 && x > 20 && x < 20 + lineLen) c = [160, 168, 164];
      else if (y > 290 && y < 296 && x > 140 && x < 220) c = [60, 60, 60];
      row.set(c, 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

async function upload(studentId, stageId, slot, fields = {}) {
  const dir = path.join(env.uploads.dir, 'documents');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.png`;
  fs.writeFileSync(path.join(dir, name), receiptPng(`${stageId}-${slot.required_doc_id}-${slot.level}`));
  return saveUpload(studentId, stageId, { relativePath: `documents/${name}`, originalname: 'photo.png', mimetype: 'image/png' }, { required_doc_id: slot.required_doc_id, level: slot.level, ...fields });
}

async function context(studentId) {
  const { getStudentRequestView } = await import('../src/services/workflowEngine.js');
  return getStudentRequestView(studentId);
}
const stageOf = (view, key) => view.stages.find((s) => s.stage_key === key);

async function resetStudent(s) {
  const [[row]] = await pool.query('SELECT student_id, department_id FROM students WHERE matric_no = ?', [s.matric]);
  const [reqs] = await pool.query('SELECT request_id, letter_path FROM clearance_requests WHERE student_id = ?', [row.student_id]);
  for (const r of reqs) {
    const [files] = await pool.query('SELECT sd.file_path FROM stage_documents sd JOIN clearance_stages cs ON cs.stage_id = sd.stage_id WHERE cs.request_id = ?', [r.request_id]);
    const [certs] = await pool.query('SELECT file_path FROM certificates WHERE request_id = ?', [r.request_id]);
    for (const f of [...files.map((x) => x.file_path), ...certs.map((x) => x.file_path), r.letter_path].filter(Boolean)) fs.rmSync(path.join(env.uploads.dir, f), { force: true });
    await pool.query('DELETE sd FROM stage_documents sd JOIN clearance_stages cs ON cs.stage_id = sd.stage_id WHERE cs.request_id = ?', [r.request_id]);
    const [slips] = await pool.query('SELECT sl.file_path FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [r.request_id]);
    for (const sl of slips) fs.rmSync(path.join(env.uploads.dir, sl.file_path), { force: true });
    await pool.query('DELETE sl FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [r.request_id]);
    for (const t of ['payments', 'certificates', 'clearance_stages']) await pool.query(`DELETE FROM ${t} WHERE request_id = ?`, [r.request_id]);
    await pool.query('DELETE FROM clearance_requests WHERE request_id = ?', [r.request_id]);
  }
  await pool.query("DELETE FROM notifications WHERE recipient_type = 'student' AND recipient_id = ?", [row.student_id]);
  await pool.query('UPDATE students SET email = ?, password_hash = ?, registered_at = NOW(), results_released = FALSE, accommodation_type = ? WHERE student_id = ?', [s.email, await bcrypt.hash(PASSWORD, 10), 'on_campus', row.student_id]);
  return row.student_id;
}

async function staffUser(where, params) {
  const [[s]] = await pool.query(`SELECT staff_id, role, department_id, faculty_id FROM staff WHERE ${where}`, params);
  return { sub: s.staff_id, userType: 'staff', role: s.role, department_id: s.department_id, faculty_id: s.faculty_id };
}

async function acceptAll(user, stageId, view) {
  for (const slot of view.stages.find((s) => s.stage_id === stageId).slots) {
    if (slot.document && slot.document.status !== 'accepted') await reviewDocument(user, slot.document.document_id, { status: 'accepted', identity_confirmed: true });
  }
}

async function main() {
  const [[cs]] = await pool.query("SELECT department_id FROM departments WHERE name = 'Computer Science'");
  await pool.query(
    `INSERT INTO staff (full_name, email, role, department_id, password_hash, must_change_password)
     VALUES ('Mr. Obi', 'obi.demo@clearance.test', 'departmental', ?, ?, FALSE)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), must_change_password = FALSE, is_active = TRUE, department_id = VALUES(department_id), role = 'departmental'`,
    [cs.department_id, await bcrypt.hash(PASSWORD, 10)]
  );
  const obi = await staffUser('email = ?', ['obi.demo@clearance.test']);
  const facultyOfficer = await staffUser("role = 'faculty' AND faculty_id = (SELECT faculty_id FROM faculties WHERE name = 'Physical Sciences') AND is_active ORDER BY staff_id LIMIT 1", []);
  const library = await staffUser("role = 'library' AND is_active ORDER BY staff_id LIMIT 1", []);

  // ---- Student A: matches the student dashboard + library stage mockups ----
  const a = await resetStudent(A);
  await startRequest(a);
  let view = await context(a);
  const deptRefs = { 100: '0412', 200: '1180', 300: '0877', 400: '1523' };
  let dept = stageOf(view, 'departmental');
  for (const slot of dept.slots) {
    await upload(a, dept.stage_id, slot, { reference_no: deptRefs[slot.level] });
  }
  await submitStage(a, dept.stage_id);
  await acceptAll(obi, dept.stage_id, await context(a));
  await approveStage(obi, dept.stage_id);

  view = await context(a);
  const fac = stageOf(view, 'faculty');
  for (const slot of fac.slots) await upload(a, fac.stage_id, slot, { reference_no: `F${slot.level || 'HC'}${slot.required_doc_id}` });
  await submitStage(a, fac.stage_id);
  await acceptAll(facultyOfficer, fac.stage_id, await context(a));
  await approveStage(facultyOfficer, fac.stage_id);

  view = await context(a);
  const lib = stageOf(view, 'library');
  await saveForm(a, lib.stage_id, { library_registered: true });
  view = await context(a);
  const card = stageOf(view, 'library').slots[0];
  await upload(a, lib.stage_id, card);
  await submitStage(a, lib.stage_id);
  view = await context(a);
  const cardDoc = stageOf(view, 'library').slots[0].document;
  await reviewDocument(library, cardDoc.document_id, { status: 'rejected', reviewer_note: 'The photo is blurry. Please upload a clearer image.' });
  await raiseCharge(library, lib.stage_id, { amount: 3000, description: 'Library fee, 200 and 300 level', purpose: 'library_fee' });
  await rejectStage(library, lib.stage_id, { comment: 'The photo is blurry. Please upload a clearer image.' });

  // ---- Student B: matches the departmental review mockup ----
  const b = await resetStudent(B);
  await startRequest(b);
  view = await context(b);
  dept = stageOf(view, 'departmental');
  const bRefs = { 100: '0398', 200: '1191', 300: '0877', 400: '1530' };
  for (const slot of dept.slots) {
    await upload(b, dept.stage_id, slot, { reference_no: bRefs[slot.level] });
  }
  await submitStage(b, dept.stage_id);
  view = await context(b);
  for (const slot of stageOf(view, 'departmental').slots.filter((s) => s.level <= 200)) {
    await reviewDocument(obi, slot.document.document_id, { status: 'accepted', identity_confirmed: true });
  }

  console.log('Demo data ready (password for all: Demo@12345)');
  console.log(`  Student ${A.matric}: library stage sent back + N3,000 fee`);
  console.log(`  Student ${B.matric}: departmental receipts waiting (300 level is a duplicate)`);
  console.log('  Staff obi.demo@clearance.test: departmental officer, Computer Science');
}

main()
  .catch((err) => {
    console.error('Demo data failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
