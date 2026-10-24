// Where uploaded documents and generated PDFs are kept. Paths are always relative
// ('documents/<random>.jpg', 'certificates/<random>.pdf') and stored in the database.
//
//   STORAGE_DRIVER=disk (default)  files in server/uploads (local development, tests)
//   STORAGE_DRIVER=db              files in the stored_files table (Vercel: its disk is
//                                  temporary, and this keeps files private behind login)
import fs from 'node:fs/promises';
import path from 'node:path';
import pool from '../config/db.js';
import env from '../config/env.js';
import httpError from '../utils/httpError.js';

const useDb = () => env.uploads.driver === 'db';

/** Absolute path of a stored upload (disk driver); refuses anything that escapes the uploads folder. */
export function uploadPath(relativePath) {
  const abs = path.resolve(env.uploads.dir, relativePath);
  if (!abs.startsWith(path.resolve(env.uploads.dir) + path.sep)) throw httpError(400, 'Invalid file path');
  return abs;
}

export async function saveFile(relativePath, buffer, mimeType) {
  if (useDb()) {
    await pool.query('INSERT INTO stored_files (path, mime_type, size, content) VALUES (?, ?, ?, ?)', [relativePath, mimeType, buffer.length, buffer]);
    return;
  }
  const abs = uploadPath(relativePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer);
}

/** The file's bytes, or null if it is missing. */
export async function readFile(relativePath) {
  if (useDb()) {
    const [[row]] = await pool.query('SELECT content FROM stored_files WHERE path = ?', [relativePath]);
    return row ? row.content : null;
  }
  return fs.readFile(uploadPath(relativePath)).catch(() => null);
}

export async function deleteFile(relativePath) {
  if (useDb()) await pool.query('DELETE FROM stored_files WHERE path = ?', [relativePath]);
  else await fs.unlink(uploadPath(relativePath)).catch(() => {});
}

/** Send a stored file in the response (always private, never cached). */
export async function sendStoredFile(res, relativePath, { contentType, disposition }) {
  const data = await readFile(relativePath);
  if (!data) throw httpError(404, 'File is missing from storage');
  res.set({ 'Content-Type': contentType, 'Content-Disposition': disposition, 'Cache-Control': 'private, no-store' });
  res.send(data);
}
