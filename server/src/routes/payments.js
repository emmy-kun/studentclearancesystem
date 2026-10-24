import express, { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireStudent, requireRole, requireReviewer } from '../middleware/requireRole.js';
import { initializePayment, verifyByReference, handleWebhook, raiseCharge, cancelCharge } from '../services/paymentService.js';
import { getStudentRequestView } from '../services/workflowEngine.js';
import { intParam } from '../utils/httpError.js';

// Webhook router: mounted in app.js BEFORE express.json(), because the
// signature is computed over the exact raw bytes Paystack sent.
export const webhookRouter = Router();

webhookRouter.post('/paystack', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const result = await handleWebhook(req.body, req.get('x-paystack-signature'));
  if (!result.accepted) return res.status(401).json({ error: 'Invalid signature' });
  res.json({ received: true });
});

// Mounted at /api.
const router = Router();

// POST /api/payments/:id/initialize -> { authorization_url, reference }
router.post('/payments/:id/initialize', requireAuth, requireStudent, async (req, res) => {
  res.json(await initializePayment(req.user.sub, intParam(req.params.id)));
});

// GET /api/payments/verify?reference=  (payment callback page)
router.get('/payments/verify', requireAuth, requireRole('student', 'admin'), async (req, res) => {
  const payment = await verifyByReference(req.user, req.query.reference);
  const clearance = req.user.role === 'student' ? await getStudentRequestView(req.user.sub) : undefined;
  res.json({ payment, clearance });
});

// POST /api/stages/:stageId/charges { amount, description, purpose: 'fine'|'library_fee' }
router.post('/stages/:stageId/charges', requireAuth, requireReviewer, async (req, res) => {
  res.status(201).json(await raiseCharge(req.user, intParam(req.params.stageId), req.body || {}));
});

// DELETE /api/payments/:id  (withdraw an unpaid staff-raised charge)
router.delete('/payments/:id', requireAuth, requireReviewer, async (req, res) => {
  await cancelCharge(req.user, intParam(req.params.id));
  res.json({ ok: true });
});

export default router;
