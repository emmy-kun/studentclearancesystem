// Unit tests for the role/scope rule (no database needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope } from '../src/middleware/requireRole.js';
import { maskName } from '../src/routes/auth.js';

test('lookup names are masked to surname + initials', () => {
  assert.equal(maskName('ABAH PRECIOUS CHINEMEREM'), 'ABAH P. C.');
  assert.equal(maskName('  AGWU   CHIEDOZIE '), 'AGWU C.');
  assert.equal(maskName('ADISAMUELUNIMKE'), 'ADISAMUELUNIMKE');
});

const csStudent = { student_id: 10, department_id: 1, faculty_id: 1 };
const engStudent = { student_id: 11, department_id: 7, faculty_id: 2 };

test('departmental officer sees only their own department', () => {
  const officer = { role: 'departmental', department_id: 1, faculty_id: null };
  assert.equal(inScope(officer, csStudent), true);
  assert.equal(inScope(officer, engStudent), false);
});

test('departmental officer with no department sees nobody', () => {
  assert.equal(inScope({ role: 'departmental', department_id: null }, csStudent), false);
});

test('faculty officer sees only departments in their faculty', () => {
  const officer = { role: 'faculty', department_id: null, faculty_id: 1 };
  assert.equal(inScope(officer, csStudent), true);
  assert.equal(inScope(officer, engStudent), false);
});

test('central offices, audit and admin see all students', () => {
  for (const role of ['library', 'alumni', 'student_affairs', 'security', 'audit', 'admin']) {
    assert.equal(inScope({ role }, csStudent), true, role);
    assert.equal(inScope({ role }, engStudent), true, role);
  }
});

test('a student sees only themselves', () => {
  assert.equal(inScope({ role: 'student', sub: 10 }, csStudent), true);
  assert.equal(inScope({ role: 'student', sub: 10 }, engStudent), false);
});

test('unknown roles see nobody', () => {
  assert.equal(inScope({ role: 'bursary' }, csStudent), false);
});
