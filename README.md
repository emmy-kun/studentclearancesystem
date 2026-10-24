# Automated Student Clearance and Certificate Issuance System

Final-year BSc Computer Science project: design and implementation of an automated student clearance system.

- `server/`: Node.js + Express REST API, MySQL 8 (workflow engine, uploads, Paystack, PDFs, email)
- `client/`: React (Vite) frontend: student (mobile-first), staff review, admin, public verification
- `docs/SPEC.md`: the agreed specification (with amendments); `docs/ui-design.md` + `docs/ui-mockups/`: the agreed UI

## Prerequisites

- Node.js 18+ (developed on Node 24)
- MySQL 8 (developed on 8.4) running locally

## First-time setup

```bash
cp .env.example .env          # set DB_PASSWORD, JWT_SECRET, Paystack test keys; EmailJS keys if using email
cd server
npm install
npm run db:migrate            # creates clearance_db and all tables
npm run db:seed               # stages, required documents, test staff accounts (passwords printed once)
npm run import:students -- ../data/class-list.csv   # import the class list
npm run db:seed               # again, to create officers for any new departments
cd ../client
npm install
```

## Running

From the `clearance-system` folder, one command starts both parts:

```bash
npm run dev                   # API on :4000 and the app on :5173; Ctrl+C stops both
```

Open http://localhost:5173. (Or run them separately: `npm run dev` inside `server` and inside `client`.)

| Who | Where | How |
|---|---|---|
| Student | `/student` (login at `/student/login`) | Reg number, then tap your name, then password. New students use `/student/signup`. |
| Staff | `/staff` (login at `/staff/login`) | Email + password (forced change on first login) |
| Admin | `/admin` (login at `/staff/login`) | `admin@clearance.test` (see `staff-credentials.local.txt`) |
| Registry | `/staff/registry` (login at `/staff/login`) | `registry@clearance.test` (see `staff-credentials.local.txt`) |
| Anyone | `/verify` | Certificate verification, no login |

The student portal and the staff portal keep separate logins, so you can be logged in to both in the same
browser (for example a student tab and a reviewer tab side by side) without one replacing the other.

## Demo data (for presentations)

```bash
cd server && npm run demo
```

Resets two demo students to match the mockups. Password for all demo accounts: `Demo@12345`.

- `2022/248400` (ALIOZOR): departmental + faculty approved, library card sent back as blurry, N3,000 library fee due
- `2022/242722` (ALOGO): departmental receipts waiting for review; the 300 level receipt is a duplicate
- `obi.demo@clearance.test`: departmental officer, Computer Science

## Tests

```bash
cd server && npm test         # 107 tests: rules, auth, workflow end to end, uploads, payments, PDFs, notifications, admin
```

Tests use the local database and clean up after themselves. They never send real email and never contact Paystack.

## Payments (Paystack test mode)

Use Paystack's test card on the checkout page: `4084 0840 8408 4081`, any future expiry, CVV `408`, PIN `0000`, OTP `123456`.
Payments are confirmed by the server calling Paystack's verify API when the student returns. The webhook
(`/api/payments/webhook/paystack`) also works once the API is reachable from the internet (deployment or a tunnel).

## Email (optional)

Set `EMAIL_ENABLED=true` and the `EMAILJS_*` values in `.env` (free tier: 200 emails/month).
Every in-app notification is then also emailed to the person it concerns.
Password reset links ("Forgot password?" on both login pages) are sent the same way. Addresses ending in
`.test` (the seeded staff accounts) cannot receive email; with email off, or for those addresses, the
reset link is printed in the server console instead.
