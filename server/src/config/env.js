import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env lives at the project root (clearance-system/.env)
export const ROOT_DIR = path.resolve(__dirname, '../../..');
export const SERVER_DIR = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

// Tests use their own database and upload folder so they never touch real data.
// node --test sets NODE_TEST_CONTEXT; scripts/setupTestDb.js sets USE_TEST_DB.
const testing = Boolean(process.env.NODE_TEST_CONTEXT) || process.env.USE_TEST_DB === '1';

const env = {
  testing,
  currentSession: required('CURRENT_SESSION', '2025/2026'),
  port: Number(process.env.PORT || 4000),
  appBaseUrl: required('APP_BASE_URL', 'http://localhost:5173'),

  db: {
    host: required('DB_HOST', 'localhost'),
    port: Number(process.env.DB_PORT || 3306),
    user: required('DB_USER', 'root'),
    password: process.env.DB_PASSWORD ?? '',
    database: required('DB_NAME', 'clearance_db') + (testing ? '_test' : ''),
    // Hosted MySQL (e.g. Aiven) needs TLS: DB_SSL_CA holds the provider's CA certificate (PEM text).
    sslCa: (process.env.DB_SSL_CA || '').replace(/\\n/g, '\n').trim(),
    poolSize: Number(process.env.DB_POOL_SIZE || 10),
  },

  jwt: {
    secret: process.env.JWT_SECRET || '',
    expiresIn: process.env.JWT_EXPIRES_IN || '4h',
  },

  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
  },

  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@clearance.test',
    password: process.env.ADMIN_PASSWORD || '',
  },

  // Automatic name/reg-number check on uploaded photos. Off in tests (slow, downloads language data).
  ocr: {
    enabled: process.env.OCR_ENABLED !== 'false' && !testing,
    cacheDir: path.join(SERVER_DIR, '.ocr-cache'),
  },

  uploads: {
    dir: path.join(SERVER_DIR, testing ? 'uploads-test' : 'uploads'),
    // 'disk' (server/uploads) or 'db' (stored_files table; used on Vercel). Tests always use disk.
    driver: testing ? 'disk' : process.env.STORAGE_DRIVER || 'disk',
    maxBytes: Number(process.env.UPLOAD_MAX_MB || 5) * 1024 * 1024,
  },

  email: {
    // Never send real email while the test runner is active (node --test sets NODE_TEST_CONTEXT);
    // the notification tests switch it on themselves with a fake transport.
    enabled: process.env.EMAIL_ENABLED === 'true' && !process.env.NODE_TEST_CONTEXT,
    provider: process.env.EMAIL_PROVIDER || 'emailjs',
    emailjs: {
      serviceId: process.env.EMAILJS_SERVICE_ID || '',
      templateId: process.env.EMAILJS_TEMPLATE_ID || '',
      publicKey: process.env.EMAILJS_PUBLIC_KEY || '',
      privateKey: process.env.EMAILJS_PRIVATE_KEY || '',
    },
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'Student Clearance <no-reply@clearance.test>',
  },
};

export default env;
