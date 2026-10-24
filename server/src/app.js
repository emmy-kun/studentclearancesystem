import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import env from './config/env.js';
import pool from './config/db.js';
import { authenticate } from './middleware/auth.js';
import authRoutes, { getProfile } from './routes/auth.js';
import clearanceRoutes from './routes/clearance.js';
import stageRoutes from './routes/stages.js';
import reviewRoutes from './routes/review.js';
import documentRoutes from './routes/documents.js';
import paymentRoutes, { webhookRouter } from './routes/payments.js';
import certificateRoutes from './routes/certificates.js';
import notificationRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import registryRoutes from './routes/registry.js';

const app = express();

// On Vercel the app sits behind Vercel's proxy: take the visitor's IP from it (for rate limits).
if (process.env.VERCEL) app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: env.appBaseUrl, credentials: true }));
// The Paystack webhook needs the raw body for its signature, so it is mounted before the JSON parser.
app.use('/api/payments/webhook', webhookRouter);
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api', documentRoutes);
app.use('/api', paymentRoutes);
app.use('/api', certificateRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/registry', registryRoutes);
app.use('/api/clearance', clearanceRoutes);
app.use('/api/stages', stageRoutes);
app.use('/api/review', reviewRoutes);

// /api/me is reachable before a forced password change, so the UI can show that screen.
app.get('/api/me', authenticate({ allowPendingPasswordChange: true }), async (req, res) => {
  res.json({ user: await getProfile(req.user) });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (!err.expose) console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Internal server error', ...err.extra });
});

export default app;
