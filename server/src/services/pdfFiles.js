// Shared helpers for generated PDFs (application letter, certificate, reports).
// Files live in the private uploads folder and are only served through
// authenticated routes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import env from '../config/env.js';

/**
 * Create a PDF at uploads/<subdir>/<random>.pdf. `draw(doc)` lays out the
 * pages (may be async). Resolves to the path relative to the uploads folder.
 */
export async function writePdf(subdir, draw, options = {}) {
  const dir = path.join(env.uploads.dir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const relativePath = `${subdir}/${crypto.randomBytes(16).toString('hex')}.pdf`;
  const absPath = path.join(env.uploads.dir, relativePath);

  const doc = new PDFDocument({ size: 'A4', margin: 56, ...options });
  const out = fs.createWriteStream(absPath);
  const done = new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  doc.pipe(out);
  try {
    await draw(doc);
  } finally {
    doc.end();
  }
  await done;
  return relativePath;
}

/** "22 October 2026" */
export function longDate(date = new Date()) {
  return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** "ABAH PRECIOUS CHINEMEREM" -> "Abah Precious Chinemerem" (for prose; records keep the original). */
export function titleCase(name) {
  return String(name).toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());
}
