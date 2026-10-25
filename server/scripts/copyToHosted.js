// Copy the local database and uploaded files to the hosted database (e.g. Aiven),
// so the deployed site starts with the same students, accounts and clearances.
//
//   1. Put the hosted database details in clearance-system/.env.hosted:
//        TARGET_DB_HOST=...  TARGET_DB_PORT=...  TARGET_DB_USER=...  TARGET_DB_PASSWORD=...
//        TARGET_DB_NAME=defaultdb  TARGET_DB_SSL_CA_FILE=ca.pem   (path relative to clearance-system)
//   2. node scripts/copyToHosted.js            refuses if the hosted database already has students
//      node scripts/copyToHosted.js --force    empties the hosted tables first, then copies
//
// Files from server/uploads go into the stored_files table (STORAGE_DRIVER=db on Vercel).
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const { default: env, ROOT_DIR, SERVER_DIR } = await import('../src/config/env.js');
// DATE columns are read as text so they copy unchanged; DATETIMEs are read as exact
// moments and written in UTC, the hosted server's (and Vercel's) time zone.
const { host, port, user, password, database } = env.db;
const source = await mysql.createConnection({ host, port, user, password, database, dateStrings: ['DATE'], charset: 'utf8mb4' });

const hosted = dotenv.parse(fs.readFileSync(path.join(ROOT_DIR, '.env.hosted')));
const force = process.argv.includes('--force');
const need = (k) => {
  if (!hosted[k]) throw new Error(`${k} is missing from .env.hosted`);
  return hosted[k];
};

// Parent tables before the tables that point at them.
const TABLES = [
  'faculties', 'departments', 'students', 'staff', 'workflow_stages', 'required_documents',
  'import_batches', 'clearance_requests', 'clearance_stages', 'stage_documents', 'payments',
  'certificates', 'clearance_slips', 'notifications', 'audit_logs',
];
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };

const dbName = need('TARGET_DB_NAME');
if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error('TARGET_DB_NAME may only contain letters, digits and _');
const target = await mysql.createConnection({
  host: need('TARGET_DB_HOST'),
  port: Number(need('TARGET_DB_PORT')),
  user: need('TARGET_DB_USER'),
  password: need('TARGET_DB_PASSWORD'),
  ssl: { ca: fs.readFileSync(path.resolve(ROOT_DIR, need('TARGET_DB_SSL_CA_FILE'))), rejectUnauthorized: true },
  multipleStatements: true,
  charset: 'utf8mb4',
  timezone: 'Z',
});

// JSON columns come back as objects; send them back as JSON text.
const cell = (v) => (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) ? JSON.stringify(v) : v);

try {
  console.log(`Creating tables in ${dbName}...`);
  const schema = fs.readFileSync(path.join(SERVER_DIR, 'src', 'db', 'schema.sql'), 'utf8').replaceAll('clearance_db', dbName);
  await target.query(schema);

  const [[{ n }]] = await target.query('SELECT COUNT(*) AS n FROM students');
  if (n > 0 && !force) throw new Error(`The hosted database already has ${n} students. Run with --force to replace everything in it.`);

  await target.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [...TABLES, 'stored_files', 'password_resets']) await target.query(`DELETE FROM \`${t}\``);

  for (const t of TABLES) {
    const [rows] = await source.query(`SELECT * FROM \`${t}\``);
    if (rows.length) {
      const cols = Object.keys(rows[0]);
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200).map((r) => cols.map((c) => cell(r[c])));
        await target.query(`INSERT INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES ?`, [batch]);
      }
    }
    console.log(`  ${t}: ${rows.length}`);
  }
  await target.query('SET FOREIGN_KEY_CHECKS = 1');

  let files = 0;
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const abs of walk(env.uploads.dir)) {
    const mime = MIME[path.extname(abs).toLowerCase()];
    if (!mime) continue;
    const rel = path.relative(env.uploads.dir, abs).split(path.sep).join('/');
    const data = fs.readFileSync(abs);
    await target.query('INSERT INTO stored_files (path, mime_type, size, content) VALUES (?, ?, ?, ?)', [rel, mime, data.length, data]);
    files++;
  }
  console.log(`  files: ${files}`);
  console.log('Done. The hosted database now matches your local one.');
} finally {
  await target.end();
  await source.end();
}
