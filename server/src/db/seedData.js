// Reference data for the seed script.

// Starter faculties/departments (sample names). The student CSV import adds any
// others from the class list, so this list only needs to cover the demo.
export const FACULTIES = {
  'Physical Sciences': [
    'Computer Science',
    'Mathematics',
    'Physics and Astronomy',
    'Pure and Industrial Chemistry',
    'Geology',
    'Statistics',
  ],
  Engineering: [
    'Electronic Engineering',
    'Electrical Engineering',
    'Mechanical Engineering',
    'Civil Engineering',
  ],
  'Biological Sciences': ['Microbiology', 'Biochemistry'],
  'Business Administration': ['Accountancy', 'Management', 'Banking and Finance'],
  'Social Sciences': ['Economics', 'Political Science'],
};

// Section 6: workflow_stages seed. `departmental` is first, so "no previous stage"
// means it unlocks on request creation.
export const WORKFLOW_STAGES = [
  { stage_key: 'departmental', name: 'Departmental Clearance', reviewer_role: 'departmental', sequence_order: 1, unlock_rule: 'sequential', review_mode: 'manual', fee_amount: null },
  { stage_key: 'faculty', name: 'Faculty Clearance', reviewer_role: 'faculty', sequence_order: 2, unlock_rule: 'sequential', review_mode: 'manual', fee_amount: null },
  { stage_key: 'library', name: 'Library Clearance', reviewer_role: 'library', sequence_order: 3, unlock_rule: 'sequential', review_mode: 'manual', fee_amount: null },
  { stage_key: 'alumni', name: 'Alumni Clearance', reviewer_role: 'alumni', sequence_order: 4, unlock_rule: 'sequential', review_mode: 'manual', fee_amount: 650.0 },
  { stage_key: 'student_affairs', name: 'Accommodation Clearance', reviewer_role: 'student_affairs', sequence_order: 5, unlock_rule: 'sequential', review_mode: 'manual', fee_amount: null },
  { stage_key: 'security', name: 'Security Clearance', reviewer_role: 'security', sequence_order: 6, unlock_rule: 'sequential', review_mode: 'manual', fee_amount: 1000.0 },
  // Graduation list: the student uploads it with the page their name is on; the departmental
  // officer verifies it, and approval generates the application letter.
  { stage_key: 'letter', name: 'Graduation List & Application Letter', reviewer_role: 'departmental', sequence_order: 7, unlock_rule: 'sequential', review_mode: 'manual', fee_amount: null },
  { stage_key: 'convocation', name: 'Convocation Fee', reviewer_role: null, sequence_order: 8, unlock_rule: 'anytime', review_mode: 'auto', fee_amount: 10000.0 },
  { stage_key: 'audit', name: 'Audit (Final)', reviewer_role: 'audit', sequence_order: 9, unlock_rule: 'all_others_approved', review_mode: 'manual', fee_amount: null },
];

// Section 6: required_documents seed. Admin can edit these in-app later.
// display_order follows the listed order within each stage.
// reference_label / collects_amount / collects_date drive the inputs shown under
// each upload slot (docs/ui-design.md). Only the receipt number is typed in: the
// amount and date are read by the reviewer from the photo of the receipt.
const RECEIPT = { reference_label: 'Receipt no.' };

export const REQUIRED_DOCUMENTS = {
  departmental: [
    { name: 'Departmental dues receipt (original)', description: 'Original departmental dues receipt for this level.', per_level: true, ...RECEIPT },
  ],
  faculty: [
    // Printed from the school portal: checked by the name and reg number on it, so no receipt number.
    { name: 'Online school fees receipt', per_level: true },
    { name: 'Remita bank teller', per_level: true, ...RECEIPT, reference_label: 'Teller / RRR no.' },
    { name: 'Faculty dues receipt', per_level: true, ...RECEIPT },
    { name: 'Homecoming receipt', ...RECEIPT },
  ],
  library: [
    // The library card carries the reg number, not a separate card number, so it is photo only.
    { name: 'Library card', applies_if: 'library_registered' },
    { name: 'School fees receipt', applies_if: 'library_not_registered', reference_label: 'Receipt no.' },
    { name: 'Passport photograph', applies_if: 'library_not_registered', check_identity: false }, // a photo, no name to check
  ],
  alumni: [
    { name: 'Final-year online school fees receipt' },
  ],
  student_affairs: [
    { name: 'Accommodation clearance form (filled)', description: 'Photo of the filled and stamped accommodation form.' },
    { name: 'Off-campus clearance', applies_if: 'off_campus' },
  ],
  // The earlier offices' clearance slips (school fees clearance receipt, accommodation,
  // library, alumni) are issued by the system and attached automatically, so Security
  // only needs the School ID card.
  security: [
    { name: 'School ID card' },
  ],
  letter: [
    { name: 'Graduation list', description: 'The official graduation list (PDF) showing your name, or a clear photo of the page your name is on.' },
  ],
  // Convocation has nothing to upload: the fee is paid online (Paystack standing in for
  // Remita) and the system's payment record and Convocation Fee Receipt are the proof.
};

// One account per central office role. Departmental and faculty officers are
// generated per department / faculty by the seed script.
export const CENTRAL_STAFF = [
  { role: 'library', full_name: 'Library Clearance Officer', email: 'library@clearance.test' },
  { role: 'alumni', full_name: 'Alumni Office Officer', email: 'alumni@clearance.test' },
  { role: 'student_affairs', full_name: "Students' Affairs Officer", email: 'studentaffairs@clearance.test' },
  { role: 'security', full_name: 'Security Clearance Officer', email: 'security@clearance.test' },
  { role: 'audit', full_name: 'Audit Unit Officer', email: 'audit@clearance.test' },
  { role: 'registry', full_name: 'Registry Officer', email: 'registry@clearance.test' },
];
