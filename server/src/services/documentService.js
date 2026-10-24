// Student document uploads and authenticated file access (build step 5).
import pool, { withTransaction } from '../config/db.js';
import httpError from '../utils/httpError.js';
import { inScope } from '../middleware/requireRole.js';
import { logAudit } from './auditLog.js';
import { notifyReviewers } from './notificationService.js';
import { initialOcrStatus, queueOcr } from './ocrService.js';
import {
  EDITABLE, loadContext, requestIdForStage, findStage, assertOwner, stageDocsFor,
  computeSlots, slotKey, slotLabel, deleteFiles, uploadPath,
} from './workflowEngine.js';

const MAX_AMOUNT = 10_000_000;

/** Validate the typed fields that go with an upload, as the slot requires. */
export function validateDocumentFields(slot, fields) {
  const out = { reference_no: null, amount: null, document_date: null };

  const ref = String(fields.reference_no ?? '').replace(/\s+/g, ' ').trim();
  if (slot.reference_label) {
    if (!ref) throw httpError(400, `Enter the ${slot.reference_label.replace(/\.$/, '').toLowerCase()}`);
    if (ref.length > 60) throw httpError(400, `${slot.reference_label} is too long`);
    out.reference_no = ref;
  }

  if (slot.collects_amount) {
    const raw = String(fields.amount ?? '').replace(/[,\s₦]/g, '');
    const amount = Number(raw);
    if (!raw || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw httpError(400, 'Enter the amount on the document');
    out.amount = Math.round(amount * 100) / 100;
  }

  if (slot.collects_date) {
    const raw = String(fields.document_date ?? '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const date = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!date || date.getUTCMonth() !== +m[2] - 1 || date.getUTCDate() !== +m[3]) throw httpError(400, 'Enter the date on the document (YYYY-MM-DD)');
    if (date > new Date()) throw httpError(400, 'The document date cannot be in the future');
    if (+m[1] < 1990) throw httpError(400, 'The document date is too far in the past');
    out.document_date = raw;
  }
  return out;
}

/**
 * Save (or replace) the upload for one slot. The file is already on disk
 * (file = { relativePath, originalname, mimetype }); on any failure the caller
 * deletes it. Rule 11: a reference number already used by another student for
 * the same document type flags both documents for the reviewers.
 */
export async function saveUpload(studentId, stageId, file, fields) {
  const requiredDocId = Number(fields.required_doc_id);
  const level = fields.level === undefined || fields.level === '' ? 0 : Number(fields.level);
  if (!Number.isInteger(requiredDocId) || !Number.isInteger(level)) throw httpError(400, 'required_doc_id and level must be numbers');

  let replacedPath = null;
  const result = await withTransaction(async (conn) => {
    const ctx = await loadContext(conn, await requestIdForStage(conn, stageId), { lock: true });
    assertOwner(ctx, studentId);
    const stage = findStage(ctx, stageId);

    const slot = computeSlots(stageDocsFor(ctx, stage.stage_key), ctx.student, stage.form_data)
      .find((s) => s.required_doc_id === requiredDocId && s.level === level);
    if (!slot) throw httpError(400, 'This document is not required for this stage');

    const existing = ctx.documents.find((d) => d.stage_id === stageId && slotKey(d.required_doc_id, d.level) === slotKey(requiredDocId, level));
    // While the office is reviewing, only a document it has rejected can be replaced; the
    // replacement goes straight back to the office without waiting for the whole stage.
    const replacingRejectedDuringReview = stage.status === 'pending' && existing?.status === 'rejected';
    if (!EDITABLE.includes(stage.status) && !replacingRejectedDuringReview) {
      throw httpError(409, stage.status === 'pending' ? 'Your documents are with the office for review. You can only replace a document they reject.' : 'Uploads are closed for this stage right now');
    }
    // Accepted documents are locked; anything else (rejected, or a replacement not yet reviewed) can be replaced.
    if (existing?.status === 'accepted') throw httpError(409, `${slotLabel(slot)} has already been accepted and cannot be replaced`);

    const values = validateDocumentFields(slot, fields);

    let duplicate = false;
    if (values.reference_no) {
      const [others] = await conn.query(
        `SELECT sd.document_id
           FROM stage_documents sd
           JOIN clearance_stages cs ON cs.stage_id = sd.stage_id
           JOIN clearance_requests cr ON cr.request_id = cs.request_id
          WHERE sd.required_doc_id = ? AND sd.reference_no = ? AND cr.student_id <> ?`,
        [requiredDocId, values.reference_no, studentId]
      );
      duplicate = others.length > 0;
      if (duplicate) {
        await conn.query(`UPDATE stage_documents SET duplicate_flag = TRUE WHERE document_id IN (${others.map(() => '?').join(',')})`, others.map((o) => o.document_id));
      }
    }

    const ocrStatus = initialOcrStatus(slot.check_identity, file.mimetype);
    const row = [file.relativePath, file.originalname.slice(0, 255), file.mimetype, values.reference_no, values.amount, values.document_date, duplicate, ocrStatus];
    let documentId;
    if (existing) {
      replacedPath = existing.file_path;
      await conn.query(
        `UPDATE stage_documents
            SET file_path = ?, original_name = ?, mime_type = ?, reference_no = ?, amount = ?, document_date = ?,
                duplicate_flag = ?, ocr_status = ?, ocr_result = NULL, status = 'pending', reviewer_note = NULL, uploaded_at = NOW()
          WHERE document_id = ?`,
        [...row, existing.document_id]
      );
      documentId = existing.document_id;
    } else {
      const [res] = await conn.query(
        `INSERT INTO stage_documents
           (stage_id, required_doc_id, level, file_path, original_name, mime_type, reference_no, amount, document_date, duplicate_flag, ocr_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stageId, requiredDocId, level, ...row]
      );
      documentId = res.insertId;
    }

    // Read the photo for the name/reg-number check once the upload is saved.
    if (ocrStatus === 'pending') conn.afterCommit(() => queueOcr(documentId));

    if (replacingRejectedDuringReview) {
      await notifyReviewers(stage.reviewer_role, ctx.student, `${ctx.student.full_name} (${ctx.student.matric_no}) replaced a rejected document: ${slotLabel(slot)}, ${stage.name}`, conn, `/staff/review/${stage.stage_id}`);
    }

    await logAudit({
      actorType: 'student', actorId: studentId,
      action: existing ? 'document.replace' : 'document.upload',
      entity: 'stage_document', entityId: documentId,
      detail: { stage_key: stage.stage_key, slot: slotLabel(slot), reference_no: values.reference_no, duplicate },
    }, conn);
    return { document_id: documentId, duplicate_flag: duplicate };
  });

  if (replacedPath) await deleteFiles([replacedPath]);
  return result;
}

/** Remove an upload while the stage is still editable and the document not accepted. */
export async function deleteUpload(studentId, documentId) {
  let filePath;
  await withTransaction(async (conn) => {
    const [[doc]] = await conn.query('SELECT document_id, stage_id, status, file_path FROM stage_documents WHERE document_id = ?', [documentId]);
    if (!doc) throw httpError(404, 'Document not found');
    const ctx = await loadContext(conn, await requestIdForStage(conn, doc.stage_id), { lock: true });
    assertOwner(ctx, studentId);
    const stage = findStage(ctx, doc.stage_id);
    if (!EDITABLE.includes(stage.status)) throw httpError(409, 'This stage has been submitted; its documents cannot be removed');
    if (doc.status === 'accepted') throw httpError(409, 'Accepted documents cannot be removed');

    await conn.query('DELETE FROM stage_documents WHERE document_id = ?', [documentId]);
    await logAudit({ actorType: 'student', actorId: studentId, action: 'document.delete', entity: 'stage_document', entityId: documentId, detail: { stage_key: stage.stage_key } }, conn);
    filePath = doc.file_path;
  });
  await deleteFiles([filePath]);
}

/**
 * Who may open a document file: the student who owns it; the admin; the
 * reviewer office for that stage (with scope); and Audit, which reviews the
 * whole dossier.
 */
export async function getDocumentFile(user, documentId) {
  const [[doc]] = await pool.query(
    `SELECT sd.file_path, sd.mime_type, sd.original_name, cs.stage_key, ws.reviewer_role,
            cr.student_id, s.department_id, d.faculty_id
       FROM stage_documents sd
       JOIN clearance_stages cs ON cs.stage_id = sd.stage_id
       JOIN workflow_stages ws ON ws.stage_key = cs.stage_key
       JOIN clearance_requests cr ON cr.request_id = cs.request_id
       JOIN students s ON s.student_id = cr.student_id
       JOIN departments d ON d.department_id = s.department_id
      WHERE sd.document_id = ?`,
    [documentId]
  );
  // Same 404 whether the document is missing or not yours, so ids cannot be probed.
  if (!doc) throw httpError(404, 'Document not found');

  const student = { student_id: doc.student_id, department_id: doc.department_id, faculty_id: doc.faculty_id };
  const allowed =
    (user.role === 'student' && user.sub === doc.student_id) ||
    user.role === 'admin' ||
    user.role === 'audit' ||
    (user.userType === 'staff' && user.role === doc.reviewer_role && inScope(user, student));
  if (!allowed) throw httpError(404, 'Document not found');

  return { absPath: uploadPath(doc.file_path), mimeType: doc.mime_type, originalName: doc.original_name };
}
