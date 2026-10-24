// Payment tests (build step 6) with a fake gateway in place of Paystack, so they
// are fast and repeatable. The webhook signature uses the real HMAC scheme.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { default: app } = await import('../src/app.js');
const { default: pool } = await import('../src/config/db.js');
const { default: env } = await import('../src/config/env.js');
const { signToken } = await import('../src/middleware/auth.js');
const { startRequest } = await import('../src/services/workflowEngine.js');
const { setGateway } = await import('../src/services/payments/index.js');
const paystack = await import('../src/services/payments/paystackGateway.js');

// ---- fake gateway: tests decide what "Paystack" reports for each reference ----
const fake = {
  name: 'fake',
  initialized: [],
  results: new Map(),
  verifyCalls: [],
  async initialize(args) {
    this.initialized.push(args);
    return { authorizationUrl: `https://checkout.test/${args.reference}`, accessCode: 'ac_test', reference: args.reference };
  },
  async verify(reference) {
    this.verifyCalls.push(reference);
    return this.results.get(reference) || { status: 'not_found', reference };
  },
  verifyWebhookSignature: paystack.verifyWebhookSignature,
  parseWebhook: paystack.parseWebhook,
};
const paid = (reference, amountMinor, extra = {}) => ({ status: 'success', amountMinor, currency: 'NGN', reference, raw: { reference, amount: amountMinor }, ...extra });

const MATRIC = '2022/249289';
const OTHER = '2022/241588';
const tok = {};
let server, base, studentId, convPayment;

async function api(method, p, { body, token } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function webhook(payload, { secret = env.paystack.secretKey, signature } = {}) {
  const raw = JSON.stringify(payload);
  const sig = signature ?? crypto.createHmac('sha512', secret).update(raw).digest('hex');
  return fetch(`${base}/payments/webhook/paystack`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': sig }, body: raw });
}

const mine = async () => (await api('GET', '/clearance/mine', { token: tok.student })).body;
const stageOf = (view, key) => view.stages.find((s) => s.stage_key === key);
const paymentRow = async (id) => (await pool.query('SELECT * FROM payments WHERE payment_id = ?', [id]))[0][0];
const auditCount = async (id, action) => (await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'payment' AND entity_id = ? AND action = ?", [id, action]))[0][0].n;

async function cleanup() {
  for (const matric of [MATRIC, OTHER]) {
    const [[s]] = await pool.query('SELECT student_id FROM students WHERE matric_no = ?', [matric]);
    const [reqs] = await pool.query('SELECT request_id FROM clearance_requests WHERE student_id = ?', [s.student_id]);
    for (const { request_id } of reqs) {
      await pool.query('DELETE sd FROM stage_documents sd JOIN clearance_stages cs ON cs.stage_id = sd.stage_id WHERE cs.request_id = ?', [request_id]);
      await pool.query('DELETE FROM payments WHERE request_id = ?', [request_id]);
      for (const sl of (await pool.query('SELECT sl.file_path FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [request_id]))[0]) fs.rmSync(path.join(env.uploads.dir, sl.file_path), { force: true });
      await pool.query('DELETE sl FROM clearance_slips sl JOIN clearance_stages cs ON cs.stage_id = sl.stage_id WHERE cs.request_id = ?', [request_id]);
      await pool.query('DELETE FROM clearance_stages WHERE request_id = ?', [request_id]);
      await pool.query('DELETE FROM clearance_requests WHERE request_id = ?', [request_id]);
    }
    await pool.query("DELETE FROM notifications WHERE recipient_type = 'student' AND recipient_id = ?", [s.student_id]);
  }
  await pool.query("DELETE n FROM notifications n JOIN staff s ON s.staff_id = n.recipient_id WHERE n.recipient_type = 'staff' AND s.email LIKE 'pay.test.%@clearance.test'");
  await pool.query("DELETE FROM staff WHERE email LIKE 'pay.test.%@clearance.test'");
}

before(async () => {
  setGateway(fake);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await cleanup();

  for (const [key, matric] of [['student', MATRIC], ['other', OTHER]]) {
    const [[s]] = await pool.query('SELECT s.student_id, s.department_id, d.faculty_id FROM students s JOIN departments d USING (department_id) WHERE matric_no = ?', [matric]);
    tok[key] = signToken({ sub: s.student_id, userType: 'student', role: 'student', department_id: s.department_id, faculty_id: s.faculty_id });
    await startRequest(s.student_id);
    if (key === 'student') studentId = s.student_id;
  }
  const [[cs]] = await pool.query("SELECT department_id FROM departments WHERE name = 'Computer Science'");
  for (const [key, role, dept] of [['dept', 'departmental', cs.department_id], ['library', 'library', null]]) {
    const [r] = await pool.query("INSERT INTO staff (full_name, email, role, department_id, password_hash, must_change_password) VALUES (?, ?, ?, ?, 'x', FALSE)", [`Pay Test ${key}`, `pay.test.${key}@clearance.test`, role, dept]);
    tok[key] = signToken({ sub: r.insertId, userType: 'staff', role, department_id: dept, faculty_id: null });
  }
  convPayment = stageOf(await mine(), 'convocation').payments[0];
});

after(async () => {
  setGateway();
  await cleanup();
  server.close();
  await pool.end();
});

test('only the owning student can start a payment', async () => {
  assert.equal((await api('POST', `/payments/${convPayment.payment_id}/initialize`, { token: tok.other })).status, 404);
  assert.equal((await api('POST', `/payments/${convPayment.payment_id}/initialize`, { token: tok.dept })).status, 403);
});

test('initialize sends kobo, the student email and a fresh reference to the gateway', async () => {
  const before = await paymentRow(convPayment.payment_id);
  const res = await api('POST', `/payments/${convPayment.payment_id}/initialize`, { token: tok.student });
  assert.equal(res.status, 200);
  const sent = fake.initialized.at(-1);
  assert.equal(sent.amountMinor, 1_000_000, 'N10,000 = 1,000,000 kobo');
  assert.equal(sent.currency, 'NGN');
  assert.equal(sent.callbackUrl, `${env.appBaseUrl}/payments/callback`);
  const [[s]] = await pool.query('SELECT email FROM students WHERE student_id = ?', [studentId]);
  assert.equal(sent.email, s.email);
  assert.equal(res.body.authorization_url, `https://checkout.test/${res.body.reference}`);
  const after = await paymentRow(convPayment.payment_id);
  assert.notEqual(after.reference, before.reference);
  assert.equal(after.reference, res.body.reference);
  assert.equal(fake.verifyCalls.length, 0, 'first attempt does not verify an old reference');
});

test('an abandoned checkout leaves the payment unpaid', async () => {
  const { reference } = await paymentRow(convPayment.payment_id);
  fake.results.set(reference, { status: 'abandoned', reference });
  const res = await api('GET', `/payments/verify?reference=${reference}`, { token: tok.student });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.status, 'unpaid');
  assert.equal((await api('GET', `/payments/verify?reference=${reference}`, { token: tok.other })).status, 404, "another student's reference");
});

test('a success with the wrong amount is not accepted', async () => {
  const { reference } = await paymentRow(convPayment.payment_id);
  fake.results.set(reference, paid(reference, 100));
  const res = await api('GET', `/payments/verify?reference=${reference}`, { token: tok.student });
  assert.equal(res.status, 409);
  assert.equal((await paymentRow(convPayment.payment_id)).status, 'unpaid');
  assert.equal(await auditCount(convPayment.payment_id, 'payment.mismatch'), 1);
});

test('a success in the wrong currency is not accepted', async () => {
  const { reference } = await paymentRow(convPayment.payment_id);
  fake.results.set(reference, paid(reference, 1_000_000, { currency: 'USD' }));
  assert.equal((await api('GET', `/payments/verify?reference=${reference}`, { token: tok.student })).status, 409);
  assert.equal((await paymentRow(convPayment.payment_id)).status, 'unpaid');
});

test('webhooks with a bad or missing signature are refused', async () => {
  const { reference } = await paymentRow(convPayment.payment_id);
  fake.results.set(reference, paid(reference, 1_000_000));
  const payload = { event: 'charge.success', data: { reference } };
  assert.equal((await webhook(payload, { secret: 'sk_test_wrong' })).status, 401);
  assert.equal((await webhook(payload, { signature: '' })).status, 401);
  assert.equal((await paymentRow(convPayment.payment_id)).status, 'unpaid');
});

test('a signed charge.success webhook marks the payment paid after server-side verify', async () => {
  const { reference } = await paymentRow(convPayment.payment_id);
  const verifiesBefore = fake.verifyCalls.length;
  const res = await webhook({ event: 'charge.success', data: { reference, amount: 1_000_000 } });
  assert.equal(res.status, 200);
  assert.equal(fake.verifyCalls.length, verifiesBefore + 1, 'webhook body is not trusted; verify is called');
  const row = await paymentRow(convPayment.payment_id);
  assert.equal(row.status, 'success');
  assert.ok(row.paid_at);
  assert.equal(row.gateway_response.reference, reference);

  const conv = stageOf(await mine(), 'convocation');
  assert.equal(conv.payments[0].status, 'success');
  assert.equal(conv.slots.length, 0, 'convocation has nothing to upload');
  assert.equal(conv.payments[0].description, 'Convocation Fee', 'not "Convocation Fee fee"');
  assert.equal(conv.status, 'approved', 'confirming the payment completes the stage');
  assert.equal(conv.slip.title, 'Convocation Fee Receipt');
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE recipient_type = 'student' AND recipient_id = ? AND message LIKE 'Payment of ₦10,000 received%'", [studentId]);
  assert.equal(n.n, 1);
});

test('replayed webhooks and callback verifies are idempotent', async () => {
  const { reference } = await paymentRow(convPayment.payment_id);
  for (let i = 0; i < 3; i++) assert.equal((await webhook({ event: 'charge.success', data: { reference } })).status, 200);
  const res = await api('GET', `/payments/verify?reference=${reference}`, { token: tok.student });
  assert.equal(res.body.payment.status, 'success');
  assert.equal(await auditCount(convPayment.payment_id, 'payment.success'), 1, 'recorded once');
  assert.equal((await api('POST', `/payments/${convPayment.payment_id}/initialize`, { token: tok.student })).status, 409, 'cannot pay twice');
});

test('other webhook events and unknown references are acknowledged and ignored', async () => {
  assert.equal((await webhook({ event: 'transfer.success', data: { reference: 'x' } })).status, 200);
  assert.equal((await webhook({ event: 'charge.success', data: { reference: 'NOT-OURS-123' } })).status, 200);
});

test('reviewers raise charges only on stages they review, with validation', async () => {
  const dept = stageOf(await mine(), 'departmental');
  const body = { amount: 3000, description: 'Missing 200 level teller fine', purpose: 'fine' };
  assert.equal((await api('POST', `/stages/${dept.stage_id}/charges`, { token: tok.student, body })).status, 403);
  assert.equal((await api('POST', `/stages/${dept.stage_id}/charges`, { token: tok.library, body })).status, 403, 'library does not review departmental');
  assert.equal((await api('POST', `/stages/${dept.stage_id}/charges`, { token: tok.dept, body: { ...body, amount: -5 } })).status, 400);
  assert.equal((await api('POST', `/stages/${dept.stage_id}/charges`, { token: tok.dept, body: { ...body, description: ' ' } })).status, 400);
  assert.equal((await api('POST', `/stages/${dept.stage_id}/charges`, { token: tok.dept, body: { ...body, purpose: 'bribe' } })).status, 400);

  const res = await api('POST', `/stages/${dept.stage_id}/charges`, { token: tok.dept, body });
  assert.equal(res.status, 201);
  const view = await mine();
  const action = view.action_needed.find((a) => a.stage_id === dept.stage_id);
  assert.deepEqual(action.unpaid.map((u) => u.amount), [3000]);
  assert.equal(await auditCount(res.body.payment_id, 'payment.charge_raised'), 1);
});

test('a charge raised by mistake can be withdrawn; fixed fees cannot', async () => {
  const dept = stageOf(await mine(), 'departmental');
  const charge = dept.payments.find((p) => p.raised_by_staff);
  assert.equal((await api('DELETE', `/payments/${charge.payment_id}`, { token: tok.library })).status, 403);
  assert.equal((await api('DELETE', `/payments/${charge.payment_id}`, { token: tok.dept })).status, 200);
  assert.equal(await paymentRow(charge.payment_id), undefined);
});

test('starting a new attempt first checks whether the previous one was actually paid', async () => {
  const dept = stageOf(await mine(), 'departmental');
  const charge = (await api('POST', `/stages/${dept.stage_id}/charges`, { token: tok.dept, body: { amount: 1500, description: 'Late dues', purpose: 'fine' } })).body;
  const first = await api('POST', `/payments/${charge.payment_id}/initialize`, { token: tok.student });
  assert.equal(first.status, 200);

  // The student paid in that first tab, but never came back to the callback page.
  fake.results.set(first.body.reference, paid(first.body.reference, 150_000));
  const second = await api('POST', `/payments/${charge.payment_id}/initialize`, { token: tok.student });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already been completed/);
  const row = await paymentRow(charge.payment_id);
  assert.equal(row.status, 'success');
  assert.equal(row.reference, first.body.reference, 'the paid reference is kept');
});

test('a failed charge can be retried', async () => {
  const dept = stageOf(await mine(), 'departmental');
  const charge = (await api('POST', `/stages/${dept.stage_id}/charges`, { token: tok.dept, body: { amount: 500, description: 'Card replacement', purpose: 'fine' } })).body;
  const first = await api('POST', `/payments/${charge.payment_id}/initialize`, { token: tok.student });
  fake.results.set(first.body.reference, { status: 'failed', reference: first.body.reference, raw: { status: 'failed' } });
  assert.equal((await api('GET', `/payments/verify?reference=${first.body.reference}`, { token: tok.student })).body.payment.status, 'failed');
  const retry = await api('POST', `/payments/${charge.payment_id}/initialize`, { token: tok.student });
  assert.equal(retry.status, 200);
  assert.notEqual(retry.body.reference, first.body.reference);
  assert.equal((await paymentRow(charge.payment_id)).status, 'unpaid');
});
