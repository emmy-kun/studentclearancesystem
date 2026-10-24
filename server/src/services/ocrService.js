// Automatic name / reg-number check on uploaded photos (OCR with Tesseract) and on
// typed PDFs (their text is read directly, page by page, which is far more reliable).
//
// It only ASSISTS the reviewer: printed documents (online school fees receipts,
// library cards, ID cards) read well; handwritten receipts and dim photos often
// do not. The reviewer must still confirm the match before accepting a document.
//
// Photos are read one at a time in the background after the upload is saved,
// so students never wait for it.
import pool from '../config/db.js';
import env from '../config/env.js';
import { uploadPath } from './workflowEngine.js';

const IMAGE = /^image\/(jpeg|png|webp)$/;
const MIN_TEXT = 15; // fewer readable characters than this = could not read
const MIN_CONFIDENCE = 25;

let workerPromise = null;
let queue = Promise.resolve();

async function getWorker() {
  if (!workerPromise) {
    workerPromise = import('tesseract.js').then(({ createWorker }) =>
      createWorker('eng', 1, { cachePath: env.ocr.cacheDir, logger: () => {} })
    );
  }
  return workerPromise;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/**
 * Compare OCR text with the student's record.
 * Reg number: the 6-digit serial (e.g. 241211 of 2022/241211) must appear in the
 * digits of the text; OCR often reads the "/" as 1 or 7, so separators are ignored.
 * Name: each name part (3+ letters) is found as a word, allowing one wrong letter
 * in longer names; at least two parts (or all, for one-part names) must be found.
 */
export function matchIdentity(text, { full_name, matric_no }) {
  const upper = String(text || '').toUpperCase();
  const words = upper.replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const digits = upper.replace(/[^0-9]/g, '');

  const [year, serial] = String(matric_no).split('/');
  const regFound = Boolean(serial) && digits.includes(serial) && digits.includes(year);

  const parts = String(full_name).toUpperCase().split(/[^A-Z]+/).filter((p) => p.length >= 3);
  const found = parts.filter((p) => words.some((w) => w === p || (p.length >= 5 && Math.abs(w.length - p.length) <= 1 && editDistance(w, p) <= 1)));
  const nameFound = parts.length > 0 && found.length >= Math.min(2, parts.length);

  let status = 'no_match';
  if (regFound && nameFound) status = 'match';
  else if (regFound || nameFound) status = 'partial';
  return { status, reg_found: regFound, name_found: nameFound, name_parts_found: found.length, name_parts: parts.length };
}

/** Text of each page of a PDF (empty strings for scanned pages with no text layer). */
export async function pdfPageTexts(absPath) {
  const fs = await import('node:fs/promises');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(await fs.readFile(absPath)), useSystemFonts: true, isEvalSupported: false });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      pages.push(content.items.map((i) => i.str).join(' '));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** Page numbers (1-based) where the student's reg number appears, or else where their name does. */
export function pagesWithMatch(pages, student) {
  const checks = pages.map((text, i) => ({ page: i + 1, ...matchIdentity(text, student) }));
  const byReg = checks.filter((c) => c.reg_found).map((c) => c.page);
  return byReg.length ? byReg : checks.filter((c) => c.name_found).map((c) => c.page);
}

async function readDocument(documentId) {
  const [[doc]] = await pool.query(
    `SELECT sd.document_id, sd.file_path, sd.mime_type, s.full_name, s.matric_no
       FROM stage_documents sd
       JOIN clearance_stages cs ON cs.stage_id = sd.stage_id
       JOIN clearance_requests cr ON cr.request_id = cs.request_id
       JOIN students s ON s.student_id = cr.student_id
      WHERE sd.document_id = ? AND sd.ocr_status = 'pending'`,
    [documentId]
  );
  if (!doc) return;

  let status;
  let result;
  if (doc.mime_type === 'application/pdf') {
    // Typed PDFs (e.g. a graduation list) carry real text, which is far more reliable than OCR.
    const pages = await pdfPageTexts(uploadPath(doc.file_path));
    const all = pages.join('\n');
    if (all.replace(/\s/g, '').length < MIN_TEXT) {
      status = 'unreadable';
      result = { reason: 'scanned_pdf' };
    } else {
      result = { ...matchIdentity(all, doc), source: 'pdf_text', pages: pages.length, pages_found: pagesWithMatch(pages, doc) };
      status = result.status;
    }
  } else if (!IMAGE.test(doc.mime_type)) {
    status = 'skipped';
    result = { reason: 'unsupported' };
  } else {
    const worker = await getWorker();
    const { data } = await worker.recognize(uploadPath(doc.file_path));
    const readable = data.text.replace(/\s/g, '').length >= MIN_TEXT && data.confidence >= MIN_CONFIDENCE;
    result = { ...matchIdentity(data.text, doc), confidence: Math.round(data.confidence) };
    status = readable || result.status !== 'no_match' ? result.status : 'unreadable';
  }
  // Only record the result if the same file is still there (it may have been replaced meanwhile).
  await pool.query('UPDATE stage_documents SET ocr_status = ?, ocr_result = ? WHERE document_id = ? AND file_path = ?', [status, JSON.stringify(result), documentId, doc.file_path]);
}

/** Read a document's photo in the background (one at a time). */
export function queueOcr(documentId) {
  if (!env.ocr.enabled) return;
  queue = queue.then(() => readDocument(documentId)).catch((err) => console.error(`OCR of document ${documentId} failed:`, err.message));
}

/** Initial ocr_status for a new upload: pending if it will be read, NULL if this document is not checked. */
export function initialOcrStatus(checkIdentity, mimeType) {
  if (!checkIdentity || !env.ocr.enabled) return null;
  return IMAGE.test(mimeType) || mimeType === 'application/pdf' ? 'pending' : 'skipped';
}
