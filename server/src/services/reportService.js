// Admin clearance report (GET /api/admin/reports/clearance.pdf), streamed straight to the response.
import PDFDocument from 'pdfkit';
import { dashboard } from './adminService.js';
import { longDate } from './pdfFiles.js';
import pool from '../config/db.js';
import brand from '../config/brand.js';

const GREEN = '#146C3C';
const ngn = (n) => `NGN ${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

function table(doc, columns, rows, { x = 50, widths }) {
  const rowH = 20;
  const drawRow = (cells, bold) => {
    if (doc.y + rowH > doc.page.height - 60) doc.addPage();
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(bold ? '#333' : '#111');
    let cx = x;
    cells.forEach((c, i) => {
      doc.text(String(c ?? '—'), cx + 4, y + 6, { width: widths[i] - 8, lineBreak: false, ellipsis: true, align: i === 0 ? 'left' : 'right' });
      cx += widths[i];
    });
    doc.moveTo(x, y + rowH).lineTo(x + widths.reduce((a, b) => a + b, 0), y + rowH).lineWidth(0.4).strokeColor('#ddd').stroke();
    doc.y = y + rowH;
  };
  drawRow(columns, true);
  rows.forEach((r) => drawRow(r, false));
  doc.moveDown(1);
}

export async function streamClearanceReport(res) {
  const stats = await dashboard();
  const [completed] = await pool.query(
    `SELECT s.full_name, s.matric_no, d.name AS department, c.certificate_no, c.issue_date
       FROM certificates c
       JOIN clearance_requests cr ON cr.request_id = c.request_id
       JOIN students s ON s.student_id = cr.student_id
       JOIN departments d ON d.department_id = s.department_id
      ORDER BY c.issue_date DESC LIMIT 500`
  );

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="clearance-report-${new Date().toISOString().slice(0, 10)}.pdf"`, 'Cache-Control': 'private, no-store' });
  doc.pipe(res);

  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(18).text(brand.name);
  doc.fillColor('#111').fontSize(14).text('Clearance status report');
  doc.font('Helvetica').fontSize(10).fillColor('#555').text(`Generated ${longDate(new Date())}`);
  doc.moveDown(1);

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('Summary');
  doc.moveDown(0.3).font('Helvetica').fontSize(10);
  const s = stats;
  [
    `Students on the class list: ${s.students.total} (${s.students.registered} signed up)`,
    `Clearance requests: ${s.requests.total} started, ${s.requests.in_progress} in progress, ${s.requests.completed} completed`,
    `Completion rate: ${s.requests.completion_rate}%`,
    `Payments received: ${ngn(s.payments.collected)} across ${s.payments.count} ${s.payments.count === 1 ? 'payment' : 'payments'}`,
    `Bottleneck: ${s.bottleneck ? `${s.bottleneck.name} (${s.bottleneck.pending} waiting for review)` : 'none (no files waiting)'}`,
  ].forEach((line) => doc.text(`•  ${line}`, { lineGap: 2 }));
  doc.moveDown(1);

  doc.font('Helvetica-Bold').fontSize(12).text('Stages');
  doc.moveDown(0.4);
  table(
    doc,
    ['Stage', 'Open', 'Waiting', 'Sent back', 'Approved', 'Avg review (h)', 'Avg total (h)'],
    s.stages.map((st) => [st.name, st.awaiting_submission, st.pending, st.rejected, st.approved, st.avg_review_hours ?? '—', st.avg_total_hours ?? '—']),
    { widths: [140, 50, 55, 60, 60, 65, 65] }
  );

  doc.font('Helvetica-Bold').fontSize(12).text('Departments');
  doc.moveDown(0.4);
  table(doc, ['Department', 'Students', 'Started', 'Completed'], s.departments.map((d) => [d.department, d.students, d.started, d.completed]), { widths: [255, 80, 80, 80] });

  doc.font('Helvetica-Bold').fontSize(12).text(`Certificates issued (${completed.length})`);
  doc.moveDown(0.4);
  if (completed.length === 0) doc.font('Helvetica').fontSize(10).fillColor('#555').text('No certificates issued yet.');
  else table(doc, ['Student', 'Reg no.', 'Certificate no.', 'Issued'], completed.map((c) => [c.full_name, c.matric_no, c.certificate_no, longDate(c.issue_date)]), { widths: [180, 85, 130, 100] });

  doc.end();
}
