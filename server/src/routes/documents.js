import fs from 'node:fs';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireStudent } from '../middleware/requireRole.js';
import { uploadDocument } from '../middleware/upload.js';
import { saveUpload, deleteUpload, getDocumentFile } from '../services/documentService.js';
import { getStudentRequestView } from '../services/workflowEngine.js';
import httpError, { intParam } from '../utils/httpError.js';

// Mounted at /api so the paths match the spec:
//   POST   /api/stages/:stageId/documents   multipart: file, required_doc_id, level, reference_no, amount, document_date
//   DELETE /api/documents/:id
//   GET    /api/files/:documentId
const router = Router();

router.post('/stages/:stageId/documents', requireAuth, requireStudent, uploadDocument, async (req, res) => {
  try {
    const result = await saveUpload(req.user.sub, intParam(req.params.stageId), req.file, req.body);
    res.status(201).json({ ...result, clearance: await getStudentRequestView(req.user.sub) });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    throw err;
  }
});

router.delete('/documents/:id', requireAuth, requireStudent, async (req, res) => {
  await deleteUpload(req.user.sub, intParam(req.params.id));
  res.json(await getStudentRequestView(req.user.sub));
});

router.get('/files/:documentId', requireAuth, async (req, res) => {
  const file = await getDocumentFile(req.user, intParam(req.params.documentId));
  if (!fs.existsSync(file.absPath)) throw httpError(404, 'File is missing from storage');
  const safeName = (file.originalName || 'document').replace(/[^\w.\- ]+/g, '_');
  res.set({
    'Content-Type': file.mimeType,
    'Content-Disposition': `inline; filename="${safeName}"`,
    'Cache-Control': 'private, no-store',
  });
  res.sendFile(file.absPath);
});

export default router;
