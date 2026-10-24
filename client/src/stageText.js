// Wording for stages and offices, shared by the student and staff screens.
import { naira } from './api/client.js';

export const OFFICE = {
  departmental: 'Department',
  faculty: 'Faculty',
  library: 'Library',
  alumni: 'Alumni Office',
  student_affairs: "Students' Affairs",
  security: 'Security',
  convocation: 'Convocation',
  letter: 'Department',
  audit: 'Audit',
};

export const ROLE_LABEL = {
  departmental: 'Departmental officer',
  faculty: 'Faculty officer',
  library: 'Library officer',
  alumni: 'Alumni Office officer',
  student_affairs: "Students' Affairs officer",
  security: 'Security officer',
  audit: 'Audit officer',
  registry: 'Registry officer',
  admin: 'Administrator',
};

/** One-line summary under each stage on the student dashboard. */
export function stageSummary(stage, levelsCount = 4) {
  const fee = stage.fee_amount ? ` · ${naira(stage.fee_amount)}` : '';
  switch (stage.stage_key) {
    case 'departmental':
      return `Dues receipts for 100 to ${levelsCount * 100} level`;
    case 'faculty':
      return 'School fees, faculty dues and homecoming receipts';
    case 'library':
      return 'Library card or registration documents';
    case 'alumni':
      return `Final-year fees receipt${fee}`;
    case 'student_affairs':
      return "Students' Affairs accommodation forms";
    case 'security':
      return `ID and clearance papers${fee}`;
    case 'convocation':
      return `Pay online${fee} · can be done any time`;
    case 'letter':
      return 'Graduation list check, then your application letter is generated';
    case 'audit':
      return 'Final review of your whole file';
    default:
      return '';
  }
}

/** "Departmental dues receipt (original)" at level 300 -> "300 level". */
export const levelLabel = (level) => (level ? `${level} level` : null);

/** plural(1, 'file') -> "1 file"; plural(3, 'file') -> "3 files". */
export const plural = (n, word, many = `${word}s`) => `${n} ${Number(n) === 1 ? word : many}`;

export const STAGE_NAME = {
  departmental: 'Departmental Clearance',
  faculty: 'Faculty Clearance',
  library: 'Library Clearance',
  alumni: 'Alumni Clearance',
  student_affairs: 'Accommodation Clearance',
  security: 'Security Clearance',
  convocation: 'Convocation Fee',
  letter: 'Graduation List & Application Letter',
  audit: 'Audit',
};

/** Plain-English wording for audit-log action codes. */
export const AUDIT_ACTION = {
  'auth.login': 'Logged in',
  'student.signup': 'Created a student account',
  'student.update': 'Updated a student record',
  'student.account_reset': 'Reset a student account',
  'students.import': 'Imported a class list',
  'results.release': 'Released results',
  'results.withdraw': 'Withdrew results',
  'staff.create': 'Created a staff account',
  'staff.update': 'Updated a staff account',
  'staff.activate': 'Reactivated a staff account',
  'staff.deactivate': 'Deactivated a staff account',
  'staff.delete': 'Deleted a staff account',
  'staff.password_reset': 'Reset a staff password',
  'staff.password_change': 'Changed their password',
  'request.create': 'Started clearance',
  'request.complete': 'Clearance completed',
  'stage.unlock': 'Stage opened',
  'stage.form_save': 'Saved stage details',
  'stage.submit': 'Submitted a stage',
  'stage.resubmit': 'Resubmitted a stage',
  'stage.approve': 'Approved a stage',
  'stage.auto_approve': 'Stage approved automatically',
  'stage.reject': 'Sent a stage back',
  'stage.audit_reject': 'Audit sent a stage back',
  'document.upload': 'Uploaded a document',
  'document.replace': 'Replaced a document',
  'document.delete': 'Removed a document',
  'document.accept': 'Accepted a document',
  'document.reject': 'Rejected a document',
  'payment.initialize': 'Started a payment',
  'payment.success': 'Payment received',
  'payment.failed': 'Payment failed',
  'payment.mismatch': 'Payment amount did not match',
  'payment.charge_raised': 'Added a charge',
  'payment.charge_cancelled': 'Withdrew a charge',
  'letter.generate': 'Generated the application letter',
  'degree.issue': 'Recorded a degree certificate collection',
  'faculty.save': 'Saved a faculty',
  'department.save': 'Saved a department',
  'department.delete': 'Deleted a department',
  'required_document.save': 'Saved a required document',
  'required_document.delete': 'Removed a required document',
};

/** A short readable summary of an audit entry's details. */
export function auditSummary(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const d = detail;
  const parts = [];
  if (d.stage_key) parts.push(STAGE_NAME[d.stage_key] || d.stage_key);
  if (d.reopened) parts.push(`reopened ${STAGE_NAME[d.reopened] || d.reopened}`);
  if (d.slot) parts.push(d.slot);
  if (d.description) parts.push(d.description);
  if (d.amount != null) parts.push(naira(d.amount));
  if (d.reference_no || d.reference) parts.push(`ref ${d.reference_no || d.reference}`);
  if (d.duplicate) parts.push('duplicate receipt number');
  if (d.certificate_no) parts.push(d.certificate_no);
  if (d.serial_no) parts.push(`serial ${d.serial_no}`);
  if (d.comment) parts.push(`"${d.comment}"`);
  if (d.note) parts.push(`"${d.note}"`);
  if (d.email) parts.push(d.email);
  if (d.role) parts.push(ROLE_LABEL[d.role] || d.role);
  if (d.rows_imported != null) parts.push(`${plural(d.rows_imported, 'student')} imported, ${d.rows_failed || 0} failed, ${d.rows_skipped || 0} already there`);
  if (d.students != null) parts.push(plural(d.students, 'student'));
  if (d.letters_unlocked) parts.push(`${plural(d.letters_unlocked, 'letter')} unlocked`);
  if (d.name && !d.email) parts.push(d.name);
  return parts.join(' · ');
}
