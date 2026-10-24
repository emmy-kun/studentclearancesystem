// File storage: the database driver used on Vercel (STORAGE_DRIVER=db) keeps files
// in stored_files; the same calls work with the default disk driver.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { default: pool } = await import('../src/config/db.js');
const { default: env } = await import('../src/config/env.js');
const { saveFile, readFile, deleteFile } = await import('../src/services/storage.js');
const { writePdf } = await import('../src/services/pdfFiles.js');

const created = [];
after(async () => {
  env.uploads.driver = 'disk';
  await pool.query('DELETE FROM stored_files WHERE path IN (?)', [created.length ? created : ['-']]);
  await pool.end();
});

test('database storage saves, reads and deletes a file', async () => {
  env.uploads.driver = 'db';
  const p = 'documents/storage-test.jpg';
  created.push(p);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  await saveFile(p, bytes, 'image/jpeg');
  assert.deepEqual(await readFile(p), bytes);
  const [[row]] = await pool.query('SELECT mime_type, size FROM stored_files WHERE path = ?', [p]);
  assert.deepEqual(row, { mime_type: 'image/jpeg', size: 6 });
  await deleteFile(p);
  assert.equal(await readFile(p), null);
});

test('generated PDFs go to database storage too', async () => {
  env.uploads.driver = 'db';
  const p = await writePdf('certificates', (doc) => doc.text('Storage test'));
  created.push(p);
  assert.match(p, /^certificates\/[a-f0-9]{32}\.pdf$/);
  assert.equal((await readFile(p)).subarray(0, 5).toString(), '%PDF-');
});

test('the disk driver refuses paths outside the uploads folder', async () => {
  env.uploads.driver = 'disk';
  await assert.rejects(readFile('../.env').then((b) => (b === null ? Promise.reject(new Error('refused')) : b)));
  await assert.rejects(saveFile('../escape.txt', Buffer.from('x'), 'text/plain'));
});
