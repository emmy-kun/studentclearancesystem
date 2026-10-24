// Creates the database and tables from schema.sql.
//   npm run db:migrate   create anything missing
//   npm run db:reset     DROP the database first (destroys all data)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import env from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reset = process.argv.includes('--reset');

async function main() {
  const dbName = env.db.database;
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`Invalid DB_NAME "${dbName}"`);

  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: true,
  });

  try {
    if (reset) {
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      console.log(`Dropped database ${dbName}`);
    }
    const sql = (await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8'))
      .replaceAll('clearance_db', dbName);
    await conn.query(sql);
    console.log(`Schema applied to ${dbName}`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
