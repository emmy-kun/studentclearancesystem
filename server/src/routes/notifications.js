import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listNotifications, markRead, markAllRead } from '../services/notificationService.js';
import { intParam } from '../utils/httpError.js';

// Students and staff each see only their own notifications.
const router = Router();
router.use(requireAuth);

// GET /api/notifications?unread=1&limit=50&before=<id>  -> { items, unread_count }
router.get('/', async (req, res) => {
  res.json(await listNotifications(req.user, { unreadOnly: req.query.unread === '1', limit: req.query.limit, before: req.query.before }));
});

// PATCH /api/notifications/read-all
router.patch('/read-all', async (req, res) => {
  res.json({ updated: await markAllRead(req.user) });
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  await markRead(req.user, intParam(req.params.id));
  res.json({ ok: true });
});

export default router;
