import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireStudent } from '../middleware/requireRole.js';
import { startRequest, getStudentRequestView } from '../services/workflowEngine.js';

const router = Router();
router.use(requireAuth, requireStudent);

// POST /api/clearance: start this session's clearance (creates stages, unlocks stage 1 + convocation)
router.post('/', async (req, res) => {
  await startRequest(req.user.sub);
  res.status(201).json(await getStudentRequestView(req.user.sub));
});

// GET /api/clearance/mine: full request with stages, slots, uploads, payments, statuses
router.get('/mine', async (req, res) => {
  res.json(await getStudentRequestView(req.user.sub));
});

export default router;
