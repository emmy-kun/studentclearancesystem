// Seeds reference data and test staff accounts. Safe to re-run:
//  - faculties/departments: inserted if missing
//  - workflow_stages: upserted (keeps the agreed config in sync)
//  - required_documents: inserted only for stages that have none (keeps Admin edits)
//  - staff: created only if the email does not exist; new passwords are printed once
// Run again after importing the class list to create officers for new departments.
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import pool, { withTransaction } from '../config/db.js';
import env from '../config/env.js';
import { FACULTIES, WORKFLOW_STAGES, REQUIRED_DOCUMENTS, CENTRAL_STAFF } from './seedData.js';

const BCRYPT_ROUNDS = 10;

function randomPassword() {
  // 12 chars, no ambiguous characters
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
}

async function seedFaculties(conn) {
  for (const [faculty, departments] of Object.entries(FACULTIES)) {
    await conn.query('INSERT IGNORE INTO faculties (name) VALUES (?)', [faculty]);
    const [[{ faculty_id }]] = await conn.query('SELECT faculty_id FROM faculties WHERE name = ?', [faculty]);
    for (const dept of departments) {
      await conn.query('INSERT IGNORE INTO departments (faculty_id, name) VALUES (?, ?)', [faculty_id, dept]);
    }
  }
}

async function seedWorkflowStages(conn) {
  for (const s of WORKFLOW_STAGES) {
    await conn.query(
      `INSERT INTO workflow_stages
         (stage_key, name, reviewer_role, sequence_order, unlock_rule, review_mode, fee_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), reviewer_role = VALUES(reviewer_role),
         unlock_rule = VALUES(unlock_rule), review_mode = VALUES(review_mode), fee_amount = VALUES(fee_amount)`,
      [s.stage_key, s.name, s.reviewer_role, s.sequence_order, s.unlock_rule, s.review_mode, s.fee_amount]
    );
  }
}

async function seedRequiredDocuments(conn) {
  for (const [stageKey, docs] of Object.entries(REQUIRED_DOCUMENTS)) {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM required_documents WHERE stage_key = ?', [stageKey]);
    if (n > 0) continue;
    for (const [i, d] of docs.entries()) {
      await conn.query(
        `INSERT INTO required_documents
           (stage_key, name, description, per_level, applies_if, reference_label, collects_amount, collects_date, check_identity, is_required, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stageKey, d.name, d.description ?? null, d.per_level ?? false, d.applies_if ?? 'always',
          d.reference_label ?? null, d.collects_amount ?? false, d.collects_date ?? false, d.check_identity ?? true, d.is_required ?? true, i + 1]
      );
    }
  }
}

async function createStaff(conn, created, { full_name, email, role, department_id = null, faculty_id = null, password }) {
  const [[existing]] = await conn.query('SELECT staff_id FROM staff WHERE email = ?', [email]);
  if (existing) return;
  const plain = password || randomPassword();
  const hash = await bcrypt.hash(plain, BCRYPT_ROUNDS);
  const [res] = await conn.query(
    `INSERT INTO staff (full_name, email, role, department_id, faculty_id, password_hash, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
    [full_name, email, role, department_id, faculty_id, hash]
  );
  await conn.query(
    `INSERT INTO audit_logs (actor_type, action, entity, entity_id, detail)
     VALUES ('system', 'staff.create', 'staff', ?, ?)`,
    [res.insertId, JSON.stringify({ email, role, department_id, faculty_id, source: 'seed' })]
  );
  created.push({ role, email, password: plain });
}

async function seedStaff(conn) {
  const created = [];

  await createStaff(conn, created, {
    full_name: 'System Administrator',
    email: env.admin.email,
    role: 'admin',
    password: env.admin.password,
  });

  for (const s of CENTRAL_STAFF) await createStaff(conn, created, s);

  const [faculties] = await conn.query('SELECT faculty_id, name FROM faculties ORDER BY name');
  for (const f of faculties) {
    await createStaff(conn, created, {
      full_name: `Faculty Officer, ${f.name}`,
      email: `faculty.${slug(f.name)}@clearance.test`,
      role: 'faculty',
      faculty_id: f.faculty_id,
    });
  }

  const [departments] = await conn.query('SELECT department_id, name FROM departments ORDER BY name');
  for (const d of departments) {
    await createStaff(conn, created, {
      full_name: `Departmental Clearance Officer, ${d.name}`,
      email: `dept.${slug(d.name)}@clearance.test`,
      role: 'departmental',
      department_id: d.department_id,
    });
  }

  return created;
}

async function main() {
  const created = await withTransaction(async (conn) => {
    await seedFaculties(conn);
    await seedWorkflowStages(conn);
    await seedRequiredDocuments(conn);
    return seedStaff(conn);
  });

  console.log('Seed complete.');
  if (created.length === 0) {
    console.log('No new staff accounts (all already exist).');
  } else {
    console.log('\nNew staff accounts (shown once; each must change password on first login):');
    console.table(created);
  }
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
