// Unit tests for the workflow rules (no database needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateUnlock, computeSlots, submissionBlockers } from '../src/services/workflowEngine.js';

const STAGES = [
  ['departmental', 1, 'sequential'],
  ['faculty', 2, 'sequential'],
  ['library', 3, 'sequential'],
  ['alumni', 4, 'sequential'],
  ['student_affairs', 5, 'sequential'],
  ['security', 6, 'sequential'],
  ['letter', 7, 'sequential'],
  ['convocation', 8, 'anytime'],
  ['audit', 9, 'all_others_approved'],
];
const makeStages = (statuses = {}) =>
  STAGES.map(([stage_key, sequence_order, unlock_rule]) => ({ stage_key, sequence_order, unlock_rule, status: statuses[stage_key] || 'locked' }));
const get = (stages, key) => stages.find((s) => s.stage_key === key);
const student = { levels_count: 4, accommodation_type: 'on_campus' };

// --- unlock rules ---

test('at request creation only departmental and convocation are unlockable', () => {
  const stages = makeStages();
  const open = stages.filter((s) => evaluateUnlock(s, stages, student)).map((s) => s.stage_key);
  assert.deepEqual(open, ['departmental', 'convocation']);
});

test('sequential: a stage unlocks only when the previous stage is approved', () => {
  for (const prevStatus of ['locked', 'awaiting_submission', 'pending', 'rejected']) {
    const stages = makeStages({ departmental: prevStatus });
    assert.equal(evaluateUnlock(get(stages, 'faculty'), stages, student), false, prevStatus);
  }
  const stages = makeStages({ departmental: 'approved' });
  assert.equal(evaluateUnlock(get(stages, 'faculty'), stages, student), true);
  assert.equal(evaluateUnlock(get(stages, 'library'), stages, student), false);
});

test('sequential: security waits for accommodation', () => {
  const stages = makeStages({ departmental: 'approved', faculty: 'approved', library: 'approved', alumni: 'approved', student_affairs: 'pending' });
  assert.equal(evaluateUnlock(get(stages, 'security'), stages, student), false);
  get(stages, 'student_affairs').status = 'approved';
  assert.equal(evaluateUnlock(get(stages, 'security'), stages, student), true);
});

test('convocation is never blocked by other stages', () => {
  const stages = makeStages({ departmental: 'rejected' });
  assert.equal(evaluateUnlock(get(stages, 'convocation'), stages, student), true);
});

test('the graduation list stage opens only after Security is approved', () => {
  const before = makeStages({ departmental: 'approved', faculty: 'approved', library: 'approved', alumni: 'approved', student_affairs: 'approved', security: 'pending', convocation: 'approved' });
  assert.equal(evaluateUnlock(get(before, 'letter'), before, student), false);
  get(before, 'security').status = 'approved';
  assert.equal(evaluateUnlock(get(before, 'letter'), before, student), true);
});

test('audit unlocks only when all eight other stages are approved', () => {
  const allButLetter = Object.fromEntries(STAGES.filter(([k]) => k !== 'audit' && k !== 'letter').map(([k]) => [k, 'approved']));
  const stages = makeStages({ ...allButLetter, letter: 'awaiting_submission' });
  assert.equal(evaluateUnlock(get(stages, 'audit'), stages, student), false);
  get(stages, 'letter').status = 'approved';
  assert.equal(evaluateUnlock(get(stages, 'audit'), stages, student), true);
});

test('unknown unlock rules never unlock', () => {
  assert.equal(evaluateUnlock({ stage_key: 'x', sequence_order: 10, unlock_rule: 'whenever' }, makeStages(), student), false);
});

// --- slot generation ---

const doc = (id, extra) => ({ required_doc_id: id, name: `Doc ${id}`, per_level: 0, applies_if: 'always', is_required: 1, display_order: id, ...extra });

test('per-level documents repeat for every level, grouped by level, then single documents', () => {
  const docs = [doc(1, { per_level: 1 }), doc(2, { per_level: 1 }), doc(3)];
  const slots = computeSlots(docs, student, null).map((s) => `${s.required_doc_id}@${s.level}`);
  assert.deepEqual(slots, ['1@100', '2@100', '1@200', '2@200', '1@300', '2@300', '1@400', '2@400', '3@0']);
});

test('a 5-year student gets 500-level slots', () => {
  const slots = computeSlots([doc(1, { per_level: 1 })], { ...student, levels_count: 5 }, null);
  assert.deepEqual(slots.map((s) => s.level), [100, 200, 300, 400, 500]);
});

test('off-campus slots appear only for off-campus students', () => {
  const docs = [doc(1), doc(2, { applies_if: 'off_campus' })];
  assert.equal(computeSlots(docs, student, null).length, 1);
  assert.equal(computeSlots(docs, { ...student, accommodation_type: 'off_campus' }, null).length, 2);
});

test('library slots follow the library choice, and none apply before it is made', () => {
  const docs = [doc(1, { applies_if: 'library_registered' }), doc(2, { applies_if: 'library_not_registered' }), doc(3, { applies_if: 'library_not_registered' })];
  assert.equal(computeSlots(docs, student, null).length, 0);
  assert.deepEqual(computeSlots(docs, student, { library_registered: true }).map((s) => s.required_doc_id), [1]);
  assert.deepEqual(computeSlots(docs, student, { library_registered: false }).map((s) => s.required_doc_id), [2, 3]);
});

// --- submission blockers ---

const ctxFor = ({ documents = [], payments = [], requiredDocs }) => ({ student, documents, payments, requiredDocs });

test('a stage cannot be submitted until every required slot has an upload', () => {
  const requiredDocs = [doc(1, { stage_key: 'departmental', per_level: 1 })];
  const stage = { stage_id: 5, stage_key: 'departmental', name: 'Departmental Clearance', status: 'awaiting_submission', fee_amount: null };
  const uploads = [100, 200, 300].map((level) => ({ stage_id: 5, required_doc_id: 1, level, status: 'pending' }));
  assert.deepEqual(submissionBlockers(ctxFor({ requiredDocs, documents: uploads }), stage), ['Upload: Doc 1 (400 level)']);
  uploads.push({ stage_id: 5, required_doc_id: 1, level: 400, status: 'pending' });
  assert.deepEqual(submissionBlockers(ctxFor({ requiredDocs, documents: uploads }), stage), []);
});

test('rejected documents must be replaced before resubmitting', () => {
  const requiredDocs = [doc(1, { stage_key: 'alumni' })];
  const stage = { stage_id: 9, stage_key: 'alumni', name: 'Alumni Clearance', status: 'rejected', fee_amount: null };
  const blockers = submissionBlockers(ctxFor({ requiredDocs, documents: [{ stage_id: 9, required_doc_id: 1, level: 0, status: 'rejected' }] }), stage);
  assert.deepEqual(blockers, ['Replace rejected document: Doc 1']);
});

test('a fixed-fee stage cannot be submitted until the fee is paid', () => {
  const stage = { stage_id: 9, stage_key: 'alumni', name: 'Alumni Clearance', status: 'awaiting_submission', fee_amount: 650 };
  const unpaid = [{ stage_id: 9, purpose: 'stage_fee', status: 'unpaid' }];
  assert.equal(submissionBlockers(ctxFor({ requiredDocs: [], payments: unpaid }), stage).length, 1);
  assert.equal(submissionBlockers(ctxFor({ requiredDocs: [], payments: [{ ...unpaid[0], status: 'success' }] }), stage).length, 0);
});

test('required form fields block submission', () => {
  const stage = { stage_id: 3, stage_key: 'library', name: 'Library Clearance', status: 'awaiting_submission', fee_amount: null, form_data: null };
  assert.deepEqual(submissionBlockers(ctxFor({ requiredDocs: [] }), stage), ['Fill in: Library registration']);
});

test('locked, pending and approved stages cannot be submitted', () => {
  for (const status of ['locked', 'pending', 'approved']) {
    const stage = { stage_id: 1, stage_key: 'alumni', name: 'Alumni', status, fee_amount: null };
    assert.equal(submissionBlockers(ctxFor({ requiredDocs: [] }), stage).length, 1, status);
  }
});

// --- automatic name / reg-number check (OCR text matching) ---
import { matchIdentity } from '../src/services/ocrService.js';

const ekwe = { full_name: 'EKWE CHIOMA CYNTHIA', matric_no: '2022/241211' };

test('a printed library card matches even when OCR reads "/" as 7', () => {
  // Real OCR output from a library card photo.
  const text = 'UNIVERSITY OF NIGERIA |\nLibrary Passy\nReg: Nwmbes 20227241211 > :\nName:\nEKWE CHIOMA CYNTHIA\nDepartment:\nCOMPUTER SCIENCE';
  assert.deepEqual(matchIdentity(text, ekwe), { status: 'match', reg_found: true, name_found: true, name_parts_found: 3, name_parts: 3 });
});

test('one wrong letter in a longer name is tolerated', () => {
  assert.equal(matchIdentity('Name: EKWE CHI0MA CYNTHlA Reg 2022/241211', ekwe).status, 'match');
});

test('another student\'s document does not match', () => {
  assert.equal(matchIdentity('Name: OKAFOR MICHAEL OSINACHI Reg 2022/246655', ekwe).status, 'no_match');
});

test('only the reg number, or only the name, is a partial match', () => {
  assert.equal(matchIdentity('Reg No 2022/241211', ekwe).status, 'partial');
  assert.equal(matchIdentity('EKWE CHIOMA', ekwe).status, 'partial');
});

test('a garbled handwritten receipt is not mistaken for a match', () => {
  // Real OCR output from a handwritten NACOS receipt for EKE CHUKWUEMEKA OGADIMMA, 2022/246810.
  const text = 'CASHRECEPT NACOS DUES / DEPT. LEVIES\n0/2024. Date: LEAL 2023 Ne: (195\nReceived from: Eke Chubuenvta Doadiowa';
  assert.equal(matchIdentity(text, { full_name: 'EKE CHUKWUEMEKA OGADIMMA', matric_no: '2022/246810' }).status, 'no_match');
});

test('a typed graduation list PDF: the pages with the student are found', async () => {
  const { pagesWithMatch } = await import('../src/services/ocrService.js');
  const pages = [
    'GRADUATION LIST 2025/2026 PAGE 1  1. OKAFOR MICHAEL 2022/246655  2. UGWU ARINZE 2022/242405',
    'PAGE 2  18. EKWE CHIOMA CYNTHIA 2022/241211 BSc (Hons) Second Class Upper',
    'PAGE 3  31. EZE TITUS 2022/245998',
  ];
  assert.deepEqual(pagesWithMatch(pages, ekwe), [2]);
  assert.deepEqual(pagesWithMatch(pages, { full_name: 'NOBODY HERE', matric_no: '2022/999999' }), []);
});

test('reading a real typed PDF finds the page the student is on', async () => {
  const { pdfPageTexts, pagesWithMatch } = await import('../src/services/ocrService.js');
  const { default: PDFDocument } = await import('pdfkit');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(os.tmpdir(), `grad-list-${process.pid}.pdf`);
  await new Promise((resolve) => {
    const doc = new PDFDocument();
    doc.pipe(fs.createWriteStream(file)).on('finish', resolve);
    doc.text('GRADUATION LIST - PAGE 1').text('1. OKAFOR MICHAEL OSINACHI 2022/246655');
    doc.addPage().text('GRADUATION LIST - PAGE 2').text('18. EKWE CHIOMA CYNTHIA 2022/241211 BSc (Hons)');
    doc.end();
  });
  try {
    const pages = await pdfPageTexts(file);
    assert.equal(pages.length, 2);
    assert.deepEqual(pagesWithMatch(pages, ekwe), [2]);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
