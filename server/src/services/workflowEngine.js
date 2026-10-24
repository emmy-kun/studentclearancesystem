// Clearance workflow engine (spec section 4).
//
// Every state change runs in a transaction that first locks the request row
// (SELECT ... FOR UPDATE), so concurrent actions on one student's clearance are
// serialised. Pure functions (computeSlots, evaluateUnlock, submissionBlockers)
// hold the rules and are unit-tested without a database.
//
// Upload slots are computed, not stored: a stage_documents row always holds an
// uploaded file, so a stage's slots are derived from required_documents, the
// student (levels_count, accommodation_type) and the stage's form_data.
import crypto from 'node:crypto';
import pool, { withTransaction } from '../config/db.js';
import env from '../config/env.js';
import httpError from '../utils/httpError.js';
import { inScope } from '../middleware/requireRole.js';
import { logAudit } from './auditLog.js';
import { notifyStudent, notifyReviewers } from './notificationService.js';
import { hasForm, sanitizeForm, missingFormFields, FIELD_LABELS } from './stageForms.js';
import { issueCertificate } from './certificateService.js';
import { issueSlip, slipTitle } from './slipService.js';
import { createLetter } from './letterService.js';
import { deleteFile } from './storage.js';

export const EDITABLE = ['awaiting_submission', 'rejected'];

/** "Alumni Clearance" -> "Alumni Clearance fee"; "Convocation Fee" stays as it is (not "Convocation Fee fee"). */
export const feeName = (stage) => (/\bfee\b/i.test(stage.name) ? stage.name : `${stage.name} fee`);

export const naira = (amount) => `₦${Number(amount).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** Does a required document apply to this student / stage form? */
export function slotApplies(doc, student, formData) {
  switch (doc.applies_if) {
    case 'always':
      return true;
    case 'off_campus':
      return student.accommodation_type === 'off_campus';
    case 'library_registered':
      return formData?.library_registered === true;
    case 'library_not_registered':
      return formData?.library_registered === false;
    default:
      return false;
  }
}

/**
 * Upload slots for one stage. per_level documents repeat for 100..levels_count*100
 * (grouped by level); other documents use level 0 and follow them.
 */
export function computeSlots(stageDocs, student, formData) {
  const perLevel = [];
  const single = [];
  for (const doc of stageDocs) {
    if (!slotApplies(doc, student, formData)) continue;
    if (doc.per_level) {
      for (let i = 1; i <= student.levels_count; i++) perLevel.push({ ...doc, level: i * 100 });
    } else {
      single.push({ ...doc, level: 0 });
    }
  }
  const byOrder = (a, b) => a.display_order - b.display_order || a.required_doc_id - b.required_doc_id;
  perLevel.sort((a, b) => a.level - b.level || byOrder(a, b));
  single.sort(byOrder);
  return [...perLevel, ...single];
}

export const slotKey = (requiredDocId, level) => `${requiredDocId}:${level}`;

export function slotLabel(slot) {
  return slot.level ? `${slot.name} (${slot.level} level)` : slot.name;
}

/** Is a locked stage's unlock rule met? `stages` is every stage of the request. */
export function evaluateUnlock(stage, stages, student) {
  switch (stage.unlock_rule) {
    case 'sequential': {
      const prev = stages
        .filter((s) => s.sequence_order < stage.sequence_order)
        .sort((a, b) => b.sequence_order - a.sequence_order)[0];
      return !prev || prev.status === 'approved';
    }
    case 'anytime':
      return true;
    case 'on_results_released':
      return Boolean(student.results_released);
    case 'all_others_approved':
      return stages.every((s) => s.stage_key === stage.stage_key || s.status === 'approved');
    default:
      return false;
  }
}

/**
 * What still stops the student submitting this stage (empty array = ready).
 * `ctx` needs: student, requiredDocs, documents, payments.
 */
export function submissionBlockers(ctx, stage) {
  if (!EDITABLE.includes(stage.status)) return ['This stage is not open for submission'];

  const blockers = [];
  for (const f of missingFormFields(stage.stage_key, stage.form_data)) {
    blockers.push(`Fill in: ${FIELD_LABELS[f] || f}`);
  }

  const uploads = new Map(ctx.documents.filter((d) => d.stage_id === stage.stage_id).map((d) => [slotKey(d.required_doc_id, d.level), d]));
  for (const slot of computeSlots(stageDocsFor(ctx, stage.stage_key), ctx.student, stage.form_data)) {
    const doc = uploads.get(slotKey(slot.required_doc_id, slot.level));
    if (!doc && slot.is_required) blockers.push(`Upload: ${slotLabel(slot)}`);
    else if (doc?.status === 'rejected') blockers.push(`Replace rejected document: ${slotLabel(slot)}`);
  }

  if (stage.fee_amount) {
    const fee = feePaymentFor(ctx, stage);
    if (!fee || fee.status !== 'success') blockers.push(`Pay the ${naira(stage.fee_amount)} ${feeName(stage).toLowerCase()}`);
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

export const stageDocsFor = (ctx, stageKey) => ctx.requiredDocs.filter((d) => d.stage_key === stageKey);
const feePaymentFor = (ctx, stage) =>
  ctx.payments.find((p) => p.stage_id === stage.stage_id && (p.purpose === 'stage_fee' || p.purpose === 'convocation'));

/** Load everything about a request. With lock=true the request row is locked for the transaction. */
export async function loadContext(db, requestId, { lock = false } = {}) {
  const [[request]] = await db.query(`SELECT * FROM clearance_requests WHERE request_id = ?${lock ? ' FOR UPDATE' : ''}`, [requestId]);
  if (!request) throw httpError(404, 'Clearance request not found');

  const [[student]] = await db.query(
    `SELECT s.student_id, s.matric_no, s.full_name, s.email, s.levels_count, s.accommodation_type,
            s.results_released, s.graduation_session, s.department_id, d.name AS department,
            d.faculty_id, f.name AS faculty
       FROM students s
       JOIN departments d ON d.department_id = s.department_id
       JOIN faculties f ON f.faculty_id = d.faculty_id
      WHERE s.student_id = ?`,
    [request.student_id]
  );
  const [stages] = await db.query(
    `SELECT cs.*, ws.name, ws.reviewer_role, ws.sequence_order, ws.unlock_rule, ws.review_mode, ws.fee_amount
       FROM clearance_stages cs
       JOIN workflow_stages ws ON ws.stage_key = cs.stage_key
      WHERE cs.request_id = ?
      ORDER BY ws.sequence_order`,
    [requestId]
  );
  const [requiredDocs] = await db.query('SELECT * FROM required_documents ORDER BY stage_key, display_order, required_doc_id');
  const [documents] = await db.query(
    `SELECT sd.* FROM stage_documents sd
       JOIN clearance_stages cs ON cs.stage_id = sd.stage_id
      WHERE cs.request_id = ?`,
    [requestId]
  );
  const [payments] = await db.query(
    `SELECT payment_id, stage_id, purpose, description, amount, currency, reference, status, raised_by, created_at, paid_at
       FROM payments WHERE request_id = ? ORDER BY created_at, payment_id`,
    [requestId]
  );
  const [slips] = await db.query(
    `SELECT sl.slip_id, sl.stage_id, sl.slip_no, sl.issued_at, st.full_name AS issued_by_name
       FROM clearance_slips sl
       JOIN clearance_stages cs ON cs.stage_id = sl.stage_id
       LEFT JOIN staff st ON st.staff_id = sl.issued_by
      WHERE cs.request_id = ?`,
    [requestId]
  );
  return { request, student, stages, requiredDocs, documents, payments, slips };
}

export async function requestIdForStage(db, stageId) {
  const [[row]] = await db.query('SELECT request_id FROM clearance_stages WHERE stage_id = ?', [stageId]);
  if (!row) throw httpError(404, 'Stage not found');
  return row.request_id;
}

export function findStage(ctx, stageId) {
  const stage = ctx.stages.find((s) => s.stage_id === stageId);
  if (!stage) throw httpError(404, 'Stage not found');
  return stage;
}

export function assertOwner(ctx, studentId) {
  if (ctx.request.student_id !== studentId) throw httpError(404, 'Stage not found');
}

/** A reviewer may act on a stage only if it is their role's stage and the student is in scope. */
export function assertCanReview(user, ctx, stage) {
  if (stage.reviewer_role === null || user.role !== stage.reviewer_role) throw httpError(403, 'This stage is not reviewed by your office');
  if (!inScope(user, ctx.student)) throw httpError(403, 'This student is outside your scope');
}

/** Stage has nothing for the student to do (no documents, no form) and needs a person to review it, e.g. Audit. */
function goesStraightToReview(ctx, stage) {
  return stage.review_mode === 'manual' && !hasForm(stage.stage_key) && stageDocsFor(ctx, stage.stage_key).length === 0;
}

export { uploadPath } from './storage.js';

export async function deleteFiles(relativePaths) {
  for (const p of relativePaths) await deleteFile(p);
}

// ---------------------------------------------------------------------------
// Unlock check (rule 6)
// ---------------------------------------------------------------------------

async function ensureFeePayment(conn, ctx, stage) {
  if (!stage.fee_amount || feePaymentFor(ctx, stage)) return;
  const purpose = stage.stage_key === 'convocation' ? 'convocation' : 'stage_fee';
  const reference = `CLR${ctx.request.request_id}-${stage.stage_key.slice(0, 4).toUpperCase()}-${crypto.randomBytes(5).toString('hex')}`;
  const [res] = await conn.query(
    `INSERT INTO payments (request_id, stage_id, purpose, description, amount, reference)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [ctx.request.request_id, stage.stage_id, purpose, feeName(stage), stage.fee_amount, reference]
  );
  ctx.payments.push({ payment_id: res.insertId, stage_id: stage.stage_id, purpose, amount: stage.fee_amount, status: 'unpaid', reference });
}

function unlockMessage(stage) {
  if (stage.stage_key === 'letter') return 'Security cleared. Upload the graduation list and say which page your name is on; your application letter is generated once your department verifies it.';
  if (stage.stage_key === 'audit') return 'All your stages are approved. Your file has been sent to Audit for final review.';
  const fee = stage.fee_amount ? ` A ${naira(stage.fee_amount)} fee applies.` : '';
  return `${stage.name} is now open. Upload your documents to continue.${fee}`;
}

/**
 * Unlock every locked stage whose rule is now met. Must run inside a transaction
 * that has locked the request (ctx from loadContext(conn, id, { lock: true })).
 * Returns the stage keys unlocked.
 */
export async function runUnlockCheck(conn, ctx) {
  const unlocked = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of ctx.stages) {
      if (stage.status !== 'locked' || !evaluateUnlock(stage, ctx.stages, ctx.student)) continue;

      const straightToReview = goesStraightToReview(ctx, stage);
      stage.status = straightToReview ? 'pending' : 'awaiting_submission';
      await conn.query(
        `UPDATE clearance_stages
            SET status = ?, unlocked_at = NOW(), submitted_at = ${straightToReview ? 'NOW()' : 'NULL'}
          WHERE stage_id = ?`,
        [stage.status, stage.stage_id]
      );
      await ensureFeePayment(conn, ctx, stage);
      await notifyStudent(ctx.student.student_id, unlockMessage(stage), conn, `/student/stage/${stage.stage_id}`);
      if (straightToReview) {
        await notifyReviewers(stage.reviewer_role, ctx.student, `New ${stage.name} file: ${ctx.student.full_name} (${ctx.student.matric_no})`, conn, `/staff/review/${stage.stage_id}`);
      }
      await logAudit({ actorType: 'system', action: 'stage.unlock', entity: 'clearance_stage', entityId: stage.stage_id, detail: { stage_key: stage.stage_key, status: stage.status } }, conn);
      unlocked.push(stage.stage_key);
      changed = true;
    }
  }
  return unlocked;
}

/** Re-run the unlock check for one request in its own transaction (e.g. after results release or a payment). */
export async function recheckRequest(requestId) {
  return withTransaction(async (conn) => runUnlockCheck(conn, await loadContext(conn, requestId, { lock: true })));
}

// ---------------------------------------------------------------------------
// Student actions
// ---------------------------------------------------------------------------

/** Rule 1 + 10: create the request and its stages, then unlock what is already reachable. */
export async function startRequest(studentId) {
  try {
    return await withTransaction(async (conn) => {
      const [[student]] = await conn.query('SELECT student_id, graduation_session FROM students WHERE student_id = ? FOR UPDATE', [studentId]);
      if (!student) throw httpError(404, 'Student not found');
      const session = student.graduation_session || env.currentSession;

      const [[existing]] = await conn.query('SELECT request_id FROM clearance_requests WHERE student_id = ? AND session = ?', [studentId, session]);
      if (existing) throw httpError(409, `You have already started clearance for ${session}`, { request_id: existing.request_id });

      const [{ insertId: requestId }] = await conn.query('INSERT INTO clearance_requests (student_id, session) VALUES (?, ?)', [studentId, session]);
      const [workflow] = await conn.query('SELECT stage_key FROM workflow_stages WHERE is_active = TRUE ORDER BY sequence_order');
      for (const w of workflow) {
        await conn.query("INSERT INTO clearance_stages (request_id, stage_key, status) VALUES (?, ?, 'locked')", [requestId, w.stage_key]);
      }

      const ctx = await loadContext(conn, requestId, { lock: true });
      const unlocked = await runUnlockCheck(conn, ctx);
      await logAudit({ actorType: 'student', actorId: studentId, action: 'request.create', entity: 'clearance_request', entityId: requestId, detail: { session, unlocked } }, conn);
      return requestId;
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'You have already started clearance for this session');
    throw err;
  }
}

/**
 * Save a stage's form fields. Changing the library choice or accommodation type
 * changes which slots apply; uploads for slots that no longer apply (in stages
 * the student can still edit) are removed.
 */
export async function saveForm(studentId, stageId, input) {
  const filesToDelete = [];
  await withTransaction(async (conn) => {
    const ctx = await loadContext(conn, await requestIdForStage(conn, stageId), { lock: true });
    assertOwner(ctx, studentId);
    const stage = findStage(ctx, stageId);
    if (!hasForm(stage.stage_key)) throw httpError(400, 'This stage has no form to fill');
    if (!EDITABLE.includes(stage.status)) throw httpError(409, 'This stage cannot be changed right now');

    const data = sanitizeForm(stage.stage_key, input);
    await conn.query('UPDATE clearance_stages SET form_data = ? WHERE stage_id = ?', [JSON.stringify(data), stageId]);
    stage.form_data = data;

    if (data.accommodation_type && data.accommodation_type !== ctx.student.accommodation_type) {
      await conn.query('UPDATE students SET accommodation_type = ? WHERE student_id = ?', [data.accommodation_type, studentId]);
      ctx.student.accommodation_type = data.accommodation_type;
    }

    for (const s of ctx.stages.filter((x) => EDITABLE.includes(x.status))) {
      const valid = new Set(computeSlots(stageDocsFor(ctx, s.stage_key), ctx.student, s.form_data).map((sl) => slotKey(sl.required_doc_id, sl.level)));
      for (const doc of ctx.documents.filter((d) => d.stage_id === s.stage_id && !valid.has(slotKey(d.required_doc_id, d.level)))) {
        await conn.query('DELETE FROM stage_documents WHERE document_id = ?', [doc.document_id]);
        filesToDelete.push(doc.file_path);
      }
    }
    await logAudit({ actorType: 'student', actorId: studentId, action: 'stage.form_save', entity: 'clearance_stage', entityId: stageId, detail: { stage_key: stage.stage_key, removed_uploads: filesToDelete.length } }, conn);
  });
  await deleteFiles(filesToDelete);
}

/** Rule 2 (and 7 for auto stages): submit a stage for review. */
export async function submitStage(studentId, stageId) {
  return withFileTransaction(async (conn, files) => {
    const ctx = await loadContext(conn, await requestIdForStage(conn, stageId), { lock: true });
    assertOwner(ctx, studentId);
    const stage = findStage(ctx, stageId);

    const blockers = submissionBlockers(ctx, stage);
    if (blockers.length) throw httpError(400, 'This stage is not ready to submit', { blockers });

    const resubmission = stage.status === 'rejected';
    if (stage.review_mode === 'auto') {
      await autoApprove(conn, ctx, stage, files);
      await runUnlockCheck(conn, ctx);
    } else {
      await conn.query("UPDATE clearance_stages SET status = 'pending', submitted_at = NOW() WHERE stage_id = ?", [stageId]);
      stage.status = 'pending';
      const verb = resubmission ? 'Resubmitted' : 'New';
      await notifyReviewers(stage.reviewer_role, ctx.student, `${verb} ${stage.name} submission: ${ctx.student.full_name} (${ctx.student.matric_no})`, conn, `/staff/review/${stageId}`);
    }
    await logAudit({ actorType: 'student', actorId: studentId, action: resubmission ? 'stage.resubmit' : 'stage.submit', entity: 'clearance_stage', entityId: stageId, detail: { stage_key: stage.stage_key } }, conn);
    return stage.status;
  });
}

// ---------------------------------------------------------------------------
// Reviewer actions
// ---------------------------------------------------------------------------

/** Accept or reject one document while the stage is pending (saved immediately). */
export async function reviewDocument(user, documentId, { status, reviewer_note, identity_confirmed }) {
  if (!['accepted', 'rejected'].includes(status)) throw httpError(400, 'status must be accepted or rejected');
  const note = typeof reviewer_note === 'string' ? reviewer_note.trim().slice(0, 255) : '';
  if (status === 'rejected' && !note) throw httpError(400, 'Add a note telling the student what is wrong');

  return withTransaction(async (conn) => {
    const [[doc]] = await conn.query('SELECT document_id, stage_id FROM stage_documents WHERE document_id = ?', [documentId]);
    if (!doc) throw httpError(404, 'Document not found');
    const ctx = await loadContext(conn, await requestIdForStage(conn, doc.stage_id), { lock: true });
    const stage = findStage(ctx, doc.stage_id);
    assertCanReview(user, ctx, stage);
    if (stage.status !== 'pending') throw httpError(409, 'Documents can only be reviewed while the stage is waiting for review');

    const fullDoc = ctx.documents.find((d) => d.document_id === documentId);
    const reqDoc = ctx.requiredDocs.find((r) => r.required_doc_id === fullDoc.required_doc_id);
    // Every document that carries the student's details must be checked by a person before it is accepted.
    if (status === 'accepted' && reqDoc.check_identity && identity_confirmed !== true) {
      throw httpError(400, 'Confirm that the name and reg number on the document match the student before accepting it');
    }

    await conn.query('UPDATE stage_documents SET status = ?, reviewer_note = ? WHERE document_id = ?', [status, status === 'rejected' ? note : null, documentId]);
    if (status === 'rejected') {
      // The student can replace a rejected document straight away, so tell them now.
      const label = slotLabel({ name: reqDoc.name, level: fullDoc.level });
      await notifyStudent(ctx.student.student_id, `${stage.name}: your ${label} was rejected: "${note}". Upload a new photo of it.`, conn, `/student/stage/${stage.stage_id}`);
    }
    await logAudit({ actorType: 'staff', actorId: user.sub, action: `document.${status === 'accepted' ? 'accept' : 'reject'}`, entity: 'stage_document', entityId: documentId, detail: { stage_id: stage.stage_id, note: note || null, ...(status === 'accepted' && reqDoc.check_identity && { identity_confirmed: true, ocr_status: fullDoc.ocr_status }) } }, conn);
    return { document_id: documentId, status, reviewer_note: status === 'rejected' ? note : null };
  });
}

/** Rule 3 (+ mockup: every document accepted) and rule 9 for Audit. */
/**
 * A transaction that may write PDFs (slips, certificate): files it created are
 * removed if it rolls back; files it replaced are removed once it commits.
 */
export async function withFileTransaction(fn) {
  const files = { created: [], replaced: [] };
  try {
    const result = await withTransaction((conn) => fn(conn, files));
    await deleteFiles(files.replaced);
    return result;
  } catch (err) {
    await deleteFiles(files.created);
    throw err;
  }
}

/** Approve an automatic stage (convocation): no reviewer, slip issued by the system. */
async function autoApprove(conn, ctx, stage, files) {
  await conn.query("UPDATE clearance_stages SET status = 'approved', submitted_at = NOW(), reviewed_at = NOW(), reviewed_by = NULL WHERE stage_id = ?", [stage.stage_id]);
  await conn.query("UPDATE stage_documents SET status = 'accepted' WHERE stage_id = ?", [stage.stage_id]);
  stage.status = 'approved';
  await issueStageSlip(conn, ctx, stage, null, files);
  await notifyStudent(ctx.student.student_id, `${stage.name} confirmed and approved. Your ${slipTitle(stage.stage_key) || 'receipt'} is ready to download.`, conn, `/student/stage/${stage.stage_id}`);
  await logAudit({ actorType: 'system', action: 'stage.auto_approve', entity: 'clearance_stage', entityId: stage.stage_id, detail: { stage_key: stage.stage_key } }, conn);
}

/**
 * Rule 7: automatic stages complete themselves as soon as nothing is outstanding.
 * Convocation has nothing to upload, so it completes the moment its fee payment is
 * confirmed. Call inside the transaction that confirmed the payment.
 */
export async function autoApproveReadyStages(conn, ctx, files) {
  const done = [];
  for (const stage of ctx.stages) {
    if (stage.review_mode !== 'auto' || !EDITABLE.includes(stage.status)) continue;
    if (submissionBlockers(ctx, stage).length) continue;
    await autoApprove(conn, ctx, stage, files);
    done.push(stage.stage_key);
  }
  return done;
}

/** Issue the stage's clearance slip and track its files. */
async function issueStageSlip(conn, ctx, stage, staffId, files) {
  const slip = await issueSlip(conn, ctx, stage, staffId);
  if (!slip) return;
  files.created.push(slip.file_path);
  if (slip.replaced_path) files.replaced.push(slip.replaced_path);
}

export function approveStage(user, stageId, { comment } = {}) {
  return withFileTransaction(async (conn, files) => {
    const ctx = await loadContext(conn, await requestIdForStage(conn, stageId), { lock: true });
    const stage = findStage(ctx, stageId);
    assertCanReview(user, ctx, stage);
    if (stage.status !== 'pending') throw httpError(409, 'Only stages waiting for review can be approved');

    const slots = new Set(computeSlots(stageDocsFor(ctx, stage.stage_key), ctx.student, stage.form_data).map((s) => slotKey(s.required_doc_id, s.level)));
    const docs = ctx.documents.filter((d) => d.stage_id === stageId && slots.has(slotKey(d.required_doc_id, d.level)));
    const notAccepted = docs.filter((d) => d.status !== 'accepted');
    if (notAccepted.length) throw httpError(400, `Accept every document before approving (${notAccepted.length} still not accepted)`);

    const unpaid = ctx.payments.filter((p) => p.stage_id === stageId && p.status !== 'success');
    if (unpaid.length) throw httpError(400, `This stage has ${unpaid.length} unpaid ${unpaid.length === 1 ? 'charge' : 'charges'}. The student must pay before it can be approved.`);

    const note = typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 2000) : null;
    await conn.query("UPDATE clearance_stages SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), comment = ? WHERE stage_id = ?", [user.sub, note, stageId]);
    stage.status = 'approved';
    await logAudit({ actorType: 'staff', actorId: user.sub, action: 'stage.approve', entity: 'clearance_stage', entityId: stageId, detail: { stage_key: stage.stage_key } }, conn);

    if (stage.stage_key === 'audit') {
      await conn.query("UPDATE clearance_requests SET status = 'completed', completed_at = NOW() WHERE request_id = ?", [ctx.request.request_id]);
      const cert = await issueCertificate(conn, ctx.request.request_id);
      if (cert?.created) files.created.push(cert.file_path);
      await notifyStudent(ctx.student.student_id, 'Congratulations! Your clearance is complete. Your clearance certificate is ready to download.', conn, '/student');
      await logAudit({ actorType: 'staff', actorId: user.sub, action: 'request.complete', entity: 'clearance_request', entityId: ctx.request.request_id }, conn);
    } else {
      if (stage.stage_key === 'letter') {
        // Name verified on the graduation list: generate the application letter.
        const letter = await createLetter(conn, ctx);
        files.created.push(letter.file_path);
        if (letter.replaced_path) files.replaced.push(letter.replaced_path);
        await notifyStudent(ctx.student.student_id, 'Your name has been verified on the graduation list. Your application letter is ready to download.', conn, `/student/stage/${stage.stage_id}`);
        await logAudit({ actorType: 'system', action: 'letter.generate', entity: 'clearance_request', entityId: ctx.request.request_id }, conn);
      } else {
        await issueStageSlip(conn, ctx, stage, user.sub, files);
        const slip = slipTitle(stage.stage_key);
        await notifyStudent(ctx.student.student_id, `${stage.name} approved.${slip ? ` Your ${slip} is ready to download.` : ''}`, conn, `/student/stage/${stage.stage_id}`);
      }
      await runUnlockCheck(conn, ctx);
    }
    return 'approved';
  });
}

/**
 * Rule 4 (reject) and rule 5 (Audit reject: reopen an earlier stage).
 * documentNotes: [{ document_id, note }] marks those documents rejected.
 */
export async function rejectStage(user, stageId, { comment, documentNotes = [], reopen_stage_key } = {}) {
  const text = typeof comment === 'string' ? comment.trim().slice(0, 2000) : '';
  if (!text) throw httpError(400, 'A comment to the student is required when rejecting');
  if (!Array.isArray(documentNotes)) throw httpError(400, 'documentNotes must be a list');

  return withTransaction(async (conn) => {
    const ctx = await loadContext(conn, await requestIdForStage(conn, stageId), { lock: true });
    const stage = findStage(ctx, stageId);
    assertCanReview(user, ctx, stage);
    if (stage.status !== 'pending') throw httpError(409, 'Only stages waiting for review can be rejected');

    let target = stage;
    if (stage.stage_key === 'audit') {
      if (!reopen_stage_key) throw httpError(400, 'Choose which stage to send back to the student');
      target = ctx.stages.find((s) => s.stage_key === reopen_stage_key && s.stage_key !== 'audit');
      if (!target) throw httpError(400, 'Unknown stage to reopen');
      if (target.status !== 'approved') throw httpError(400, 'Only an approved stage can be reopened');
    }

    for (const { document_id, note } of documentNotes) {
      const doc = ctx.documents.find((d) => d.document_id === Number(document_id));
      if (!doc || doc.stage_id !== target.stage_id) throw httpError(400, `Document ${document_id} is not part of the ${target.name} stage`);
      const n = typeof note === 'string' && note.trim() ? note.trim().slice(0, 255) : 'Rejected by reviewer';
      await conn.query("UPDATE stage_documents SET status = 'rejected', reviewer_note = ? WHERE document_id = ?", [n, doc.document_id]);
      await logAudit({ actorType: 'staff', actorId: user.sub, action: 'document.reject', entity: 'stage_document', entityId: doc.document_id, detail: { stage_id: target.stage_id, note: n } }, conn);
    }

    await conn.query("UPDATE clearance_stages SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), comment = ? WHERE stage_id = ?", [user.sub, text, target.stage_id]);

    if (target !== stage) {
      await conn.query("UPDATE clearance_stages SET status = 'locked', unlocked_at = NULL, submitted_at = NULL WHERE stage_id = ?", [stage.stage_id]);
      await notifyStudent(ctx.student.student_id, `Audit sent your ${target.name} back: "${text}"`, conn, `/student/stage/${target.stage_id}`);
      await logAudit({ actorType: 'staff', actorId: user.sub, action: 'stage.audit_reject', entity: 'clearance_stage', entityId: stage.stage_id, detail: { reopened: target.stage_key, reopened_stage_id: target.stage_id, comment: text, documents: documentNotes.length } }, conn);
    } else {
      await notifyStudent(ctx.student.student_id, `${stage.name} was sent back: "${text}"`, conn, `/student/stage/${stage.stage_id}`);
      await logAudit({ actorType: 'staff', actorId: user.sub, action: 'stage.reject', entity: 'clearance_stage', entityId: stage.stage_id, detail: { stage_key: stage.stage_key, comment: text, documents: documentNotes.length } }, conn);
    }
    return 'rejected';
  });
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

function documentView(doc, { forReviewer }) {
  if (!doc) return null;
  return {
    document_id: doc.document_id,
    status: doc.status,
    reviewer_note: doc.reviewer_note,
    reference_no: doc.reference_no,
    amount: doc.amount,
    document_date: doc.document_date,
    original_name: doc.original_name,
    mime_type: doc.mime_type,
    uploaded_at: doc.uploaded_at,
    ...(forReviewer && { duplicate_flag: Boolean(doc.duplicate_flag), ocr_status: doc.ocr_status, ocr_result: doc.ocr_result }),
  };
}

const paymentView = (p) => ({
  payment_id: p.payment_id,
  purpose: p.purpose,
  description: p.description,
  amount: p.amount,
  currency: p.currency,
  status: p.status,
  raised_by_staff: p.raised_by !== null && p.raised_by !== undefined,
  paid_at: p.paid_at,
});

/** The clearance slip issued for an approved stage (null if none, or if the stage was reopened). */
function slipView(ctx, stage) {
  const slip = stage.status === 'approved' && (ctx.slips || []).find((s) => s.stage_id === stage.stage_id);
  if (!slip) return null;
  return { slip_id: slip.slip_id, slip_no: slip.slip_no, title: slipTitle(stage.stage_key), issued_at: slip.issued_at, issued_by: slip.issued_by_name || null };
}

/** One stage with its computed slots, uploads and payments. */
export function stageView(ctx, stage, { forReviewer = false } = {}) {
  const uploads = new Map(ctx.documents.filter((d) => d.stage_id === stage.stage_id).map((d) => [slotKey(d.required_doc_id, d.level), d]));
  const slots = stage.status === 'locked' ? [] : computeSlots(stageDocsFor(ctx, stage.stage_key), ctx.student, stage.form_data);
  const blockers = EDITABLE.includes(stage.status) ? submissionBlockers(ctx, stage) : [];
  return {
    stage_id: stage.stage_id,
    stage_key: stage.stage_key,
    name: stage.name,
    sequence_order: stage.sequence_order,
    status: stage.status,
    review_mode: stage.review_mode,
    reviewer_role: stage.reviewer_role,
    unlock_rule: stage.unlock_rule,
    fee_amount: stage.fee_amount,
    has_form: hasForm(stage.stage_key),
    form_data: stage.form_data,
    comment: stage.comment,
    unlocked_at: stage.unlocked_at,
    submitted_at: stage.submitted_at,
    reviewed_at: stage.reviewed_at,
    slots: slots.map((s) => ({
      required_doc_id: s.required_doc_id,
      level: s.level,
      name: s.name,
      description: s.description,
      reference_label: s.reference_label,
      collects_amount: Boolean(s.collects_amount),
      collects_date: Boolean(s.collects_date),
      is_required: Boolean(s.is_required),
      check_identity: Boolean(s.check_identity),
      document: documentView(uploads.get(slotKey(s.required_doc_id, s.level)), { forReviewer }),
    })),
    payments: ctx.payments.filter((p) => p.stage_id === stage.stage_id).map(paymentView),
    slip: slipView(ctx, stage),
    can_submit: EDITABLE.includes(stage.status) && blockers.length === 0,
    blockers,
  };
}

/** Everything the student dashboard needs (GET /api/clearance/mine). */
export async function getStudentRequestView(studentId) {
  const [[req]] = await pool.query('SELECT request_id FROM clearance_requests WHERE student_id = ? ORDER BY initiated_at DESC LIMIT 1', [studentId]);
  if (!req) return { request: null };
  const ctx = await loadContext(pool, req.request_id);
  const stages = ctx.stages.map((s) => stageView(ctx, s));

  const actionNeeded = stages
    .filter(
      (s) =>
        s.status === 'rejected' ||
        (s.status === 'pending' && s.slots.some((sl) => sl.document?.status === 'rejected')) ||
        s.payments.some((p) => p.status !== 'success' && p.raised_by_staff)
    )
    .map((s) => ({
      stage_id: s.stage_id,
      stage_key: s.stage_key,
      stage_name: s.name,
      status: s.status,
      comment: s.status === 'rejected' ? s.comment : null,
      rejected_documents: s.slots.filter((sl) => sl.document?.status === 'rejected').map((sl) => ({ name: sl.name, level: sl.level, reviewer_note: sl.document.reviewer_note })),
      unpaid: s.payments.filter((p) => p.status !== 'success').map((p) => ({ payment_id: p.payment_id, purpose: p.purpose, description: p.description, amount: p.amount })),
    }));

  return {
    request: {
      request_id: ctx.request.request_id,
      session: ctx.request.session,
      status: ctx.request.status,
      initiated_at: ctx.request.initiated_at,
      completed_at: ctx.request.completed_at,
      has_letter: Boolean(ctx.request.letter_path),
    },
    progress: { approved: stages.filter((s) => s.status === 'approved').length, total: stages.length },
    action_needed: actionNeeded,
    stages,
  };
}

// Order Audit sees the dossier in (spec section 4, stage 9).
const AUDIT_DOSSIER_ORDER = ['faculty', 'letter', 'security', 'student_affairs', 'convocation', 'library', 'alumni', 'departmental'];

/** Reviewer's view of one stage (GET /api/review/stages/:id). Admin may view any stage read-only. */
export async function getReviewStageView(user, stageId) {
  const ctx = await loadContext(pool, await requestIdForStage(pool, stageId));
  const stage = findStage(ctx, stageId);
  if (user.role !== 'admin') assertCanReview(user, ctx, stage);

  const view = {
    student: {
      student_id: ctx.student.student_id,
      full_name: ctx.student.full_name,
      matric_no: ctx.student.matric_no,
      email: ctx.student.email,
      department: ctx.student.department,
      faculty: ctx.student.faculty,
      levels: `100 to ${ctx.student.levels_count * 100}`,
      accommodation_type: ctx.student.accommodation_type,
    },
    request: { request_id: ctx.request.request_id, session: ctx.request.session, status: ctx.request.status, has_letter: Boolean(ctx.request.letter_path) },
    stage: stageView(ctx, stage, { forReviewer: true }),
    can_review: user.role !== 'admin' && stage.status === 'pending',
  };

  if (stage.stage_key === 'audit') {
    const byKey = new Map(ctx.stages.map((s) => [s.stage_key, s]));
    view.dossier = AUDIT_DOSSIER_ORDER.filter((k) => byKey.has(k)).map((k) => stageView(ctx, byKey.get(k), { forReviewer: true }));
  }
  if (stage.stage_key === 'security') {
    // The earlier offices' slips, issued by the system, replace the paper slips the
    // student used to bring to Security.
    view.earlier_slips = ctx.stages
      .filter((s) => s.sequence_order < stage.sequence_order)
      .map((s) => ({ stage_key: s.stage_key, stage_name: s.name, status: s.status, slip: slipView(ctx, s) }));
  }
  return view;
}
