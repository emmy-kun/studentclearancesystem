// Admin operations (spec section 7, Admin). Every change is audit-logged.
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import pool from '../config/db.js';
import httpError from '../utils/httpError.js';
import { logAudit } from './auditLog.js';

const STAFF_ROLES = ['departmental', 'faculty', 'library', 'alumni', 'student_affairs', 'security', 'audit', 'registry', 'admin'];
const APPLIES_IF = ['always', 'off_campus', 'library_registered', 'library_not_registered'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE_SIZE = 50;

const clean = (v, max = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const page = (p) => Math.max(1, Number.parseInt(p, 10) || 1);
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function dashboard() {
  const [[students]] = await pool.query('SELECT COUNT(*) AS total, SUM(password_hash IS NOT NULL) AS registered FROM students');
  const [[requests]] = await pool.query("SELECT COUNT(*) AS total, SUM(status = 'completed') AS completed, SUM(status = 'in_progress') AS in_progress FROM clearance_requests");
  const [[payments]] = await pool.query("SELECT COALESCE(SUM(amount), 0) AS collected, COUNT(*) AS count FROM payments WHERE status = 'success'");
  const [stages] = await pool.query(
    `SELECT ws.stage_key, ws.name, ws.sequence_order, ws.review_mode,
            SUM(cs.status = 'locked') AS locked,
            SUM(cs.status = 'awaiting_submission') AS awaiting_submission,
            SUM(cs.status = 'pending') AS pending,
            SUM(cs.status = 'rejected') AS rejected,
            SUM(cs.status = 'approved') AS approved,
            AVG(CASE WHEN cs.status = 'approved' AND cs.reviewed_at IS NOT NULL AND cs.submitted_at IS NOT NULL
                     THEN TIMESTAMPDIFF(MINUTE, cs.submitted_at, cs.reviewed_at) END) AS avg_review_minutes,
            AVG(CASE WHEN cs.status = 'approved' AND cs.reviewed_at IS NOT NULL AND cs.unlocked_at IS NOT NULL
                     THEN TIMESTAMPDIFF(MINUTE, cs.unlocked_at, cs.reviewed_at) END) AS avg_total_minutes
       FROM workflow_stages ws
       LEFT JOIN clearance_stages cs ON cs.stage_key = ws.stage_key
      GROUP BY ws.stage_key, ws.name, ws.sequence_order, ws.review_mode
      ORDER BY ws.sequence_order`
  );
  const byStage = stages.map((s) => ({
    stage_key: s.stage_key,
    name: s.name,
    review_mode: s.review_mode,
    locked: Number(s.locked || 0),
    awaiting_submission: Number(s.awaiting_submission || 0),
    pending: Number(s.pending || 0),
    rejected: Number(s.rejected || 0),
    approved: Number(s.approved || 0),
    avg_review_hours: s.avg_review_minutes === null ? null : Math.round((Number(s.avg_review_minutes) / 60) * 10) / 10,
    avg_total_hours: s.avg_total_minutes === null ? null : Math.round((Number(s.avg_total_minutes) / 60) * 10) / 10,
  }));
  // Bottleneck: the manual stage with the most files waiting for the office; ties broken by slower review.
  const manual = byStage.filter((s) => s.review_mode === 'manual');
  const bottleneck = [...manual].sort((a, b) => b.pending - a.pending || (b.avg_review_hours ?? 0) - (a.avg_review_hours ?? 0))[0];

  const [byDepartment] = await pool.query(
    `SELECT d.name AS department, COUNT(DISTINCT s.student_id) AS students, COUNT(DISTINCT cr.request_id) AS started,
            COUNT(DISTINCT CASE WHEN cr.status = 'completed' THEN cr.request_id END) AS completed
       FROM departments d
       JOIN students s ON s.department_id = d.department_id
       LEFT JOIN clearance_requests cr ON cr.student_id = s.student_id
      GROUP BY d.department_id, d.name ORDER BY students DESC`
  );

  const total = Number(requests.total || 0);
  const completed = Number(requests.completed || 0);
  return {
    students: { total: Number(students.total || 0), registered: Number(students.registered || 0) },
    requests: { total, completed, in_progress: Number(requests.in_progress || 0), completion_rate: total ? Math.round((completed / total) * 1000) / 10 : 0 },
    payments: { collected: Number(payments.collected), count: Number(payments.count) },
    stages: byStage,
    bottleneck: bottleneck && bottleneck.pending > 0 ? { stage_key: bottleneck.stage_key, name: bottleneck.name, pending: bottleneck.pending, avg_review_hours: bottleneck.avg_review_hours } : null,
    departments: byDepartment.map((d) => ({ ...d, students: Number(d.students), started: Number(d.started), completed: Number(d.completed) })),
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export async function listRequests({ status, department_id, search, page: p }) {
  const where = ['TRUE'];
  const params = [];
  if (status === 'completed' || status === 'in_progress') {
    where.push('cr.status = ?');
    params.push(status);
  }
  if (department_id) {
    where.push('s.department_id = ?');
    params.push(Number(department_id));
  }
  if (search) {
    where.push('(s.full_name LIKE ? OR s.matric_no LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const offset = (page(p) - 1) * PAGE_SIZE;
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM clearance_requests cr JOIN students s ON s.student_id = cr.student_id WHERE ${where.join(' AND ')}`,
    params
  );
  const [items] = await pool.query(
    `SELECT cr.request_id, cr.session, cr.status, cr.initiated_at, cr.completed_at,
            s.student_id, s.full_name, s.matric_no, d.name AS department,
            (SELECT COUNT(*) FROM clearance_stages x WHERE x.request_id = cr.request_id AND x.status = 'approved') AS approved,
            (SELECT COUNT(*) FROM clearance_stages x WHERE x.request_id = cr.request_id) AS total_stages,
            (SELECT ws.name FROM clearance_stages x JOIN workflow_stages ws ON ws.stage_key = x.stage_key
              WHERE x.request_id = cr.request_id AND x.status IN ('pending','awaiting_submission','rejected')
              ORDER BY FIELD(x.status, 'pending', 'rejected', 'awaiting_submission'), ws.sequence_order LIMIT 1) AS current_stage,
            (SELECT x.status FROM clearance_stages x JOIN workflow_stages ws ON ws.stage_key = x.stage_key
              WHERE x.request_id = cr.request_id AND x.status IN ('pending','awaiting_submission','rejected')
              ORDER BY FIELD(x.status, 'pending', 'rejected', 'awaiting_submission'), ws.sequence_order LIMIT 1) AS current_status,
            (SELECT x.stage_id FROM clearance_stages x JOIN workflow_stages ws ON ws.stage_key = x.stage_key
              WHERE x.request_id = cr.request_id AND x.status IN ('pending','awaiting_submission','rejected')
              ORDER BY FIELD(x.status, 'pending', 'rejected', 'awaiting_submission'), ws.sequence_order LIMIT 1) AS current_stage_id
       FROM clearance_requests cr
       JOIN students s ON s.student_id = cr.student_id
       JOIN departments d ON d.department_id = s.department_id
      WHERE ${where.join(' AND ')}
      ORDER BY cr.initiated_at DESC
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );
  return { items, total: Number(total), page: page(p), page_size: PAGE_SIZE };
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

export async function listStudents({ search, department_id, page: p }) {
  const where = ['TRUE'];
  const params = [];
  if (department_id) {
    where.push('s.department_id = ?');
    params.push(Number(department_id));
  }
  if (search) {
    where.push('(s.full_name LIKE ? OR s.matric_no LIKE ? OR s.email LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const offset = (page(p) - 1) * PAGE_SIZE;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM students s WHERE ${where.join(' AND ')}`, params);
  const [items] = await pool.query(
    `SELECT s.student_id, s.matric_no, s.full_name, s.email, s.levels_count, s.graduation_session,
            s.registered_at, d.department_id, d.name AS department,
            (SELECT cr.status FROM clearance_requests cr WHERE cr.student_id = s.student_id ORDER BY cr.initiated_at DESC LIMIT 1) AS request_status
       FROM students s JOIN departments d ON d.department_id = s.department_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.full_name
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );
  return { items: items.map((i) => ({ ...i, registered: Boolean(i.registered_at) })), total: Number(total), page: page(p), page_size: PAGE_SIZE };
}

/** Correct a student record (email typo, levels). */
export async function updateStudent(adminId, studentId, body) {
  const changes = {};
  if (body.email !== undefined) {
    const email = clean(body.email, 100).toLowerCase();
    if (!EMAIL.test(email)) throw httpError(400, 'Enter a valid email address');
    const [[taken]] = await pool.query('SELECT student_id FROM students WHERE email = ? AND student_id <> ?', [email, studentId]);
    if (taken) throw httpError(409, 'Another student already uses this email');
    changes.email = email;
  }
  if (body.levels_count !== undefined) {
    const n = Number(body.levels_count);
    if (![4, 5].includes(n)) throw httpError(400, 'levels_count must be 4 or 5');
    changes.levels_count = n;
  }
  if (body.phone !== undefined) changes.phone = clean(body.phone, 20) || null;
  if (!Object.keys(changes).length) throw httpError(400, 'Nothing to update');
  const [res] = await pool.query('UPDATE students SET ? WHERE student_id = ?', [changes, studentId]);
  if (!res.affectedRows) throw httpError(404, 'Student not found');
  await logAudit({ actorType: 'staff', actorId: adminId, action: 'student.update', entity: 'student', entityId: studentId, detail: changes });
}

/** Clear a student's account so they can sign up again (e.g. someone else signed up as them). */
export async function resetStudentAccount(adminId, studentId) {
  const [res] = await pool.query('UPDATE students SET password_hash = NULL, registered_at = NULL WHERE student_id = ?', [studentId]);
  if (!res.affectedRows) throw httpError(404, 'Student not found');
  await logAudit({ actorType: 'staff', actorId: adminId, action: 'student.account_reset', entity: 'student', entityId: studentId });
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export async function listStaff() {
  const [rows] = await pool.query(
    `SELECT s.staff_id, s.full_name, s.email, s.role, s.department_id, d.name AS department, s.faculty_id, f.name AS faculty,
            s.is_active, s.must_change_password, s.created_at
       FROM staff s
       LEFT JOIN departments d ON d.department_id = s.department_id
       LEFT JOIN faculties f ON f.faculty_id = s.faculty_id
      ORDER BY FIELD(s.role, 'admin','audit','registry','departmental','faculty','library','alumni','student_affairs','security'), s.full_name`
  );
  return rows.map((r) => ({ ...r, is_active: Boolean(r.is_active), must_change_password: Boolean(r.must_change_password) }));
}

/** Role rules: departmental needs a department, faculty needs a faculty, others neither. */
async function staffScope(db, role, departmentId, facultyId) {
  if (!STAFF_ROLES.includes(role)) throw httpError(400, 'Choose a valid role');
  if (role === 'departmental') {
    const [[d]] = await db.query('SELECT department_id FROM departments WHERE department_id = ?', [Number(departmentId) || 0]);
    if (!d) throw httpError(400, 'Choose the department this officer clears');
    return { department_id: d.department_id, faculty_id: null };
  }
  if (role === 'faculty') {
    const [[f]] = await db.query('SELECT faculty_id FROM faculties WHERE faculty_id = ?', [Number(facultyId) || 0]);
    if (!f) throw httpError(400, 'Choose the faculty this officer clears');
    return { department_id: null, faculty_id: f.faculty_id };
  }
  return { department_id: null, faculty_id: null };
}

export async function createStaff(adminId, body) {
  const full_name = clean(body.full_name, 100);
  const email = clean(body.email, 100).toLowerCase();
  if (!full_name) throw httpError(400, 'Enter the staff member’s name');
  if (!EMAIL.test(email)) throw httpError(400, 'Enter a valid email address');
  const scope = await staffScope(pool, body.role, body.department_id, body.faculty_id);
  const [[taken]] = await pool.query('SELECT staff_id FROM staff WHERE email = ?', [email]);
  if (taken) throw httpError(409, 'A staff account with this email already exists');

  const password = tempPassword();
  const [res] = await pool.query(
    `INSERT INTO staff (full_name, email, role, department_id, faculty_id, password_hash, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
    [full_name, email, body.role, scope.department_id, scope.faculty_id, await bcrypt.hash(password, 10)]
  );
  await logAudit({ actorType: 'staff', actorId: adminId, action: 'staff.create', entity: 'staff', entityId: res.insertId, detail: { email, role: body.role, ...scope } });
  return { staff_id: res.insertId, temporary_password: password };
}

export async function updateStaff(adminId, staffId, body) {
  const [[current]] = await pool.query('SELECT staff_id, role, department_id, faculty_id, is_active FROM staff WHERE staff_id = ?', [staffId]);
  if (!current) throw httpError(404, 'Staff member not found');
  const changes = {};
  if (body.full_name !== undefined) {
    changes.full_name = clean(body.full_name, 100);
    if (!changes.full_name) throw httpError(400, 'Name cannot be empty');
  }
  if (body.role !== undefined || body.department_id !== undefined || body.faculty_id !== undefined) {
    const role = body.role ?? current.role;
    if (staffId === adminId && role !== 'admin') throw httpError(400, 'You cannot remove your own admin role');
    Object.assign(changes, { role }, await staffScope(pool, role, body.department_id ?? current.department_id, body.faculty_id ?? current.faculty_id));
  }
  if (body.is_active !== undefined) {
    if (staffId === adminId && !bool(body.is_active)) throw httpError(400, 'You cannot deactivate your own account');
    changes.is_active = bool(body.is_active);
  }
  if (!Object.keys(changes).length) throw httpError(400, 'Nothing to update');
  await pool.query('UPDATE staff SET ? WHERE staff_id = ?', [changes, staffId]);
  const action = changes.is_active === false ? 'staff.deactivate' : changes.is_active === true && !current.is_active ? 'staff.activate' : 'staff.update';
  await logAudit({ actorType: 'staff', actorId: adminId, action, entity: 'staff', entityId: staffId, detail: changes });
}

export async function resetStaffPassword(adminId, staffId) {
  const password = tempPassword();
  const [res] = await pool.query('UPDATE staff SET password_hash = ?, must_change_password = TRUE WHERE staff_id = ?', [await bcrypt.hash(password, 10), staffId]);
  if (!res.affectedRows) throw httpError(404, 'Staff member not found');
  await logAudit({ actorType: 'staff', actorId: adminId, action: 'staff.password_reset', entity: 'staff', entityId: staffId });
  return { temporary_password: password };
}

// ---------------------------------------------------------------------------
// Faculties and departments
// ---------------------------------------------------------------------------

export async function listStructure() {
  const [faculties] = await pool.query('SELECT faculty_id, name FROM faculties ORDER BY name');
  const [departments] = await pool.query(
    `SELECT d.department_id, d.faculty_id, d.name,
            (SELECT COUNT(*) FROM students s WHERE s.department_id = d.department_id) AS students
       FROM departments d ORDER BY d.name`
  );
  return faculties.map((f) => ({ ...f, departments: departments.filter((d) => d.faculty_id === f.faculty_id).map((d) => ({ ...d, students: Number(d.students) })) }));
}

const dupToConflict = (msg) => (err) => {
  if (err.code === 'ER_DUP_ENTRY') throw httpError(409, msg);
  if (err.code === 'ER_ROW_IS_REFERENCED_2') throw httpError(409, 'It is still in use, so it cannot be deleted');
  throw err;
};

export async function saveFaculty(adminId, facultyId, body) {
  const name = clean(body.name, 100);
  if (!name) throw httpError(400, 'Enter the faculty name');
  if (facultyId) {
    const [res] = await pool.query('UPDATE faculties SET name = ? WHERE faculty_id = ?', [name, facultyId]).catch(dupToConflict('That faculty already exists'));
    if (!res.affectedRows) throw httpError(404, 'Faculty not found');
  } else {
    [{ insertId: facultyId }] = await pool.query('INSERT INTO faculties (name) VALUES (?)', [name]).catch(dupToConflict('That faculty already exists'));
  }
  await logAudit({ actorType: 'staff', actorId: adminId, action: 'faculty.save', entity: 'faculty', entityId: facultyId, detail: { name } });
  return { faculty_id: facultyId };
}

export async function saveDepartment(adminId, departmentId, body) {
  const name = clean(body.name, 100);
  if (!name) throw httpError(400, 'Enter the department name');
  const [[f]] = await pool.query('SELECT faculty_id FROM faculties WHERE faculty_id = ?', [Number(body.faculty_id) || 0]);
  if (!f) throw httpError(400, 'Choose the faculty');
  if (departmentId) {
    const [res] = await pool.query('UPDATE departments SET name = ?, faculty_id = ? WHERE department_id = ?', [name, f.faculty_id, departmentId]).catch(dupToConflict('That department already exists in this faculty'));
    if (!res.affectedRows) throw httpError(404, 'Department not found');
  } else {
    [{ insertId: departmentId }] = await pool.query('INSERT INTO departments (faculty_id, name) VALUES (?, ?)', [f.faculty_id, name]).catch(dupToConflict('That department already exists in this faculty'));
  }
  await logAudit({ actorType: 'staff', actorId: adminId, action: 'department.save', entity: 'department', entityId: departmentId, detail: { name, faculty_id: f.faculty_id } });
  return { department_id: departmentId };
}

export async function deleteDepartment(adminId, departmentId) {
  const [res] = await pool.query('DELETE FROM departments WHERE department_id = ?', [departmentId]).catch(dupToConflict(''));
  if (!res.affectedRows) throw httpError(404, 'Department not found');
  await logAudit({ actorType: 'staff', actorId: adminId, action: 'department.delete', entity: 'department', entityId: departmentId });
}

// ---------------------------------------------------------------------------
// Required documents
// ---------------------------------------------------------------------------

export async function listRequiredDocuments() {
  const [stages] = await pool.query('SELECT stage_key, name, sequence_order FROM workflow_stages ORDER BY sequence_order');
  const [docs] = await pool.query(
    `SELECT rd.*, (SELECT COUNT(*) FROM stage_documents sd WHERE sd.required_doc_id = rd.required_doc_id) AS uploads
       FROM required_documents rd ORDER BY rd.display_order, rd.required_doc_id`
  );
  const shape = (d) => ({ ...d, per_level: Boolean(d.per_level), collects_amount: Boolean(d.collects_amount), collects_date: Boolean(d.collects_date), check_identity: Boolean(d.check_identity), is_required: Boolean(d.is_required), uploads: Number(d.uploads) });
  return stages.map((s) => ({ ...s, documents: docs.filter((d) => d.stage_key === s.stage_key).map(shape) }));
}

async function documentFields(body, existing = {}) {
  const v = { ...existing, ...body };
  const out = {
    stage_key: clean(v.stage_key, 30),
    name: clean(v.name, 120),
    description: clean(v.description, 255) || null,
    per_level: bool(v.per_level),
    applies_if: v.applies_if || 'always',
    reference_label: clean(v.reference_label, 60) || null,
    collects_amount: bool(v.collects_amount),
    collects_date: bool(v.collects_date),
    check_identity: v.check_identity === undefined ? true : bool(v.check_identity),
    is_required: v.is_required === undefined ? true : bool(v.is_required),
    display_order: Math.min(Math.max(Number.parseInt(v.display_order, 10) || 0, 0), 100),
  };
  if (!out.name) throw httpError(400, 'Enter the document name');
  if (!APPLIES_IF.includes(out.applies_if)) throw httpError(400, 'Invalid "applies if" value');
  const [[stage]] = await pool.query('SELECT stage_key FROM workflow_stages WHERE stage_key = ?', [out.stage_key]);
  if (!stage) throw httpError(400, 'Choose a valid stage');
  return out;
}

export async function saveRequiredDocument(adminId, docId, body) {
  if (docId) {
    const [[existing]] = await pool.query('SELECT * FROM required_documents WHERE required_doc_id = ?', [docId]);
    if (!existing) throw httpError(404, 'Document not found');
    const fields = await documentFields(body, existing);
    delete fields.stage_key; // moving a document between stages would orphan uploads
    await pool.query('UPDATE required_documents SET ? WHERE required_doc_id = ?', [fields, docId]);
  } else {
    const fields = await documentFields(body);
    [{ insertId: docId }] = await pool.query('INSERT INTO required_documents SET ?', [fields]);
  }
  await logAudit({ actorType: 'staff', actorId: adminId, action: 'required_document.save', entity: 'required_document', entityId: docId, detail: body });
  return { required_doc_id: docId };
}

export async function deleteRequiredDocument(adminId, docId) {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM stage_documents WHERE required_doc_id = ?', [docId]);
  if (n > 0) throw httpError(409, `Students have already uploaded ${n} ${n === 1 ? 'file' : 'files'} for this document. Mark it optional instead of deleting it.`);
  const [res] = await pool.query('DELETE FROM required_documents WHERE required_doc_id = ?', [docId]);
  if (!res.affectedRows) throw httpError(404, 'Document not found');
  await logAudit({ actorType: 'staff', actorId: adminId, action: 'required_document.delete', entity: 'required_document', entityId: docId });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function listAuditLogs({ action, entity, page: p }) {
  const where = ['TRUE'];
  const params = [];
  if (action) {
    where.push('l.action LIKE ?');
    params.push(`${clean(action, 60)}%`);
  }
  if (entity) {
    where.push('l.entity = ?');
    params.push(clean(entity, 40));
  }
  const offset = (page(p) - 1) * PAGE_SIZE;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_logs l WHERE ${where.join(' AND ')}`, params);
  const [items] = await pool.query(
    `SELECT l.log_id, l.actor_type, l.actor_id, l.action, l.entity, l.entity_id, l.detail, l.created_at,
            CASE l.actor_type
              WHEN 'staff' THEN (SELECT full_name FROM staff WHERE staff_id = l.actor_id)
              WHEN 'student' THEN (SELECT CONCAT(full_name, ' (', matric_no, ')') FROM students WHERE student_id = l.actor_id)
              ELSE 'System' END AS actor_name
       FROM audit_logs l WHERE ${where.join(' AND ')}
      ORDER BY l.log_id DESC LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );
  return { items, total: Number(total), page: page(p), page_size: PAGE_SIZE };
}
