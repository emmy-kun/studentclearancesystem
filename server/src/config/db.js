import mysql from 'mysql2/promise';
import env from './env.js';

const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  connectionLimit: 10,
  charset: 'utf8mb4',
  dateStrings: false,
  decimalNumbers: true,
});

export default pool;

/**
 * Run fn(conn) inside a transaction. Commits on success, rolls back on any error.
 * All workflow changes (submit, approve, unlock, certificate) go through this.
 *
 * conn.afterCommit(task) queues work (e.g. sending email) that must only happen
 * if the transaction commits. Tasks run after commit; their errors are logged,
 * never thrown, because the change itself has already succeeded.
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  const afterCommit = [];
  conn.afterCommit = (task) => afterCommit.push(task);
  let result;
  try {
    await conn.beginTransaction();
    result = await fn(conn);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    delete conn.afterCommit;
    conn.release();
  }
  for (const task of afterCommit) {
    Promise.resolve().then(task).catch((err) => console.error('after-commit task failed:', err.message));
  }
  return result;
}
