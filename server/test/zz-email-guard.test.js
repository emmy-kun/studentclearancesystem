// Guard: the test run must never send real email, whatever .env says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { default: env } = await import('../src/config/env.js');

test('email is disabled while tests run', () => {
  assert.equal(env.email.enabled, false);
});
