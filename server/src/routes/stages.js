import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireStudent } from '../middleware/requireRole.js';
import { saveForm, submitStage, getStudentRequestView } from '../services/workflowEngine.js';
import { intParam } from '../utils/httpError.js';

const router = Router();
router.use(requireAuth, requireStudent);

// PUT /api/stages/:stageId/form  body = the stage's form fields
router.put('/:stageId/form', async (req, res) => {
  await saveForm(req.user.sub, intParam(req.params.stageId), req.body);
  res.json(await getStudentRequestView(req.user.sub));
});

// POST /api/stages/:stageId/submit
router.post('/:stageId/submit', async (req, res) => {
  await submitStage(req.user.sub, intParam(req.params.stageId));
  res.json(await getStudentRequestView(req.user.sub));
});

export default router;
