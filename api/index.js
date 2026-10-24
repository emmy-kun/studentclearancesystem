// Vercel entry point: every /api/* request is handled by the same Express app that
// runs locally (vercel.json rewrites /api/* here). Settings come from Vercel's
// Environment Variables instead of .env.
import app from '../server/src/app.js';

export default app;
