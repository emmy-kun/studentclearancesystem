// Clearance slips. When an office approves a stage, the system issues that office's
// slip (e.g. the Faculty's "School Fees Clearance Receipt") as a PDF with a QR code.
// Later stages (Security, Audit) see these slips attached automatically, so students
// never re-upload paper slips, and slips cannot be edited or swapped.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import pool from '../config/db.js';
import env from '../config/env.js';
import brand from '../config/brand.js';
import httpError from '../utils/httpError.js';
import { inScope } from '../middleware/requireRole.js';
import { writePdf, longDate, titleCase } from './pdfFiles.js';

const GREEN = '#146C3C';
const ngn = (n) => `NGN ${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

const ROLE_TITLE = {
  departmental: 'Departmental Clearance Officer',
  faculty: 'Faculty Finance Officer',
  library: 'Library Clearance Officer',
  alumni: 'Alumni Office Officer',
  student_affairs: "Students' Affairs Officer",
  security: 'Security Clearance Officer',
};

/** Which stages issue a slip, its title and slip-number prefix, and who issues it. */
export const SLIP_TYPES = {
  departmental: { title: 'Departmental Clearance Slip', prefix: 'DEP', office: (s) => `Department of ${s.department}` },
  faculty: { title: 'School Fees Clearance Receipt', prefix: 'SFC', office: (s) => `Faculty of ${s.faculty} (Finance Office)` },
  library: { title: 'Library Clearance Slip', prefix: 'LIB', office: () => 'University Library' },
  alumni: { title: 'Alumni Clearance Slip', prefix: 'ALU', office: () => 'Alumni Office' },
  student_affairs: { title: 'Accommodation Clearance Slip', prefix: 'ACC', office: () => "Students' Affairs (Accommodation)" },
  security: { title: 'Security Clearance Slip', prefix: 'SEC', office: () => 'Security Department' },
  convocation: { title: 'Convocation Fee Receipt', prefix: 'CON', office: () => 'Convocation (fee confirmed online)' },
};

export const slipTitle = (stageKey) => SLIP_TYPES[stageKey]?.title || null;
export const verifyUrl = (code) => `${env.appBaseUrl}/verify/${code}`;

/** What this office checked, in one or two sentences, from the stage's data. */
function checkedLines(stage, student, ctx) {
  const levels = `100 to ${student.levels_count * 100} level`;
  const form = stage.form_data || {};
  switch (stage.stage_key) {
    case 'departmental':
      return [`Departmental dues receipts for ${levels} verified.`];
    case 'faculty':
      return [`Online school fees receipts, Remita bank tellers and faculty dues receipts for ${levels}, and the homecoming receipt, verified.`];
    case 'library':
      return [form.library_registered === false ? 'Not registered with the library: school fees receipt and passport photograph verified.' : 'Library card verified. No outstanding library obligations.'];
    case 'alumni':
      return ['Final-year online school fees receipt verified.'];
    case 'student_affairs':
      return form.accommodation_type === 'off_campus'
        ? [`Lived off campus${form.off_campus_address ? ` (${form.off_campus_address})` : ''}. Off-campus clearance verified.`]
        : [`Lived in university accommodation${form.hostel_name ? `: ${[form.hostel_name, form.block && `Block ${form.block}`, form.room_no && `Room ${form.room_no}`].filter(Boolean).join(', ')}` : ''}. Accommodation form verified.`];
    case 'security': {
      const earlier = ctx.stages.filter((s) => s.sequence_order < stage.sequence_order && s.status === 'approved' && SLIP_TYPES[s.stage_key]).map((s) => SLIP_TYPES[s.stage_key].title);
      return ['School ID card verified.', earlier.length ? `Earlier clearances confirmed: ${earlier.join(', ')}.` : null].filter(Boolean);
    }
    case 'convocation':
      return ['Convocation fee paid online and confirmed by the payment provider.'];
    default:
      return [];
  }
}

async function drawSlip(doc, { type, student, session, slipNo, issuedAt, officer, lines, payments, code }) {
  const W = doc.page.width;
  const left = 56;
  const width = W - 112;

  doc.rect(0, 0, W, 8).fill(GREEN);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(16).text(brand.name.toUpperCase(), left, 40, { width, align: 'center' });
  doc.fillColor('#555').font('Helvetica').fontSize(10).text('Final Year Student Clearance', { width, align: 'center' });
  doc.moveDown(0.8).fillColor('#111').font('Helvetica-Bold').fontSize(20).text(type.title, { width, align: 'center' });
  doc.fillColor('#555').font('Helvetica').fontSize(10.5).text(`Issued by: ${type.office(student)}`, { width, align: 'center' });

  // Student details
  const top = doc.y + 18;
  doc.roundedRect(left, top, width, 96, 6).lineWidth(0.8).strokeColor('#cfd8d3').stroke();
  const row = (label, value, y) => {
    doc.fillColor('#666').font('Helvetica').fontSize(9.5).text(label, left + 14, y, { width: 110 });
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text(value, left + 124, y - 1, { width: width - 140 });
  };
  row('Student', titleCase(student.full_name), top + 12);
  row('Reg. number', student.matric_no, top + 32);
  row('Department', `${student.department}, Faculty of ${student.faculty}`, top + 52);
  row('Session', session, top + 72);

  // What was checked
  doc.fillColor('#111').font('Helvetica').fontSize(11).text(
    `This is to confirm that the student named above has been cleared by the ${type.office(student)} as part of the final-year clearance.`,
    left, top + 116, { width, lineGap: 2 }
  );
  for (const l of lines) doc.moveDown(0.4).text(`•  ${l}`, { width, lineGap: 2 });
  if (payments.length) {
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(10.5).text('Payments');
    for (const p of payments) {
      doc.font('Helvetica').fontSize(10).text(`•  ${p.description || 'Fee'}: ${ngn(p.amount)}, paid ${longDate(p.paid_at)}${p.reference ? ` (ref ${p.reference})` : ''}`, { width });
    }
  }

  // Approval + QR
  const footY = doc.y + 40;
  doc.fillColor('#111').font('Helvetica').fontSize(10.5);
  doc.text(`Slip no.: ${slipNo}`, left, footY);
  doc.text(`Date: ${longDate(issuedAt)}`, left, footY + 16);
  doc.text(officer ? `Approved by: ${officer.full_name}, ${ROLE_TITLE[officer.role] || 'Clearance Officer'}` : 'Approved automatically on confirmation of payment', left, footY + 32, { width: width - 140 });
  doc.fillColor('#666').fontSize(8.5).text(`Approved digitally on the ${brand.name}. Scan the QR code or visit the address below to confirm this slip is genuine.`, left, footY + 56, { width: width - 140 });
  doc.fillColor(GREEN).fontSize(7.5).text(verifyUrl(code), left, footY + 82, { width: width - 140 });
  const qr = await QRCode.toBuffer(verifyUrl(code), { margin: 1, width: 240 });
  doc.image(qr, left + width - 110, footY - 6, { width: 110 });
}

/**
 * Issue (or re-issue, after a reopened stage is approved again) the slip for an
 * approved stage, inside the approving transaction. Returns { file_path, replaced_path }
 * or null for stages that issue no slip.
 */
export async function issueSlip(conn, ctx, stage, staffId) {
  const type = SLIP_TYPES[stage.stage_key];
  if (!type) return null;

  const [[officer]] = staffId ? await conn.query('SELECT full_name, role FROM staff WHERE staff_id = ?', [staffId]) : [[null]];
  const payments = ctx.payments.filter((p) => p.stage_id === stage.stage_id && p.status === 'success');
  const [[existing]] = await conn.query('SELECT slip_id, slip_no, verification_code, file_path FROM clearance_slips WHERE stage_id = ?', [stage.stage_id]);
  const issuedAt = new Date();

  let slipId = existing?.slip_id;
  let slipNo = existing?.slip_no;
  const code = existing?.verification_code || crypto.randomBytes(32).toString('hex');
  if (!existing) {
    const [res] = await conn.query('INSERT INTO clearance_slips (stage_id, slip_no, verification_code, issued_by, issued_at, file_path) VALUES (?, ?, ?, ?, ?, ?)', [stage.stage_id, `PENDING-${code.slice(0, 16)}`, code, staffId || null, issuedAt, 'pending']);
    slipId = res.insertId;
    slipNo = `${type.prefix}-${issuedAt.getFullYear()}-${String(slipId).padStart(6, '0')}`;
  }

  const filePath = await writePdf('slips', (doc) =>
    drawSlip(doc, { type, student: ctx.student, session: ctx.request.session, slipNo, issuedAt, officer, lines: checkedLines(stage, ctx.student, ctx), payments, code })
  );
  await conn.query('UPDATE clearance_slips SET slip_no = ?, issued_by = ?, issued_at = ?, file_path = ? WHERE slip_id = ?', [slipNo, staffId || null, issuedAt, filePath, slipId]);
  return { slip_id: slipId, slip_no: slipNo, file_path: filePath, replaced_path: existing?.file_path || null };
}

/**
 * Who may download a slip: the student it belongs to; the office that issued it
 * (within scope); Security and Audit, which receive the slips; and the Admin.
 */
export async function getSlipFile(user, slipId) {
  const [[row]] = await pool.query(
    `SELECT sl.file_path, sl.slip_no, cs.stage_key, cs.status, ws.reviewer_role, cr.student_id, s.department_id, d.faculty_id
       FROM clearance_slips sl
       JOIN clearance_stages cs ON cs.stage_id = sl.stage_id
       JOIN workflow_stages ws ON ws.stage_key = cs.stage_key
       JOIN clearance_requests cr ON cr.request_id = cs.request_id
       JOIN students s ON s.student_id = cr.student_id
       JOIN departments d ON d.department_id = s.department_id
      WHERE sl.slip_id = ?`,
    [slipId]
  );
  const student = row && { student_id: row.student_id, department_id: row.department_id, faculty_id: row.faculty_id };
  const allowed =
    row &&
    ((user.role === 'student' && user.sub === row.student_id) ||
      ['admin', 'audit', 'security'].includes(user.role) ||
      (user.userType === 'staff' && user.role === row.reviewer_role && inScope(user, student)));
  if (!allowed) throw httpError(404, 'Slip not found');
  return { relativePath: row.file_path, filename: `${row.slip_no}.pdf` };
}

/** Public verification of a slip code (used by GET /api/verify/:code). */
export async function verifySlip(code) {
  const [[row]] = await pool.query(
    `SELECT sl.slip_no, sl.issued_at, cs.stage_key, cs.status, cr.session, s.full_name, s.matric_no, d.name AS department, f.name AS faculty
       FROM clearance_slips sl
       JOIN clearance_stages cs ON cs.stage_id = sl.stage_id
       JOIN clearance_requests cr ON cr.request_id = cs.request_id
       JOIN students s ON s.student_id = cr.student_id
       JOIN departments d ON d.department_id = s.department_id
       JOIN faculties f ON f.faculty_id = d.faculty_id
      WHERE sl.verification_code = ?`,
    [code]
  );
  // A slip stops being valid if its stage is reopened (e.g. sent back by Audit).
  if (!row || row.status !== 'approved') return null;
  return {
    valid: true,
    type: 'slip',
    document: SLIP_TYPES[row.stage_key]?.title,
    name: row.full_name,
    matric_no: row.matric_no,
    department: row.department,
    faculty: row.faculty,
    session: row.session,
    issue_date: row.issued_at,
    slip_no: row.slip_no,
  };
}
