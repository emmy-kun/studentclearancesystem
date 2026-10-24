// Student class-list importer (build step 2).
//
// CSV columns (header row required, order free):
//   required: matric_no, full_name, email, department, faculty
//   optional: levels_count (4|5, default 4), admission_year, graduation_session,
//             accommodation_type (on_campus|off_campus), phone
//
// All rows are validated first; valid rows are then inserted in one transaction,
// creating any missing faculties/departments. Rows whose matric number or email
// already exists are skipped (never overwritten). Every run is recorded in
// import_batches and audit_logs.
//
// CLI: node src/db/importStudents.js <file.csv>   (recorded as imported by the first Admin)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import pool, { withTransaction } from '../config/db.js';

const REQUIRED = ['matric_no', 'full_name', 'email', 'department', 'faculty'];
// Plain names for messages shown to the administrator.
const LABEL = { matric_no: 'reg number', full_name: 'full name', email: 'email', department: 'department', faculty: 'faculty' };
const MATRIC = /^\d{4}\/\d{5,7}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION = /^\d{4}\/\d{4}$/;

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function validateRow(raw, rowNo) {
  const errors = [];
  const warnings = [];
  const r = {
    matric_no: squash(raw.matric_no),
    full_name: squash(raw.full_name),
    email: squash(raw.email).toLowerCase(),
    department: squash(raw.department),
    faculty: squash(raw.faculty),
    levels_count: raw.levels_count ? Number(raw.levels_count) : 4,
    admission_year: raw.admission_year ? Number(raw.admission_year) : null,
    graduation_session: squash(raw.graduation_session) || null,
    accommodation_type: squash(raw.accommodation_type) || 'on_campus',
    phone: squash(raw.phone) || null,
  };

  for (const f of REQUIRED) if (!r[f]) errors.push(`${LABEL[f]} is missing`);
  if (r.matric_no && !MATRIC.test(r.matric_no)) errors.push(`reg number "${r.matric_no}" should look like 2022/123456`);
  else if (r.matric_no && !/^\d{4}\/\d{6}$/.test(r.matric_no)) warnings.push(`reg number "${r.matric_no}" does not have 6 digits after the slash`);
  if (r.email && !EMAIL.test(r.email)) errors.push(`email "${r.email}" is invalid`);
  if (![4, 5].includes(r.levels_count)) errors.push('number of years must be 4 or 5');
  if (r.admission_year !== null && !(r.admission_year >= 1960 && r.admission_year <= 2100)) errors.push('admission year is not a valid year');
  if (r.graduation_session && !SESSION.test(r.graduation_session)) errors.push('graduation session should look like 2025/2026');
  if (!['on_campus', 'off_campus'].includes(r.accommodation_type)) errors.push('accommodation should be on_campus or off_campus');
  if (r.full_name && !r.full_name.includes(' ')) warnings.push(`name "${r.full_name}" has no spaces (the names may be run together in the list)`);

  return { rowNo, data: r, errors, warnings };
}

/**
 * Import students from CSV text.
 * @returns report { batch_id, rows_total, rows_imported, rows_skipped, rows_failed, faculties_created, departments_created, failed[], skipped[], warnings[] }
 */
export async function importStudents(csvText, { importedBy, filename = null }) {
  let records;
  try {
    records = parse(csvText, { columns: (h) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    const e = new Error('Could not read the file. Make sure it is saved as CSV.');
    e.status = 400;
    e.expose = true;
    throw e;
  }
  if (records.length === 0) {
    const e = new Error('The file has no student rows');
    e.status = 400;
    e.expose = true;
    throw e;
  }
  const missingCols = REQUIRED.filter((c) => !(c in records[0]));
  if (missingCols.length) {
    const e = new Error(`The file is missing these columns: ${missingCols.join(', ')}. Download the template to see the expected headings.`);
    e.status = 400;
    e.expose = true;
    throw e;
  }

  // Row numbers count the header as row 1, matching what a spreadsheet shows.
  const checked = records.map((raw, i) => validateRow(raw, i + 2));

  const failed = [];
  const skipped = [];
  const warnings = [];
  const valid = [];
  const seenMatric = new Map();
  const seenEmail = new Map();

  // Existing records, so re-imports skip rather than fail on the unique keys.
  const [existing] = await pool.query('SELECT LOWER(matric_no) AS m, LOWER(email) AS e FROM students');
  const dbMatric = new Set(existing.map((x) => x.m));
  const dbEmail = new Set(existing.map((x) => x.e));

  for (const row of checked) {
    const { rowNo, data } = row;
    const label = `${data.matric_no || '?'} ${data.full_name || ''}`.trim();
    for (const w of row.warnings) warnings.push({ row: rowNo, student: label, message: w });

    if (row.errors.length) {
      failed.push({ row: rowNo, student: label, reason: row.errors.join('; ') });
      continue;
    }
    const mKey = data.matric_no.toLowerCase();
    const eKey = data.email;
    if (seenMatric.has(mKey)) {
      failed.push({ row: rowNo, student: label, reason: `same reg number as row ${seenMatric.get(mKey)}` });
      continue;
    }
    if (seenEmail.has(eKey)) {
      failed.push({ row: rowNo, student: label, reason: `same email as row ${seenEmail.get(eKey)}` });
      continue;
    }
    seenMatric.set(mKey, rowNo);
    seenEmail.set(eKey, rowNo);

    if (dbMatric.has(mKey) || dbEmail.has(eKey)) {
      skipped.push({ row: rowNo, student: label, reason: dbMatric.has(mKey) ? 'already on the system' : 'email already used by another student' });
      continue;
    }
    valid.push(row);
  }

  const result = await withTransaction(async (conn) => {
    const facultyIds = new Map();
    const deptIds = new Map();
    let facultiesCreated = 0;
    let departmentsCreated = 0;

    async function facultyId(name) {
      const key = name.toLowerCase();
      if (facultyIds.has(key)) return facultyIds.get(key);
      const [[found]] = await conn.query('SELECT faculty_id FROM faculties WHERE name = ?', [name]);
      let id = found?.faculty_id;
      if (!id) {
        [{ insertId: id }] = await conn.query('INSERT INTO faculties (name) VALUES (?)', [name]);
        facultiesCreated++;
      }
      facultyIds.set(key, id);
      return id;
    }

    async function departmentId(name, facultyName) {
      const fId = await facultyId(facultyName);
      const key = `${fId}|${name.toLowerCase()}`;
      if (deptIds.has(key)) return deptIds.get(key);
      const [[found]] = await conn.query('SELECT department_id FROM departments WHERE faculty_id = ? AND name = ?', [fId, name]);
      let id = found?.department_id;
      if (!id) {
        [{ insertId: id }] = await conn.query('INSERT INTO departments (faculty_id, name) VALUES (?, ?)', [fId, name]);
        departmentsCreated++;
      }
      deptIds.set(key, id);
      return id;
    }

    for (const { data: d } of valid) {
      const deptId = await departmentId(d.department, d.faculty);
      await conn.query(
        `INSERT INTO students
           (matric_no, full_name, email, department_id, levels_count, admission_year,
            graduation_session, accommodation_type, phone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.matric_no, d.full_name, d.email, deptId, d.levels_count, d.admission_year, d.graduation_session, d.accommodation_type, d.phone]
      );
    }

    const rowsFailed = failed.length + skipped.length;
    const [{ insertId: batchId }] = await conn.query(
      `INSERT INTO import_batches (imported_by, filename, rows_total, rows_imported, rows_failed)
       VALUES (?, ?, ?, ?, ?)`,
      [importedBy, filename, checked.length, valid.length, rowsFailed]
    );
    await conn.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity, entity_id, detail)
       VALUES ('staff', ?, 'students.import', 'import_batch', ?, ?)`,
      [importedBy, batchId, JSON.stringify({ filename, rows_total: checked.length, rows_imported: valid.length, rows_skipped: skipped.length, rows_failed: failed.length, faculties_created: facultiesCreated, departments_created: departmentsCreated })]
    );

    return { batchId, facultiesCreated, departmentsCreated };
  });

  return {
    batch_id: result.batchId,
    rows_total: checked.length,
    rows_imported: valid.length,
    rows_skipped: skipped.length,
    rows_failed: failed.length,
    faculties_created: result.facultiesCreated,
    departments_created: result.departmentsCreated,
    failed,
    skipped,
    warnings,
  };
}

// ---- CLI ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/db/importStudents.js <file.csv>');
    process.exit(1);
  }
  (async () => {
    const [[admin]] = await pool.query("SELECT staff_id FROM staff WHERE role = 'admin' AND is_active = TRUE ORDER BY staff_id LIMIT 1");
    if (!admin) throw new Error('No active Admin found. Run npm run db:seed first.');
    const report = await importStudents(fs.readFileSync(file, 'utf8'), { importedBy: admin.staff_id, filename: path.basename(file) });

    console.log(`Import batch #${report.batch_id}`);
    console.log(`  rows: ${report.rows_total}, imported: ${report.rows_imported}, skipped: ${report.rows_skipped}, failed: ${report.rows_failed}`);
    console.log(`  faculties created: ${report.faculties_created}, departments created: ${report.departments_created}`);
    if (report.failed.length) {
      console.log('\nFailed rows:');
      console.table(report.failed);
    }
    if (report.skipped.length) {
      console.log(`\nSkipped rows: ${report.skipped.length} (already in the database)`);
      if (report.skipped.length <= 20) console.table(report.skipped);
    }
    if (report.warnings.length) {
      console.log(`\nWarnings: ${report.warnings.length} (rows were still imported)`);
      console.table(report.warnings);
    }
  })()
    .catch((err) => {
      console.error('Import failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
