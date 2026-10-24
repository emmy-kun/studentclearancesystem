import fs from 'node:fs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { requireStudent, requireRole } from '../middleware/requireRole.js';
import { verifyCertificate, verifyCertificateByNumber, getMyCertificate, getCertificateFile, getLetterFile } from '../services/certificateService.js';
import { uploadPath } from '../services/workflowEngine.js';
import { getSlipFile } from '../services/slipService.js';
import httpError, { intParam } from '../utils/httpError.js';

// Mounted at /api.
const router = Router();

function sendPdf(res, { relativePath, filename }, disposition = 'attachment') {
  const abs = uploadPath(relativePath);
  if (!fs.existsSync(abs)) throw httpError(404, 'File is missing from storage');
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${disposition}; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`,
    'Cache-Control': 'private, no-store',
  });
  res.sendFile(abs);
}

// GET /api/letter/:requestId/download  (student, Audit, Admin)
router.get('/letter/:requestId/download', requireAuth, requireRole('student', 'audit', 'admin'), async (req, res) => {
  sendPdf(res, await getLetterFile(req.user, intParam(req.params.requestId)), req.query.inline ? 'inline' : 'attachment');
});

// GET /api/certificate/mine
router.get('/certificate/mine', requireAuth, requireStudent, async (req, res) => {
  res.json({ certificate: await getMyCertificate(req.user.sub) });
});

// GET /api/certificate/:id/download  (student, Audit, Registry, Admin)
router.get('/certificate/:id/download', requireAuth, requireRole('student', 'audit', 'registry', 'admin'), async (req, res) => {
  sendPdf(res, await getCertificateFile(req.user, intParam(req.params.id)), req.query.inline ? 'inline' : 'attachment');
});

// GET /api/slips/:id/download  (student, the issuing office, Security, Audit, Admin)
router.get('/slips/:id/download', requireAuth, async (req, res) => {
  sendPdf(res, await getSlipFile(req.user, intParam(req.params.id)), req.query.inline ? 'inline' : 'attachment');
});

// GET /api/verify/:code  (public, no login; rate-limited). Certificates and clearance slips.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.VERIFY_RATE_LIMIT || 60),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many verification requests. Please wait a few minutes.' },
});
// GET /api/verify?certificate_no=&matric_no=  (public; certificate number + reg number)
router.get('/verify', verifyLimiter, async (req, res) => {
  res.json(await verifyCertificateByNumber(req.query.certificate_no, req.query.matric_no));
});
router.get('/verify/:code', verifyLimiter, async (req, res) => {
  res.json(await verifyCertificate(req.params.code));
});

export default router;
