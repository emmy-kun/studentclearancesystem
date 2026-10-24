// Optional email copy of in-app notifications. Off unless EMAIL_ENABLED=true.
// Provider (EMAIL_PROVIDER):
//   emailjs  EmailJS REST API (free tier: 200 emails/month). Needs
//            EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY,
//            EMAILJS_PRIVATE_KEY, and "Allow EmailJS API for non-browser
//            applications" switched on in the EmailJS account (Account > Security).
//   smtp     any SMTP server via nodemailer (SMTP_* settings).
// Failures are logged and never block the clearance workflow.
import nodemailer from 'nodemailer';
import env from '../config/env.js';
import brand from '../config/brand.js';

// Reserved test domains cannot receive mail (the imported placeholder emails use .test).
const UNDELIVERABLE = /\.(test|example|invalid|localhost)$/i;
const EMAILJS_URL = 'https://api.emailjs.com/api/v1.0/email/send';

let transport = null;

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.email.host,
      port: env.email.port,
      secure: env.email.port === 465,
      auth: env.email.user ? { user: env.email.user, pass: env.email.pass } : undefined,
    });
  }
  return transport;
}

/** Tests swap in a fake SMTP transport; pass nothing to go back to the real one. */
export function setTransport(t) {
  transport = t || null;
}

export const emailEnabled = () => env.email.enabled;

/** Build the email for a notification (shared by both providers). */
export function composeEmail({ name, message, link }) {
  return {
    subject: `Clearance: ${message.length > 70 ? `${message.slice(0, 67)}...` : message}`,
    greeting: `Hello ${name || ''},`.trim(),
    message,
    appUrl: link ? env.appBaseUrl + link : env.appBaseUrl, // straight to the page the notification is about
  };
}

async function sendViaEmailJs(to, name, mail) {
  const { serviceId, templateId, publicKey, privateKey } = env.email.emailjs;
  if (!serviceId || !templateId || !publicKey) throw new Error('EmailJS is not configured (EMAILJS_* in .env)');
  const res = await fetch(EMAILJS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      ...(privateKey && { accessToken: privateKey }),
      // Names used in the EmailJS template: {{to_email}}, {{to_name}}, {{subject}}, {{message}}, {{app_url}}
      template_params: { to_email: to, to_name: name || '', subject: mail.subject, message: mail.message, app_url: mail.appUrl },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`EmailJS ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendViaSmtp(to, mail) {
  const text = [mail.greeting, '', mail.message, '', `Log in to the clearance system for details: ${mail.appUrl}`, '', `This is an automatic message from the ${brand.name}.`].join('\n');
  await getTransport().sendMail({ from: env.email.from, to, subject: mail.subject, text });
}

export async function sendEmail({ to, name, message, link }) {
  if (!env.email.enabled || !to || UNDELIVERABLE.test(to)) return false;
  const mail = composeEmail({ name, message, link });
  try {
    if (env.email.provider === 'emailjs') await sendViaEmailJs(to, name, mail);
    else await sendViaSmtp(to, mail);
    return true;
  } catch (err) {
    console.error(`Email to ${to} failed:`, err.message);
    return false;
  }
}
