// Payments (spec section 5): fixed stage fees, staff-raised charges, and the
// online flow initialize -> gateway checkout -> verify (+ webhook).
//
// A payment is only marked success after a server-side verify call confirms
// status, amount and currency. Marking success is idempotent (guarded by
// status <> 'success' under a row lock), so the callback page and the webhook
// can both arrive without double-processing.
import crypto from 'node:crypto';
import pool, { withTransaction } from '../config/db.js';
import env from '../config/env.js';
import httpError from '../utils/httpError.js';
import { logAudit } from './auditLog.js';
import { notifyStudent } from './notificationService.js';
import { gateway } from './payments/index.js';
import { loadContext, runUnlockCheck, requestIdForStage, findStage, assertCanReview, naira, withFileTransaction, autoApproveReadyStages } from './workflowEngine.js';

const MAX_CHARGE = 1_000_000;
const CHARGE_PURPOSES = ['fine', 'library_fee'];
const CHARGE_STAGE_STATUSES = ['awaiting_submission', 'pending', 'rejected'];

const toMinor = (amount) => Math.round(Number(amount) * 100);

function newReference(payment) {
  return `CLR${payment.request_id}-P${payment.payment_id}-${crypto.randomBytes(5).toString('hex')}`;
}

async function loadPayment(db, where, params, { lock = false } = {}) {
  const [[p]] = await db.query(
    `SELECT p.*, cr.student_id, cs.stage_key, cs.status AS stage_status, ws.name AS stage_name,
            s.email, s.matric_no, s.full_name
       FROM payments p
       JOIN clearance_requests cr ON cr.request_id = p.request_id
       JOIN clearance_stages cs ON cs.stage_id = p.stage_id
       JOIN workflow_stages ws ON ws.stage_key = cs.stage_key
       JOIN students s ON s.student_id = cr.student_id
      WHERE ${where}${lock ? ' FOR UPDATE' : ''}`,
    params
  );
  return p;
}

/**
 * Record a verified gateway result. Returns the payment's status afterwards.
 * Only 'success' with matching amount and currency marks the payment paid.
 */
async function applyVerification(paymentId, result, actor) {
  const outcome = await withFileTransaction(async (conn, files) => {
    // Lock the request first (same order as workflow actions), then the payment.
    const [[{ request_id: requestId }]] = await conn.query('SELECT request_id FROM payments WHERE payment_id = ?', [paymentId]);
    const ctx = await loadContext(conn, requestId, { lock: true });
    const payment = await loadPayment(conn, 'p.payment_id = ?', [paymentId], { lock: true });
    if (payment.status === 'success') return 'success';

    if (result.status === 'success') {
      const expected = toMinor(payment.amount);
      if (result.amountMinor !== expected || result.currency !== payment.currency || result.reference !== payment.reference) {
        return { mismatch: { expected, currency: payment.currency, got: result.raw ?? result } };
      }
      await conn.query(
        "UPDATE payments SET status = 'success', paid_at = NOW(), gateway_response = ? WHERE payment_id = ? AND status <> 'success'",
        [JSON.stringify(result.raw), paymentId]
      );
      const p = ctx.payments.find((x) => x.payment_id === paymentId);
      if (p) p.status = 'success';
      await logAudit({ ...actor, action: 'payment.success', entity: 'payment', entityId: paymentId, detail: { reference: payment.reference, amount: payment.amount, stage_key: payment.stage_key } }, conn);
      await notifyStudent(payment.student_id, `Payment of ${naira(payment.amount)} received for ${payment.description || payment.stage_name}.`, conn, `/student/stage/${payment.stage_id}`);
      // Convocation has nothing else to do: confirming its fee completes the stage.
      await autoApproveReadyStages(conn, ctx, files);
      await runUnlockCheck(conn, ctx);
      return 'success';
    }

    if (result.status === 'failed') {
      await conn.query("UPDATE payments SET status = 'failed', gateway_response = ? WHERE payment_id = ?", [JSON.stringify(result.raw), paymentId]);
      await logAudit({ ...actor, action: 'payment.failed', entity: 'payment', entityId: paymentId, detail: { reference: payment.reference } }, conn);
      return 'failed';
    }
    // abandoned / ongoing / not_found: nothing paid yet
    return payment.status;
  });

  // Logged outside the transaction so the record survives the refusal.
  if (outcome?.mismatch) {
    await logAudit({ ...actor, action: 'payment.mismatch', entity: 'payment', entityId: paymentId, detail: outcome.mismatch });
    throw httpError(409, 'The payment amount did not match. Contact the clearance office with your payment reference.');
  }
  return outcome;
}

/**
 * POST /api/payments/:id/initialize. Starts a gateway checkout for one of the
 * student's unpaid payments. Each attempt gets a fresh reference (gateways
 * refuse reused ones); before replacing an old reference it is verified, in
 * case the student already paid in another tab.
 */
export async function initializePayment(studentId, paymentId) {
  const payment = await loadPayment(pool, 'p.payment_id = ?', [paymentId]);
  if (!payment || payment.student_id !== studentId) throw httpError(404, 'Payment not found');
  if (payment.status === 'success') throw httpError(409, 'This has already been paid');
  if (payment.stage_status === 'locked') throw httpError(409, 'This stage is not open yet');

  const [[tried]] = await pool.query(
    "SELECT 1 AS yes FROM audit_logs WHERE entity = 'payment' AND entity_id = ? AND action = 'payment.initialize' LIMIT 1",
    [paymentId]
  );
  if (tried) {
    const previous = await gateway().verify(payment.reference);
    if (previous.status === 'success') {
      await applyVerification(paymentId, previous, { actorType: 'system' });
      throw httpError(409, 'This payment has already been completed');
    }
  }

  const reference = newReference(payment);
  await pool.query("UPDATE payments SET reference = ?, status = 'unpaid' WHERE payment_id = ? AND status <> 'success'", [reference, paymentId]);

  const result = await gateway().initialize({
    email: payment.email,
    amountMinor: toMinor(payment.amount),
    currency: payment.currency,
    reference,
    callbackUrl: `${env.appBaseUrl}/payments/callback`,
    metadata: {
      payment_id: payment.payment_id,
      request_id: payment.request_id,
      stage: payment.stage_key,
      matric_no: payment.matric_no,
      custom_fields: [
        { display_name: 'Reg number', variable_name: 'matric_no', value: payment.matric_no },
        { display_name: 'For', variable_name: 'purpose', value: payment.description || payment.stage_name },
      ],
    },
  }).catch((err) => {
    if (/email/i.test(err.message)) {
      throw httpError(400, 'The payment provider did not accept your email address. Ask the clearance administrator to update it.');
    }
    throw err;
  });
  await logAudit({ actorType: 'student', actorId: studentId, action: 'payment.initialize', entity: 'payment', entityId: paymentId, detail: { reference, amount: payment.amount, gateway: gateway().name } });
  return { authorization_url: result.authorizationUrl, access_code: result.accessCode, reference };
}

/** GET /api/payments/verify?reference=. Called by the payment callback page. */
export async function verifyByReference(user, reference) {
  const ref = String(reference || '').trim();
  if (!ref) throw httpError(400, 'reference is required');
  const payment = await loadPayment(pool, 'p.reference = ?', [ref]);
  if (!payment || (user.role !== 'admin' && payment.student_id !== user.sub)) throw httpError(404, 'Payment not found');

  if (payment.status !== 'success') {
    const result = await gateway().verify(ref);
    payment.status = await applyVerification(payment.payment_id, result, { actorType: user.userType, actorId: user.sub });
  }
  return {
    payment_id: payment.payment_id,
    status: payment.status,
    amount: payment.amount,
    description: payment.description,
    stage_id: payment.stage_id,
    stage_name: payment.stage_name,
  };
}

/**
 * POST /api/payments/webhook/paystack. Signature checked against the raw body;
 * charge.success is confirmed with a verify call before anything is marked paid.
 * Returns true if the event was accepted (the route replies 200 either way for
 * accepted events, 401 for bad signatures).
 */
export async function handleWebhook(rawBody, signature) {
  const gw = gateway();
  if (!gw.verifyWebhookSignature(rawBody, signature)) return { accepted: false };

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { accepted: true, ignored: 'invalid json' };
  }
  const { event, reference } = gw.parseWebhook(body);
  if (event !== 'charge.success' || !reference) return { accepted: true, ignored: event || 'no event' };

  const [[payment]] = await pool.query('SELECT payment_id, status FROM payments WHERE reference = ?', [reference]);
  if (!payment) return { accepted: true, ignored: 'unknown reference' };
  if (payment.status === 'success') return { accepted: true, status: 'success' };

  const result = await gw.verify(reference);
  const status = await applyVerification(payment.payment_id, result, { actorType: 'system' });
  return { accepted: true, status };
}

/** POST /api/stages/:stageId/charges. A reviewer raises a fine or charge on a stage they review. */
export async function raiseCharge(user, stageId, { amount, description, purpose = 'fine' } = {}) {
  if (!CHARGE_PURPOSES.includes(purpose)) throw httpError(400, `purpose must be one of: ${CHARGE_PURPOSES.join(', ')}`);
  const value = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_CHARGE) throw httpError(400, 'Enter a valid amount');
  const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw httpError(400, 'Describe what the charge is for');
  if (text.length > 255) throw httpError(400, 'Description is too long (max 255 characters)');

  return withTransaction(async (conn) => {
    const ctx = await loadContext(conn, await requestIdForStage(conn, stageId), { lock: true });
    const stage = findStage(ctx, stageId);
    assertCanReview(user, ctx, stage);
    if (!CHARGE_STAGE_STATUSES.includes(stage.status)) throw httpError(409, 'Charges can only be added to an open stage');

    const placeholder = `CLR${ctx.request.request_id}-NEW-${crypto.randomBytes(6).toString('hex')}`;
    const [res] = await conn.query(
      `INSERT INTO payments (request_id, stage_id, purpose, description, amount, reference, raised_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ctx.request.request_id, stageId, purpose, text, value, placeholder, user.sub]
    );
    const reference = newReference({ request_id: ctx.request.request_id, payment_id: res.insertId });
    await conn.query('UPDATE payments SET reference = ? WHERE payment_id = ?', [reference, res.insertId]);

    await notifyStudent(ctx.student.student_id, `${stage.name}: a ${naira(value)} charge was added (${text}). Pay it online to continue.`, conn, `/student/stage/${stageId}`);
    await logAudit({ actorType: 'staff', actorId: user.sub, action: 'payment.charge_raised', entity: 'payment', entityId: res.insertId, detail: { stage_key: stage.stage_key, amount: value, purpose, description: text } }, conn);
    return { payment_id: res.insertId, amount: value, description: text, purpose, status: 'unpaid' };
  });
}

/** DELETE /api/payments/:id. The reviewing office withdraws an unpaid charge raised by mistake. */
export async function cancelCharge(user, paymentId) {
  return withTransaction(async (conn) => {
    const [[p]] = await conn.query('SELECT payment_id, stage_id, raised_by, status, amount, description FROM payments WHERE payment_id = ?', [paymentId]);
    if (!p) throw httpError(404, 'Payment not found');
    const ctx = await loadContext(conn, await requestIdForStage(conn, p.stage_id), { lock: true });
    const stage = findStage(ctx, p.stage_id);
    assertCanReview(user, ctx, stage);
    if (p.raised_by === null) throw httpError(409, 'Fixed stage fees cannot be removed');
    if (p.status === 'success') throw httpError(409, 'This charge has already been paid');

    await conn.query('DELETE FROM payments WHERE payment_id = ?', [paymentId]);
    await notifyStudent(ctx.student.student_id, `${stage.name}: the ${naira(p.amount)} charge (${p.description}) was withdrawn.`, conn, `/student/stage/${p.stage_id}`);
    await logAudit({ actorType: 'staff', actorId: user.sub, action: 'payment.charge_cancelled', entity: 'payment', entityId: paymentId, detail: { stage_key: stage.stage_key, amount: p.amount, description: p.description } }, conn);
  });
}
