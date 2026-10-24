// Builds the separate test database (<DB_NAME>_test) so the test suite never
// touches real data: schema, seed data and the class list.
//
//   node scripts/setupTestDb.js              rebuild from scratch
//   node scripts/setupTestDb.js --if-missing only if it does not exist yet (used by `npm test`)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

process.env.USE_TEST_DB = '1';
const { default: env, ROOT_DIR } = await import('../src/config/env.js');

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const classList = path.join(ROOT_DIR, 'data', 'class-list.csv');

async function alreadyBuilt() {
  const conn = await mysql.createConnection({ host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password });
  try {
    const [[db]] = await conn.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [env.db.database]);
    if (!db) return false;
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${env.db.database}\`.students`);
    return n > 0;
  } catch {
    return false;
  } finally {
    await conn.end();
  }
}

function run(script, args = []) {
  const res = spawnSync(process.execPath, [script, ...args], { cwd: serverDir, env: { ...process.env, USE_TEST_DB: '1' }, encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(res.stdout, res.stderr);
    throw new Error(`${script} failed`);
  }
}

if (process.argv.includes('--if-missing') && (await alreadyBuilt())) process.exit(0);

if (!fs.existsSync(classList)) {
  console.error(`The tests need the class list at ${classList}`);
  process.exit(1);
}
console.log(`Building test database ${env.db.database}...`);
run('src/db/migrate.js', ['--reset']);
run('src/db/seed.js');
run('src/db/importStudents.js', [classList]);
run('src/db/seed.js'); // officers for departments added by the import
console.log('Test database ready.');
