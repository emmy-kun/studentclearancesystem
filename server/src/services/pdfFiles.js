// Shared helpers for generated PDFs (application letter, certificate, reports).
// Files are kept in private storage (services/storage.js) and only served through
// authenticated routes.
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { saveFile } from './storage.js';

/**
 * Create a PDF stored as <subdir>/<random>.pdf. `draw(doc)` lays out the
 * pages (may be async). Resolves to the stored (relative) path.
 */
export async function writePdf(subdir, draw, options = {}) {
  const relativePath = `${subdir}/${crypto.randomBytes(16).toString('hex')}.pdf`;
  const doc = new PDFDocument({ size: 'A4', margin: 56, ...options });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  try {
    await draw(doc);
  } finally {
    doc.end();
  }
  await done;
  await saveFile(relativePath, Buffer.concat(chunks), 'application/pdf');
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
