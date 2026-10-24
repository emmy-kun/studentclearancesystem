import { Router } from 'express';
import pool from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireReviewer, REVIEWER_ROLES } from '../middleware/requireRole.js';
import { approveStage, rejectStage, reviewDocument, getReviewStageView } from '../services/workflowEngine.js';
import { intParam } from '../utils/httpError.js';

const router = Router();
router.use(requireAuth, requireRole(...REVIEWER_ROLES, 'admin'));

/**
 * Scope filter for queue/history queries (spec section 7), built from the
 * server-side user, never from client input. Returns [sql, params].
 */
function scopeFilter(user) {
  switch (user.role) {
    case 'admin':
      return ['TRUE', []];
    case 'departmental':
      return ['ws.reviewer_role = ? AND s.department_id = ?', [user.role, user.department_id]];
    case 'faculty':
      return ['ws.reviewer_role = ? AND d.faculty_id = ?', [user.role, user.faculty_id]];
    default:
      return ['ws.reviewer_role = ?', [user.role]];
  }
}

const LIST_SELECT = `
  SELECT cs.stage_id, cs.stage_key, ws.name AS stage_name, cs.status, cs.submitted_at, cs.reviewed_at,
         cr.request_id, s.student_id, s.full_name, s.matric_no, d.name AS department,
         (SELECT COUNT(*) FROM stage_documents sd WHERE sd.stage_id = cs.stage_id) AS documents,
         (SELECT COUNT(*) FROM stage_documents sd WHERE sd.stage_id = cs.stage_id AND sd.duplicate_flag) AS duplicates
    FROM clearance_stages cs
    JOIN workflow_stages ws ON ws.stage_key = cs.stage_key
    JOIN clearance_requests cr ON cr.request_id = cs.request_id
    JOIN students s ON s.student_id = cr.student_id
    JOIN departments d ON d.department_id = s.department_id`;

// GET /api/review/queue?search=  pending stages for this reviewer (admin: all, read-only)
router.get('/queue', async (req, res) => {
  const [scope, params] = scopeFilter(req.user);
  const search = String(req.query.search || '').trim();
  const searchSql = search ? ' AND (s.full_name LIKE ? OR s.matric_no LIKE ?)' : '';
  const searchParams = search ? [`%${search}%`, `%${search}%`] : [];
  const [rows] = await pool.query(
    `${LIST_SELECT} WHERE cs.status = 'pending' AND ${scope}${searchSql} ORDER BY cs.submitted_at, cs.stage_id LIMIT 500`,
    [...params, ...searchParams]
  );
  res.json({ items: rows.map((r) => ({ ...r, duplicates: Number(r.duplicates), documents: Number(r.documents) })) });
});

// GET /api/review/history  stages this staff member decided ("Reviewed by me")
router.get('/history', requireReviewer, async (req, res) => {
  const [rows] = await pool.query(
    `${LIST_SELECT} WHERE cs.reviewed_by = ? ORDER BY cs.reviewed_at DESC LIMIT 200`,
    [req.user.sub]
  );
  res.json({ items: rows });
});

// GET /api/review/stages/:stageId  student info, slots + documents, payments (Audit: full dossier)
router.get('/stages/:stageId', async (req, res) => {
  res.json(await getReviewStageView(req.user, intParam(req.params.stageId)));
});

// PATCH /api/review/documents/:documentId { status: 'accepted'|'rejected', reviewer_note }
router.patch('/documents/:documentId', requireReviewer, async (req, res) => {
  res.json(await reviewDocument(req.user, intParam(req.params.documentId), req.body || {}));
});

// POST /api/review/stages/:stageId/approve { comment? }
router.post('/stages/:stageId/approve', requireReviewer, async (req, res) => {
  const stageId = intParam(req.params.stageId);
  await approveStage(req.user, stageId, req.body || {});
  res.json(await getReviewStageView(req.user, stageId));
});

// POST /api/review/stages/:stageId/reject { comment, documentNotes: [{document_id, note}], reopen_stage_key? }
router.post('/stages/:stageId/reject', requireReviewer, async (req, res) => {
  const stageId = intParam(req.params.stageId);
  await rejectStage(req.user, stageId, req.body || {});
  res.json(await getReviewStageView(req.user, stageId));
});

export default router;
