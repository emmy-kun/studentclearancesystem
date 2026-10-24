# Automated Student Clearance and Certificate Issuance System — Build Specification

Final-year BSc Computer Science project: design and implementation of an automated student clearance system.
This file is the complete agreed specification. Build the system exactly as described. Where something is marked **ASSUMPTION**, implement it as written, but keep it easy to change.

> **Amendments since this spec was agreed** (these take precedence):
> - UI mockups and the backend additions they need: see `docs/ui-design.md` (per-document reference label/amount/date flags, per-document review endpoint, approve requires all documents accepted, "Reviewed by me" history, staff notifications).
> - Students of any matric/admission year can start clearance; all use `levels_count` (default 4).
> - Upload slots are **computed, not stored** (a `stage_documents` row always has a file): slots = `required_documents` for the stage, filtered by `applies_if`, repeated per level. They appear once the stage unlocks. When a form change makes a slot no longer apply, uploads for it are deleted (only in stages the student can still edit).
> - Audit has nothing for the student to submit, so it goes straight to `pending` when it unlocks.
> - Request completion calls `certificateService.issueCertificate()` (implemented in step 7).
> - Receipts: only the receipt number is typed (amount and date are read by the reviewer from the photo). The library card and online school fees receipts are photo only.
> - Identity check: for every document that carries the student's details (`required_documents.check_identity`), the reviewer must tick "name and reg number match" before Accept (recorded in the audit log). Photos are also read automatically with OCR (Tesseract) in the background and the reviewer sees a found / partly found / not found badge (`stage_documents.ocr_status`, `ocr_result`). OCR assists only: it reads printed documents well and handwriting poorly.
> - A document rejected during review can be replaced at once; the replacement goes straight back to the office without the whole stage being sent back.
> - Clearance slips: when an office approves a stage the system issues that office's slip as a PDF with a QR code (`clearance_slips`): Departmental Clearance Slip, School Fees Clearance Receipt (Faculty), Library, Alumni and Accommodation Clearance Slips, Security Clearance Slip, Convocation Fee Receipt. The student can download it; the slips are attached to the Security and Audit review pages automatically, so Security only asks for the School ID card. Slips verify on /verify while their stage stays approved. (Replaces rule 10b.)
> - Convocation is pay-online only: the student pays the N10,000 through Paystack (standing in for Remita) and uploads nothing (the Remita invoice, teller and receipt slots were removed, since paying at the bank as well would charge the student twice). The stage completes automatically the moment the payment is confirmed, and the Convocation Fee Receipt slip is issued.
> - Stage 7 is now "Graduation List & Application Letter" (stage_key `letter`, reviewer `departmental`, unlocks after Security). The student uploads the graduation list (PDF or a photo of the page) and enters the page (and number) where their name appears; typed PDFs are read page by page so the officer sees which page the name and reg number were found on. When the departmental officer approves, the application letter is generated automatically and states where the name appears. Convocation moves to number 8 (still open any time). The Admin "results release" step and the student's "Generate letter" button were removed (rules 6 and 8 as written no longer apply).
> - Class list: 559 names + matric numbers supplied (Computer Science). Missing fields were simulated (emails `surname.firstname.<digits>@unn.test`). See `server/scripts/convertClassList.js`.
> - **No university branding** (group decision): the system is generic, named "Automated Student Clearance System" (`server/src/config/brand.js`, `client/src/brand.js`). No UNN name, crest or background. The group's own logo, loader and background photo are in `client/public/` (`logo-mark.svg`, `logo.svg`, `loader.svg`, `background.jpg`); PDFs use `server/assets/logo.png` (a PNG copy of the logo mark). New numbers drop the prefix (`CLR-2026-000020`, `DEP-…`); older `UNN-` numbers still verify. Seed/demo staff emails use `@clearance.test`. Student class-list records are unchanged.
> - **Registry (final, in-person step):** staff role `registry`. The student brings the clearance certificate (printed or on a phone) to the Registry; the officer looks it up at `/staff/registry` by certificate number, QR code/address or reg number, checks it is genuine and complete, checks the student's ID card, then records that the signed degree certificate (VC and Registrar signatures, printed by the University) was handed over: optional serial number and note, once per certificate (`certificates.degree_issued_at/by/serial_no/note`). The student is notified and the dashboard shows "Degree certificate collected"; logged as `degree.issue`. The system never prints the degree certificate itself.
> - **Forgot password** (students and staff): "Forgot password?" (key icon) on both login pages → `/student|staff/forgot-password` (student: reg number or email; staff: email) → `POST /api/auth/forgot-password` always gives the same reply (no account enumeration), rate-limited, max one link per account per minute → emails a one-time link `/student|staff/reset-password?token=…` (valid 30 minutes; only a SHA-256 hash is stored in `password_resets`; a newer link cancels older ones) → `POST /api/auth/reset-password` sets the new password (staff: no forced change afterwards), then a "your password was changed" email. Deactivated staff and students who never signed up get no link. Audit-logged (`auth.password_reset_request`, `auth.password_reset`). With email off, the link is printed in the server console for demos.

---

## 1. What the system is

A web platform that digitises the UNN final-year clearance process. A graduating student starts a clearance request, then moves through a fixed chain of stages. At each stage the student **photographs/uploads the original documents** required and fills in some input fields, and (at some offices) **pays online**. The responsible office reviews the uploads and approves or rejects. After the last stage (Audit) approves, the system **automatically generates a verifiable PDF certificate** with a QR code.

### Problem being solved
Clearance is paper-based: students carry a form between offices for stamps, forms get lost, nobody can track progress or find bottlenecks, certificates are slow and easy to forge, and there is no digital trail. This system gives real-time tracking, a central record, role-based dashboards, online payments, an audit trail and verifiable certificates.

### Architecture
Three-tier web app, responsive for desktop and mobile (students will use phone cameras).
- **Frontend:** React.js (Vite)
- **Backend:** Node.js + Express.js REST API
- **Database:** MySQL 8 (driver `mysql2`, InnoDB, utf8mb4, use transactions for workflow changes)
- **Auth:** JWT (role and scope inside the token), `bcrypt` for staff passwords
- **Uploads:** `multer` (images and PDF only, size limit, files served only through authenticated routes)
- **PDF:** `pdfkit` (certificate, application letter, reports) and `qrcode` (QR on certificate)
- **Payments:** Paystack (test mode). Stripe is not used.
- **Email:** `nodemailer`, optional, behind an env flag. In-app notifications are the baseline.

Methodology in the report is OOADM with UML (use case, class, sequence, activity diagrams).

---

## 2. Users and roles

Nine kinds of user: Student plus eight staff roles.

| Role key | Who | Scope |
|---|---|---|
| `student` | Graduating student | Own data only |
| `departmental` | Departmental clearance officer (one or more per department) | Only students of their own department |
| `faculty` | Faculty finance/clearance officer (one or more per faculty) | Only students whose department is in their faculty |
| `library` | Library | All students |
| `alumni` | Alumni Office | All students |
| `student_affairs` | Students' Affairs (accommodation) | All students |
| `security` | Security department | All students |
| `audit` | Audit unit (final reviewer) | All students |
| `admin` | System administrator (one real Admin; creates all accounts) | Everything |

The old "Bursary" role is replaced by Faculty (Finance). **ASSUMPTION:** confirmed with user's procedure, which has no central bursary step. Keep the enum values easy to change.

---

## 3. Login and account rules

### Students (AMENDED: sign-up + password)
- Admin imports the class list (CSV) into `students`. Only students on the list can create an account.
- **Sign-up** (`POST /api/auth/student/signup`): reg (matric) number, full name, email, password (min 8). The reg number and name must match a class-list record (case-insensitive, spaces collapsed). The student's email replaces the imported placeholder. One account per reg number; a second sign-up gets "account already exists, contact the administrator". Audit-logged.
- **Login page:** as the student types their reg number, `GET /api/auth/student/lookup?matric_no=` shows their name (surname + initials, e.g. "ABAH P. C.", plus department; rate-limited; only for students who have signed up). The student taps the name, then enters their password (`POST /api/auth/student/login { matric_no, password }`).
- After login the UI header shows the student's **name and department**.
- **Limitation to state in the report:** a reg number and name are not secrets, so someone could sign up as another student first. Mitigations: the real student is told the account exists, the Admin can reset a student account (clears `password_hash`/`registered_at` so they can sign up again), and every sign-up is logged. Production would use UNN SSO.
- Login is a swappable **auth provider** (`authProviders/passwordProvider.js` active; `localRecordProvider.js` (old four-field match) kept; room for `uniSsoProvider.js`).
- `students` gains `password_hash VARCHAR(255) NULL` and `registered_at DATETIME NULL`.

### Staff
- Login with **email + password** at one shared staff login endpoint.
- Accounts are created **only by Admin**, who sets `role`, and `department_id` (for `departmental`) or `faculty_id` (for `faculty`). Central offices and admin have neither.
- New accounts have `must_change_password = true`; the first login forces a password change.
- Passwords hashed with bcrypt. Rate-limit login endpoints. Admin can deactivate accounts (`is_active = false`).
- The first Admin is created by a seed script.

### JWT
Payload: `{ sub, userType: "student"|"staff", role, department_id, faculty_id }`. Expiry: a few hours. The server checks the token's role and scope on **every** protected route. The frontend only uses the role to choose which dashboard to show; it is never trusted for access control.

---

## 4. The clearance workflow (agreed order)

Stage keys and order. This follows the student's actual UNN procedure sheet ("Class of '26 UNN Final Clearance Procedure"), with **Departmental clearance added as the new first step**.

| # | `stage_key` | Reviewer role | Unlocks when | Student submits (upload photo/PDF + input fields) | Payment |
|---|---|---|---|---|---|
| 1 | `departmental` | `departmental` | Request created | Original **departmental dues receipt for each level, 100 to final year** (one slot per level) | none |
| 2 | `faculty` | `faculty` | Stage 1 approved | Per level: online school fees receipt, Remita (bank) teller, faculty dues receipt. Once: homecoming receipt. The faculty finance office converts these into a **school fees clearance receipt**. | Fine if a teller is missing (amount set by staff) |
| 3 | `library` | `library` | Stage 2 approved | Student chooses "I have a library card" (upload library card) or "I was never registered" (upload school fees receipt + passport) | Cash amount for other years (set by staff) |
| 4 | `alumni` | `alumni` | Stage 3 approved | Final-year online school fees receipt | Fixed ₦650 |
| 5 | `student_affairs` | `student_affairs` | Stage 4 approved | Accommodation form details as input fields (hostel, room, etc.), photo of the filled/stamped accommodation form, off-campus clearance if `accommodation_type = off_campus` | none |
| 6 | `security` | `security` | Stage 5 approved | Details form (input fields) + uploads **in this order**: School ID, school fees clearance receipt, accommodation clearance, library clearance, alumni ID card, off-campus clearance (only if off-campus) | Fixed ₦1,000 plus any fine for open files (staff-raised) |
| 7 | `convocation` | auto | **Any time** (unlocked from the start, not blocked by other stages, but must be approved before Audit) | Remita invoice/RRR, teller and receipt (with `reference_no`) | Fixed ₦10,000 |
| 8 | `letter` | auto | Student's `results_released = true` | None. System **generates** the typed letter "Application for the Collection of My Statement of Results and Original Degree Certificate", addressed to the Office of the Deputy Registrar, filled in from the student record | none |
| 9 | `audit` | `audit` | Stages 1 to 8 all approved | Nothing new. Audit sees the whole dossier in this order: school fee clearance, application letter, security clearance, accommodation clearance, convocation (invoice, teller, receipt), library clearance, alumni ID card | none |

### Unlock rules (stored in `workflow_stages.unlock_rule`)
- `sequential`: unlocks when the stage with the previous `sequence_order` is `approved`. Used by stages 1 to 6.
- `anytime`: unlocked as soon as the request is created. Used by `convocation`.
- `on_results_released`: unlocked when `students.results_released = true`. Used by `letter`.
- `all_others_approved`: unlocked when every other stage is `approved`. Used by `audit`.

### Stage statuses
`locked` → `awaiting_submission` → `pending` → `approved` or `rejected`.
- `locked`: not yet reachable.
- `awaiting_submission`: unlocked; student is uploading and filling in fields.
- `pending`: student submitted; waiting for the office.
- `approved`: reviewer approved (or system auto-approved).
- `rejected`: reviewer rejected with a comment. Stays `rejected` while the student fixes the rejected items; moves to `pending` on resubmit (see rules).

### Rules
1. **Checklist generation.** When a request is created, create one `clearance_stages` row per active workflow stage. Status is `awaiting_submission` for stages whose unlock rule is already met (stage 1 and `convocation`), else `locked`. The upload slots of a stage are generated **when that stage unlocks**, not at request creation, from `required_documents`: `per_level = true` slots are repeated for each level 100, 200, … up to `students.levels_count * 100`. `applies_if` filters slots (see section 6). Slots that depend on data the student can change (the library card choice in `form_data`, `students.accommodation_type`) are **regenerated whenever that data is saved**: add the slots that now apply, and delete empty slots (no upload yet) that no longer apply. Non-per-level slots store `level = 0`. This also covers the procedure's step 10 ("all dues receipts complete"): **a stage cannot be submitted until every required slot has an upload.**
2. **Submit.** Student submits a stage → status `pending` → notify the matching reviewers. A stage with a fixed fee cannot be submitted until its fee payment is `success`.
3. **Approve.** Reviewer approves → status `approved`, set `reviewed_by`, `reviewed_at`. A stage cannot be approved if it has any `unpaid` charges. Then run the unlock check (below).
4. **Reject.** Reviewer must give a comment and may mark individual documents `rejected` with a `reviewer_note`. Stage → `rejected`, student notified with the reason. **The stage stays `rejected`** so the student can see why. In that state the student may re-upload only the rejected items; when the student resubmits, the stage moves to `pending`. Later stages stay locked.
5. **Audit rejection.** Audit must choose which earlier stage to reopen (`reopen_stage_key`) and give a comment; that stage is set to `rejected` with Audit's comment (same rules as rule 4) and Audit goes back to `locked`.
6. **Unlock check** (after any approval, after payments, and after any `results_released` change): when Admin releases results in bulk (or for one student), run the unlock check for **every affected request** (in batches, each in a transaction) and notify those students, so letters unlock immediately. For every `locked` stage, evaluate its `unlock_rule`; if met, set `awaiting_submission`, set `unlocked_at`, notify the student, and create the fixed-fee `payments` row if `fee_amount` is set. Run inside a DB transaction.
7. **Convocation (auto).** Auto-approves once the student has submitted its uploads and the ₦10,000 payment is `success`. **ASSUMPTION:** Paystack stands in for Remita in this project.
8. **Letter (auto).** When `results_released` is true the student clicks "Generate letter". The server renders the PDF, saves it to `clearance_requests.letter_path`, and the stage is auto-approved.
9. **Audit approve.** In one transaction: set `clearance_requests.status = 'completed'` and `completed_at`; create the `certificates` row; generate the PDF; notify the student.
10. **One active request per student per session** (unique `student_id + session`). The request's `session` comes from `students.graduation_session`; if that is empty, use `CURRENT_SESSION` from `.env`.
10a. **Payment purposes:** `convocation` for the ₦10,000 convocation fee; `stage_fee` for the fixed alumni and security fees; `fine` / `library_fee` for staff-raised charges.
10b. **School fees clearance receipt:** the faculty office issues it on paper at stage 2. The student photographs and uploads it at the Security stage (it is a Security slot). The faculty officer uploads nothing.
11. **Duplicate receipt check.** When a document with a `reference_no` is uploaded, if another student already has the same `(required_doc_id, reference_no)`, set `duplicate_flag = true` and show a warning to the reviewer (do not hard-block).
12. **Audit log** every state change (submit, approve, reject, payment, account changes, imports).

---

## 5. Payments (Paystack)

- Use Paystack test keys during the project. Never put the secret key in the frontend.
- **Fixed fees** (from `workflow_stages.fee_amount`): alumni ₦650, security ₦1,000, convocation ₦10,000. A `payments` row with status `unpaid` is created when the stage unlocks.
- **Variable charges:** a reviewer (faculty missing-teller fine, library cash amount, security file fine) can create a charge on a stage with an amount and description (`purpose = 'fine'` or `'library_fee'`).
- **Flow:** `POST /api/payments/:paymentId/initialize` → server calls Paystack Initialize (amount in kobo, student email, unique `reference`, callback URL) → frontend opens the returned `authorization_url` → Paystack redirects back → server calls Paystack **Verify** and also handles the **webhook** `charge.success`.
- **Webhook must verify the `x-paystack-signature` header** (HMAC-SHA512 of the raw body with the secret key). Make processing idempotent by `reference`. Only mark `success` after the server-side verify call confirms amount and currency.
- Old school fees receipts and Remita tellers are history, **upload-only**, not paid through the system.
- **Report note:** the real university uses Remita; Paystack is a stand-in, and the payment module should be written behind an interface so a Remita adapter could replace it. The report's Section 1.5 (online payment out of scope) must be updated.

---

## 6. Database schema (MySQL 8)

The authoritative schema is `server/src/db/schema.sql`.

### Seed data
`workflow_stages` and `required_documents` seed data live in `server/src/db/seedData.js`. `departmental` is the first stage: "no previous stage" means it unlocks on request creation.

Required documents (Admin can edit these later):
- **departmental:** "Departmental dues receipt (original)", `per_level = true`, with `reference_no`, `amount`, `document_date` inputs.
- **faculty:** per level: "Online school fees receipt", "Remita bank teller", "Faculty dues receipt"; once: "Homecoming receipt".
- **library:** "Library card" (`applies_if = library_registered`); "School fees receipt" and "Passport photograph" (`applies_if = library_not_registered`).
- **alumni:** "Final-year online school fees receipt".
- **student_affairs:** "Accommodation clearance form (filled)"; "Off-campus clearance" (`applies_if = off_campus`).
- **security (display_order = the listed order):** 1 School ID card; 2 School fees clearance receipt; 3 Accommodation clearance; 4 Library clearance; 5 Alumni ID card; 6 Off-campus clearance (`off_campus`).
- **convocation:** "Remita invoice / RRR", "Bank teller", "Payment receipt".

### Form fields (stored in `clearance_stages.form_data`)
- **library:** `{ library_registered: true|false }`
- **student_affairs:** `{ hostel_name, room_no, ... }` (generic accommodation form details)
- **security:** `{ full_name, matric_no, department, phone, hostel_or_address }` (the two details papers)

### Departments and faculties
Create `faculties` and `departments` from the imported class list (distinct values), mapped to UNN faculties.

---

## 7. REST API (suggested)

Auth
- `GET /api/auth/student/lookup?matric_no=` (name preview)
- `POST /api/auth/student/signup` `{ matric_no, full_name, email, password }`
- `POST /api/auth/student/login` `{ matric_no, password }`
- Admin: reset a student account (to build with the Admin routes)
- `POST /api/auth/staff/login` `{ email, password }`
- `POST /api/auth/staff/change-password`
- `GET /api/me`

Student
- `POST /api/clearance` start a request (creates stages and slots)
- `GET /api/clearance/mine` full request with stages, slots, uploads, payments, statuses
- `PUT /api/stages/:stageId/form` save `form_data`
- `POST /api/stages/:stageId/documents` multipart upload (slot id, level, reference_no, amount, document_date)
- `DELETE /api/documents/:id` (only while not submitted/accepted)
- `POST /api/stages/:stageId/submit`
- `POST /api/letter/generate` (only when results released)
- `GET /api/certificate/mine` / `GET /api/certificate/:id/download`
- `GET /api/notifications`, `PATCH /api/notifications/:id/read`

Payments
- `POST /api/payments/:id/initialize`
- `GET /api/payments/verify?reference=...`
- `POST /api/payments/webhook/paystack` (raw body, signature check)
- `POST /api/stages/:stageId/charges` (reviewer raises a fine or charge)

Reviewer (staff roles)
- `GET /api/review/queue` (filtered by role and scope, see below)
- `GET /api/review/stages/:stageId` (student info, documents, payments)
- `POST /api/review/stages/:stageId/approve`
- `POST /api/review/stages/:stageId/reject` `{ comment, documentNotes, reopen_stage_key? }`
- `GET /api/files/:documentId` (authenticated file streaming; allowed for the owning student and reviewers with matching scope)

Admin
- `CRUD /api/admin/staff`, `/api/admin/faculties`, `/api/admin/departments`, `/api/admin/required-documents`
- `POST /api/admin/students/import` (CSV), `PATCH /api/admin/students/results-release` (bulk, by department and session)
- `GET /api/admin/dashboard` (counts by status, average time per stage, bottleneck stage, completion rate)
- `GET /api/admin/requests` (all requests, filters) and `GET /api/admin/reports/clearance.pdf`

Public
- `GET /api/verify/:verification_code` returns `{ valid, name, matric_no, department, issue_date, certificate_no }` with no login.

### Queue filtering rule (enforce on the server from the JWT)
Show stages where `status = 'pending'` and:
- role `departmental`: `stage_key = 'departmental'` and student's `department_id` = staff `department_id`
- role `faculty`: `stage_key = 'faculty'` and student's department's `faculty_id` = staff `faculty_id`
- roles `library`, `alumni`, `student_affairs`, `security`, `audit`: stage with their own key, all students
- role `admin`: read-only view of everything

On approve/reject, re-check that the stage key matches the staff role and that the student is within the staff member's scope.

---

## 8. Certificate

- PDF generated with `pdfkit`: UNN clearance certificate with student name, matric number, department, faculty, session, certificate number, issue date, and a **QR code** linking to the public verification URL (`/verify/<verification_code>`).
- `certificate_no` format e.g. `UNN-CLR-2026-000123`; `verification_code` is a random 32-byte hex (or HMAC), unique.
- **ASSUMPTION:** this is a *clearance certificate* issued after Audit approves; the digital approval stands in for the physical stamped copies. The real degree certificate is collected separately.
- Public page `/verify`: enter or scan the code and see whether it is valid and who it belongs to.

---

## 9. Frontend pages

Student: matric/email/name/department login → dashboard with name and department in header → progress tracker (9 stages with status) → stage page (upload slots with camera/file picker, input fields, payment button, submit) → notifications → certificate download.
Staff (shared shell, role-specific content): login, forced password change, review queue, review page (student info, document viewer with accept/reject per document, duplicate warning, payments, approve/reject with comment, raise charge).
Admin: dashboard and charts (counts, bottleneck stage), staff management, faculty/department management, required-documents editor, student CSV import, results-release toggle, request list, PDF report export.
Public: certificate verification page.
After login, route the user to the dashboard for their `role`.
Make the student screens mobile-first (phone camera capture via `<input type="file" accept="image/*" capture>`).
**Follow the mockups in `docs/ui-design.md`.**

---

## 10. Project structure

```
clearance-system/
  server/
    src/
      config/ (db.js, env.js)
      authProviders/ (localRecordProvider.js)
      middleware/ (auth.js, requireRole.js, upload.js, rateLimit.js)
      services/ (workflowEngine.js, paymentService.js, certificateService.js, letterService.js, notificationService.js, auditLog.js)
      routes/ (auth, clearance, stages, documents, payments, review, admin, verify)
      db/ (schema.sql, seed.js, importStudents.js)
    uploads/ (private, not statically served)
  client/ (Vite + React: pages/, components/, api/, auth/)
  .env.example
  README.md
```

`.env` keys: `CURRENT_SESSION DB_HOST DB_USER DB_PASSWORD DB_NAME JWT_SECRET JWT_EXPIRES_IN PAYSTACK_SECRET_KEY PAYSTACK_PUBLIC_KEY APP_BASE_URL SMTP_* EMAIL_ENABLED UPLOAD_MAX_MB`.

---

## 11. Security requirements

- Hash passwords (bcrypt). Parameterised queries only. Validate input on the server.
- Check role and scope on every route. Never rely on the frontend.
- Uploads: allow only JPEG, PNG, WebP and PDF; size limit; random file names; stored outside the web root; served only through authenticated routes.
- Verify the Paystack webhook signature; make processing idempotent; confirm amount and currency.
- Rate-limit login; set security headers (helmet); CORS limited to the frontend origin.
- Workflow changes (submit, approve, unlock, certificate) run in DB transactions.

---

## 12. Build order

1. **Foundations:** repo, `.env`, DB connection, `schema.sql`, seed scripts (faculties, departments, workflow stages, required documents, test staff accounts: one per role, plus one departmental officer per department and one faculty officer per faculty, plus one Admin; print their passwords).
2. **Student import:** CSV importer (matric_no, full_name, email, department, faculty, levels_count) that creates faculties/departments and students, with an import report.
3. **Auth:** student login (four-field match), staff login, password change, JWT middleware, role and scope middleware.
4. **Workflow engine:** create request and stages, slot generation, unlock check, submit, approve, reject, audit-reject, all in transactions, plus unit tests for the unlock rules.
5. **Uploads and documents:** multer upload, authenticated file serving, duplicate-receipt flag.
6. **Payments:** Paystack initialize, verify, webhook, staff-raised charges; fee gating on submit and approve.
7. **Letter and certificate:** PDF generation, QR code, public verify endpoint.
8. **Notifications and audit log.** Email optional.
9. **Frontend:** student flow first, then the shared staff review UI, then Admin, then the public verify page.
10. **Reports:** Admin dashboard stats and PDF export.
11. **Testing:** end-to-end test of the full happy path with simulated data, rejection and resubmit, payment webhook, wrong-scope access attempts, and certificate verification. Write a README with setup steps.

---

## 13. Test and demo data
Use the supplied class list. Simulate clearance activity. Use Paystack test keys and test cards.

---

## 14. Changes this makes to the project report (Chapters 1 to 3)
- Section 1.5 and Abstract: online payment is now in scope (Paystack, test mode); Remita is noted as the real institutional gateway.
- Section 1.6: reword "simulated data" if a real class list is used (real student details imported, with clearance activity simulated). Add the student-login limitation (Section 3 above).
- Table 3.1 (actors) and the use case diagram: Student plus eight staff roles (Departmental, Faculty, Library, Alumni, Student Affairs, Security, Audit, Admin); Bursary removed.
- Section 3.3.1 (existing system): describe the 10-step UNN procedure.
- Section 3.4: new nine-stage workflow, payments, document uploads, the auto-generated letter.
- Redraw the class, sequence and activity diagrams (the stages are no longer purely sequential: Convocation is "any time", the Letter depends on results release).
- Section 3.5.1: replace the six tables with the schema in section 6.
- Fix the figure numbering in the list of figures (3.4 appears before 3.2).

---

## 15. Open points (implement as stated, easy to change)
1. Faculty (Finance) replaces Bursary.
2. Departmental reviewer is called "departmental clearance officer" (HOD title not used).
3. Digital Audit approval replaces the physical stamping of three copies.
4. Required-document lists per office are the agent's best reading of the procedure sheet; Admin can edit them in-app.
5. Paystack replaces Remita for the demo; Stripe is not used.
6. Students sign up (reg no + name checked against the class list, email, password) and log in with reg no + password, with a name preview after typing the reg no. (Replaces the original four-field match.)
