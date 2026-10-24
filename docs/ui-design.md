# UI design (agreed mockups)

The frontend must follow the three mockups in `docs/ui-mockups/`:

| File | Screen |
|---|---|
| `student-dashboard.png` | Student dashboard (mobile) |
| `student-stage-page.png` | Student stage page, shown for Library after a rejection (mobile) |
| `reviewer-review-page.png` | Staff review page, shown for Departmental (desktop) |

## Visual language
- Brand colour: deep UNN green (approx `#146C3C`) for the header, sidebar, primary buttons and progress fill. White cards with a 1px light-grey border and rounded corners (about 12px) on a light grey page background.
- Clean sans-serif (Inter or system UI), bold headings, muted grey secondary text.
- Status chips (small, rounded, tinted background):
  - **Approved / Accepted**: green tint
  - **Action needed / Rejected**: red tint
  - **Locked**: grey tint
  - **Open now / Awaiting your decision**: blue tint
  - **Unpaid** and the duplicate warning: amber tint
- Rejection banners: pale red background, red border, red title.
- Primary button is solid green. Secondary is a green outline. Destructive is a red outline ("Reject stage", "Reject with note").

## Student dashboard (mobile-first)
- Green header with an app mark and "Student Clearance", and a notification bell with an unread count badge.
- Student name (large), then "Department · Faculty of …", then "Matric no. … · Class of 2026" (Class of = end year of `graduation_session`).
- "Clearance progress" with "N of 9 stages approved" and a progress bar.
- **Action needed card** (only when something is waiting on the student): the office's rejection comment in quotes, plus any unpaid charge ("A ₦3,000 library fee is also waiting."), and a "Fix and resubmit" button.
- "Your clearance stages": one card per stage, with a numbered icon (tick when approved, "!" when rejected, padlock when locked, number when open), the stage name, a one-line summary including the fee, and a status chip.
  - Chip labels: `approved` → Approved, `rejected` → Action needed, `locked` → Locked, `awaiting_submission` → Open now, `pending` → Under review.
  - Convocation adds "can be done any time". The Letter is described as "Generated for you once results are released".

## Student stage page (mobile-first)
- Green top bar with a back arrow, "Stage X of 9", and the stage name as the title.
- Rejection banner when the stage is `rejected` ("Sent back by the <office>", plus what to do).
- Numbered sections:
  1. **Form fields** for the stage (e.g. Library registration radio cards: "I have a library card" / "I was never registered with the library").
  2. **Documents to upload**: per slot, a thumbnail, the document name, a status chip, the reviewer note when rejected, a full-width "Retake or choose photo" button (camera capture), and the reference input with a per-document label (e.g. "Library card number"), plus amount and date inputs where the document collects them. Help text: "Photos must show the whole document, with all text readable. JPG, PNG or PDF, up to 5 MB."
  3. **Payment**: description, amount, who set it ("Amount set by Library staff"), status chip, an outline "Pay ₦X online" button, and the note "Paid securely through Paystack. The <office> cannot approve your stage until this is paid."
- A sticky full-width bottom button: "Submit for review" or "Resubmit for review".

## Staff review page (desktop)
- Green left sidebar: app mark, "Review queue" with a count badge, "Reviewed by me", "Notifications". The signed-in staff member's name, role and scope are at the bottom (e.g. "Mr. Obi / Departmental officer / Computer Science").
- "← Back to queue", the page title "<Stage> review".
- A student info card: Student, Matric no., Department, "Levels to clear 100 to 400", Submitted time.
- Document cards: thumbnail, level, status chip ("Accepted" / "Awaiting your decision" / "Rejected"), receipt no., amount, date, an amber **duplicate warning** when `duplicate_flag`, and **Accept** / **Reject with note** buttons per document (saved immediately).
- A right-hand **Decision** panel: "Receipts reviewed X of N" with a progress bar, a "Comment to student (required if rejecting)" textarea, an **Approve stage** button (disabled until every document is accepted, with the explanation "Approve unlocks once every receipt is accepted. Approving opens the student's <next> stage."), a **Reject stage** button, and the footer "Every decision is saved with your name and the time."

## Additions to the spec that these mockups require
1. `required_documents` gets `reference_label VARCHAR(60) NULL` (label for the reference input, e.g. "Receipt no.", "Library card number"; NULL = no reference field), `collects_amount BOOLEAN`, and `collects_date BOOLEAN`.
2. Per-document review endpoint: `PATCH /api/review/documents/:documentId` `{ status: 'accepted'|'rejected', reviewer_note }`, saved immediately and audit-logged.
3. **Approve stage requires every document in the stage to be `accepted`** (as well as no unpaid charges). Enforced on the server.
4. `GET /api/review/history`: stages reviewed by the current staff member ("Reviewed by me").
5. Staff receive in-app notifications too (e.g. a new submission in their queue).
6. While a stage is `rejected`, the student can pay outstanding charges and replace rejected documents before resubmitting.
