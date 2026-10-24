import env from './config/env.js';
import app from './app.js';
import pool from './config/db.js';
import { recheckRequest } from './services/workflowEngine.js';

if (!env.jwt.secret) {
  console.error('JWT_SECRET is not set in .env');
  process.exit(1);
}

/**
 * Stages unlock when something happens (an approval, a payment). If the stage
 * rules themselves change, clearances already in progress would never be
 * re-checked, so do it once at start-up.
 */
async function recheckOpenClearances() {
  const [requests] = await pool.query("SELECT request_id FROM clearance_requests WHERE status = 'in_progress'");
  let opened = 0;
  for (const { request_id } of requests) opened += (await recheckRequest(request_id)).length;
  if (opened) console.log(`Unlock check: opened ${opened} stage(s) across ${requests.length} clearance(s)`);
}

app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
  recheckOpenClearances().catch((err) => console.error('Start-up unlock check failed:', err.message));
});
