import rateLimit from 'express-rate-limit';

// Login attempts per IP per 15 minutes. LOGIN_RATE_LIMIT can raise it for testing.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT || 10),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' },
});

// Forgot-password requests per IP per 15 minutes.
export const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RESET_RATE_LIMIT || 5),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Please wait a few minutes and try again.' },
});

// Reg-number lookups (name preview on the login page) per IP per 15 minutes.
// Generous for real typing, but stops anyone walking the whole class list.
export const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOOKUP_RATE_LIMIT || 60),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many lookups. Please wait a few minutes and try again.' },
});
