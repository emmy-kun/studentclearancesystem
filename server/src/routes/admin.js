import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireRole.js';
import * as admin from '../services/adminService.js';
import { streamClearanceReport } from '../services/reportService.js';
import { importStudents } from '../db/importStudents.js';
import httpError, { intParam } from '../utils/httpError.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (/\.csv$/i.test(file.originalname) ? cb(null, true) : cb(httpError(400, 'Upload a .csv file'))),
}).single('file');

// Dashboard, requests, report
router.get('/dashboard', async (req, res) => res.json(await admin.dashboard()));
router.get('/requests', async (req, res) => res.json(await admin.listRequests(req.query)));
router.get('/reports/clearance.pdf', async (req, res) => streamClearanceReport(res));

// Students
router.get('/students', async (req, res) => res.json(await admin.listStudents(req.query)));
router.post('/students/import', (req, res, next) => csvUpload(req, res, (err) => (err ? next(err.status ? err : httpError(400, err.message)) : next())), async (req, res) => {
  if (!req.file) throw httpError(400, 'Choose a CSV file');
  res.status(201).json(await importStudents(req.file.buffer.toString('utf8'), { importedBy: req.user.sub, filename: req.file.originalname }));
});
router.patch('/students/:id', async (req, res) => {
  await admin.updateStudent(req.user.sub, intParam(req.params.id), req.body || {});
  res.json({ ok: true });
});
router.post('/students/:id/reset-account', async (req, res) => {
  await admin.resetStudentAccount(req.user.sub, intParam(req.params.id));
  res.json({ ok: true });
});

// Staff (no delete: deactivate instead, so past decisions keep their reviewer)
router.get('/staff', async (req, res) => res.json({ items: await admin.listStaff() }));
router.post('/staff', async (req, res) => res.status(201).json(await admin.createStaff(req.user.sub, req.body || {})));
router.patch('/staff/:id', async (req, res) => {
  await admin.updateStaff(req.user.sub, intParam(req.params.id), req.body || {});
  res.json({ ok: true });
});
router.post('/staff/:id/reset-password', async (req, res) => res.json(await admin.resetStaffPassword(req.user.sub, intParam(req.params.id))));

// Faculties and departments
router.get('/faculties', async (req, res) => res.json({ items: await admin.listStructure() }));
router.post('/faculties', async (req, res) => res.status(201).json(await admin.saveFaculty(req.user.sub, null, req.body || {})));
router.patch('/faculties/:id', async (req, res) => res.json(await admin.saveFaculty(req.user.sub, intParam(req.params.id), req.body || {})));
router.post('/departments', async (req, res) => res.status(201).json(await admin.saveDepartment(req.user.sub, null, req.body || {})));
router.patch('/departments/:id', async (req, res) => res.json(await admin.saveDepartment(req.user.sub, intParam(req.params.id), req.body || {})));
router.delete('/departments/:id', async (req, res) => {
  await admin.deleteDepartment(req.user.sub, intParam(req.params.id));
  res.json({ ok: true });
});

// Required documents
router.get('/required-documents', async (req, res) => res.json({ stages: await admin.listRequiredDocuments() }));
router.post('/required-documents', async (req, res) => res.status(201).json(await admin.saveRequiredDocument(req.user.sub, null, req.body || {})));
router.patch('/required-documents/:id', async (req, res) => res.json(await admin.saveRequiredDocument(req.user.sub, intParam(req.params.id), req.body || {})));
router.delete('/required-documents/:id', async (req, res) => {
  await admin.deleteRequiredDocument(req.user.sub, intParam(req.params.id));
  res.json({ ok: true });
});

// Audit log
router.get('/audit-logs', async (req, res) => res.json(await admin.listAuditLogs(req.query)));

export default router;
