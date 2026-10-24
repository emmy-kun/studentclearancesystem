import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { lookup, recordCollection, listCollections } from '../services/registryService.js';
import { intParam } from '../utils/httpError.js';

// Mounted at /api/registry. Registry officers (the Admin may look, not record).
const router = Router();
router.use(requireAuth);

// GET /api/registry/lookup?q=<certificate no | reg no | QR code or address>
router.get('/lookup', requireRole('registry', 'admin'), async (req, res) => {
  res.json(await lookup(req.query.q));
});

// POST /api/registry/certificates/:id/issue  { identity_checked: true, serial_no?, note? }
router.post('/certificates/:id/issue', requireRole('registry'), async (req, res) => {
  res.json({ certificate: await recordCollection(req.user, intParam(req.params.id), req.body) });
});

// GET /api/registry/collected
router.get('/collected', requireRole('registry', 'admin'), async (req, res) => {
  res.json({ items: await listCollections(req.query) });
});

export default router;
