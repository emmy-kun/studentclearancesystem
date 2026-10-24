import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireStudent } from '../middleware/requireRole.js';
import { uploadDocument } from '../middleware/upload.js';
import { saveUpload, deleteUpload, getDocumentFile } from '../services/documentService.js';
import { getStudentRequestView } from '../services/workflowEngine.js';
import { intParam } from '../utils/httpError.js';
import { deleteFile, sendStoredFile } from '../services/storage.js';

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
    await deleteFile(req.file.relativePath);
    throw err;
  }
});

router.delete('/documents/:id', requireAuth, requireStudent, async (req, res) => {
  await deleteUpload(req.user.sub, intParam(req.params.id));
  res.json(await getStudentRequestView(req.user.sub));
});

router.get('/files/:documentId', requireAuth, async (req, res) => {
  const file = await getDocumentFile(req.user, intParam(req.params.documentId));
  const safeName = (file.originalName || 'document').replace(/[^\w.\- ]+/g, '_');
  await sendStoredFile(res, file.relativePath, { contentType: file.mimeType, disposition: `inline; filename="${safeName}"` });
});

export default router;
