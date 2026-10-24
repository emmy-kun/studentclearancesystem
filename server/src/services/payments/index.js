// Payment gateway interface. A gateway module provides:
//   name
//   initialize({ email, amountMinor, currency, reference, callbackUrl, metadata })
//       -> { authorizationUrl, accessCode, reference }
//   verify(reference) -> { status, amountMinor, currency, reference, paidAt, raw }
//   verifyWebhookSignature(rawBody, signature) -> boolean
//   parseWebhook(body) -> { event, reference }
//
// Paystack is the stand-in for the university's real gateway (Remita). A
// remitaGateway.js with the same functions could replace it here.
import * as paystack from './paystackGateway.js';

let active = paystack;

export const gateway = () => active;

/** Tests swap in a fake gateway; pass nothing to restore Paystack. */
export function setGateway(g) {
  active = g || paystack;
}
