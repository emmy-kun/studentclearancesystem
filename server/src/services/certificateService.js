// Clearance certificate (spec section 8). Issued inside the Audit-approve
// transaction: a certificates row (certificate_no + random verification code)
// and a PDF with a QR code that links to the public verification page.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import pool from '../config/db.js';
import env from '../config/env.js';
import brand from '../config/brand.js';
import httpError from '../utils/httpError.js';
import { writePdf, longDate, titleCase } from './pdfFiles.js';
import { verifySlip } from './slipService.js';

const GREEN = '#146C3C';
const CODE_FORMAT = /^[a-f0-9]{64}$/;

export const verifyUrl = (code) => `${env.appBaseUrl}/verify/${code}`;
export const formatCertificateNo = (year, id) => `CLR-${year}-${String(id).padStart(6, '0')}`;

const INK = '#1d2a22';
const PAPER = '#fbf6e9';

/**
 * Classic, formal clearance certificate (portrait A4): cream paper, fine double
 * border, the logo (when one is set), serif lettering, details on dotted lines, QR verification.
 * Kept deliberately short: who, which department, which session, and how to verify it.
 * It certifies clearance, not a degree: no Senate wording or Vice-Chancellor/Registrar
 * signatures, and the footer says it is not a degree certificate.
 */
export async function drawCertificate(doc, { student, session, certificateNo, issueDate, code }) {
  const W = doc.page.width;
  const H = doc.page.height;
  const L = 72;
  const R = W - 72;
  const name = titleCase(student.full_name);

  // Paper and double border with small corner ornaments
  doc.rect(0, 0, W, H).fill(PAPER);
  doc.lineWidth(2.2).strokeColor(INK).rect(18, 18, W - 36, H - 36).stroke();
  doc.lineWidth(0.6).rect(26, 26, W - 52, H - 52).stroke();
  for (const [x, y] of [[26, 26], [W - 26, 26], [26, H - 26], [W - 26, H - 26]]) doc.circle(x, y, 2.6).fill(INK);

  // The logo at the top, and a very faint copy behind the text (only when a logo is set).
  const logo = brand.logo();
  if (logo) {
    doc.save().opacity(0.06).image(logo, W / 2 - 150, H / 2 - 210, { width: 300 }).restore();
    doc.image(logo, W / 2 - 32, 56, { width: 64 });
  }

  const centre = (text, y, font, size, color = INK, opts = {}) =>
    doc.font(font).fontSize(size).fillColor(color).text(text, L - 20, y, { width: R - L + 40, align: 'center', ...opts });
  const dotted = (x1, x2, y) =>
    doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(0.8).dash(1, { space: 2.5 }).strokeColor('#8d8d86').stroke().undash().restore();

  centre(brand.name.toUpperCase(), 152, 'Times-Bold', 18, INK, { characterSpacing: 0.8 });
  centre('Office of Student Clearance', 181, 'Times-Italic', 12.5, '#4d5650');
  doc.moveTo(W / 2 - 70, 204).lineTo(W / 2 + 70, 204).lineWidth(1.2).strokeColor(GREEN).stroke();
  centre('Final Year Clearance Certificate', 224, 'Times-BoldItalic', 29);

  centre('This is to certify that', 300, 'Times-Italic', 15);
  centre(name, 332, 'Times-BoldItalic', 25);
  dotted(L, R, 364);

  // Details written on dotted lines: label, value centred on the line, optional suffix.
  const row = (y, label, value, suffix = '') => {
    doc.font('Times-Roman').fontSize(14).fillColor(INK);
    const start = L + doc.widthOfString(`${label} `);
    doc.text(label, L, y, { lineBreak: false });
    let end = R;
    if (suffix) {
      end = R - doc.widthOfString(` ${suffix}`);
      doc.text(suffix, end + doc.widthOfString(' '), y, { lineBreak: false });
    }
    dotted(start, end, y + 15);
    doc.font('Times-BoldItalic').fontSize(14.5).text(value, start, y - 1, { width: end - start, align: 'center', lineBreak: false });
  };
  row(398, 'with Registration Number', student.matric_no);
  row(436, 'of the Department of', student.department);
  row(474, 'in the Faculty of', student.faculty);
  centre('has satisfactorily completed the final-year clearance procedure', 514, 'Times-Roman', 14);
  row(546, 'for the', session, 'academic session.');

  // Footer: certificate details (left) and QR verification (right)
  const footY = H - 210;
  doc.font('Times-Roman').fontSize(11.5).fillColor(INK);
  doc.text(`Certificate No.: ${certificateNo}`, L, footY);
  doc.text(`Date of issue: ${longDate(issueDate)}`, L, footY + 18);
  doc.font('Times-Italic').text('Approved digitally by the Audit Unit', L, footY + 36);
  const qr = await QRCode.toBuffer(verifyUrl(code), { margin: 1, width: 300, errorCorrectionLevel: 'M', color: { dark: '#1d2a22', light: '#fbf6e9' } });
  doc.image(qr, R - 104, footY - 8, { width: 104 });
  doc.font('Times-Italic').fontSize(9.5).fillColor('#4d5650').text('Scan to verify', R - 104, footY + 100, { width: 104, align: 'center' });

  doc.font('Times-Roman').fontSize(8.5).fillColor('#5d665f').text(
    `This is not a degree certificate. To confirm it is genuine, scan the QR code or enter the certificate number and registration number at ${env.appBaseUrl}/verify.`,
    L, H - 74, { width: R - L, align: 'center', lineGap: 1.5 }
  );
}

/**
 * Create the certificate for a completed request (inside the caller's
 * transaction). Returns { certificate_id, certificate_no, file_path }.
 * Calling it twice for the same request returns the existing certificate.
 */
export async function issueCertificate(conn, requestId) {
  const [[existing]] = await conn.query('SELECT certificate_id, certificate_no, file_path FROM certificates WHERE request_id = ?', [requestId]);
  if (existing) return { ...existing, created: false };

  const [[info]] = await conn.query(
    `SELECT cr.session, cr.completed_at, s.full_name, s.matric_no, d.name AS department, f.name AS faculty
       FROM clearance_requests cr
       JOIN students s ON s.student_id = cr.student_id
       JOIN departments d ON d.department_id = s.department_id
       JOIN faculties f ON f.faculty_id = d.faculty_id
      WHERE cr.request_id = ?`,
    [requestId]
  );

  const code = crypto.randomBytes(32).toString('hex');
  const issueDate = new Date();
  // Insert first to get the id the certificate number is built from.
  const [res] = await conn.query(
    'INSERT INTO certificates (request_id, certificate_no, verification_code, issue_date, file_path) VALUES (?, ?, ?, ?, ?)',
    [requestId, `PENDING-${code.slice(0, 16)}`, code, issueDate, 'pending']
  );
  const certificateNo = formatCertificateNo(issueDate.getFullYear(), res.insertId);

  const filePath = await writePdf(
    'certificates',
    (doc) => drawCertificate(doc, { student: info, session: info.session, certificateNo, issueDate, code }),
    { size: 'A4', margin: 0 }
  );
  await conn.query('UPDATE certificates SET certificate_no = ?, file_path = ? WHERE certificate_id = ?', [certificateNo, filePath, res.insertId]);
  return { certificate_id: res.insertId, certificate_no: certificateNo, file_path: filePath, created: true };
}

const CERTIFICATE_QUERY = `SELECT c.certificate_no, c.issue_date, cr.session, s.full_name, s.matric_no, d.name AS department, f.name AS faculty
       FROM certificates c
       JOIN clearance_requests cr ON cr.request_id = c.request_id
       JOIN students s ON s.student_id = cr.student_id
       JOIN departments d ON d.department_id = s.department_id
       JOIN faculties f ON f.faculty_id = d.faculty_id
      WHERE cr.status = 'completed' AND `;

/** GET /api/verify/:code (public). */
export async function verifyCertificate(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!CODE_FORMAT.test(c)) return { valid: false };
  const [[row]] = await pool.query(`${CERTIFICATE_QUERY} c.verification_code = ?`, [c]);
  if (!row) return (await verifySlip(c)) || { valid: false };
  return certificateResult(row);
}

/**
 * GET /api/verify?certificate_no=&matric_no= (public). Certificate numbers run in
 * sequence, so the reg number must match too: a number alone reveals nothing.
 */
export async function verifyCertificateByNumber(certificateNo, matricNo) {
  const no = String(certificateNo || '').trim().toUpperCase();
  const matric = String(matricNo || '').trim();
  // Older certificates were numbered UNN-CLR-…; they still verify.
  if (!/^(UNN-)?CLR-\d{4}-\d{6}$/.test(no) || !matric) return { valid: false };
  const [[row]] = await pool.query(`${CERTIFICATE_QUERY} c.certificate_no = ? AND s.matric_no = ?`, [no, matric]);
  return row ? certificateResult(row) : { valid: false };
}

function certificateResult(row) {
  return {
    valid: true,
    type: 'certificate',
    document: 'Clearance Certificate',
    name: row.full_name,
    matric_no: row.matric_no,
    department: row.department,
    faculty: row.faculty,
    session: row.session,
    issue_date: row.issue_date,
    certificate_no: row.certificate_no,
  };
}

/** The student's own certificate summary, or null. */
export async function getMyCertificate(studentId) {
  const [[row]] = await pool.query(
    `SELECT c.certificate_id, c.certificate_no, c.issue_date, c.verification_code, c.degree_issued_at
       FROM certificates c JOIN clearance_requests cr ON cr.request_id = c.request_id
      WHERE cr.student_id = ? ORDER BY c.issue_date DESC LIMIT 1`,
    [studentId]
  );
  if (!row) return null;
  return { ...row, verify_url: verifyUrl(row.verification_code) };
}

/** Who may download a certificate PDF: the student it belongs to, Audit, the Registry and the Admin. */
export async function getCertificateFile(user, certificateId) {
  const [[row]] = await pool.query(
    `SELECT c.file_path, c.certificate_no, cr.student_id
       FROM certificates c JOIN clearance_requests cr ON cr.request_id = c.request_id
      WHERE c.certificate_id = ?`,
    [certificateId]
  );
  const allowed = row && ((user.role === 'student' && user.sub === row.student_id) || ['audit', 'registry', 'admin'].includes(user.role));
  if (!allowed) throw httpError(404, 'Certificate not found');
  return { relativePath: row.file_path, filename: `${row.certificate_no}.pdf` };
}

/** Who may download an application letter: the student, Audit (dossier) and the Admin. */
export async function getLetterFile(user, requestId) {
  const [[row]] = await pool.query(
    `SELECT cr.letter_path, cr.student_id, s.matric_no FROM clearance_requests cr JOIN students s ON s.student_id = cr.student_id WHERE cr.request_id = ?`,
    [requestId]
  );
  const allowed = row?.letter_path && ((user.role === 'student' && user.sub === row.student_id) || user.role === 'audit' || user.role === 'admin');
  if (!allowed) throw httpError(404, 'Letter not found');
  return { relativePath: row.letter_path, filename: `Application-letter-${row.matric_no.replace('/', '-')}.pdf` };
}
