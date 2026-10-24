import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, downloadFile, formatDate, naira, openFile } from '../../api/client.js';
import { Download, Warning } from '../../components/Icons.jsx';
import { DocChip, DocThumb, ErrorText, PageLoading, PaymentChip, StageChip, useToast } from '../../components/ui.jsx';
import { levelLabel } from '../../stageText.js';

const NEXT_STAGE = {
  departmental: "the student's Faculty stage",
  faculty: "the student's Library stage",
  library: "the student's Alumni stage",
  alumni: "the student's Accommodation stage",
  student_affairs: "the student's Security stage",
  security: "the student's graduation list stage",
  letter: 'generates the application letter, then the file goes to Audit once every other stage is approved',
};

const FORM_LABELS = {
  library_registered: 'Library registration',
  accommodation_type: 'Accommodation',
  hostel_name: 'Hostel',
  block: 'Block',
  room_no: 'Room',
  bed_space: 'Bed space',
  off_campus_address: 'Off-campus address',
  full_name: 'Full name',
  matric_no: 'Reg number',
  department: 'Department',
  phone: 'Phone',
  hostel_or_address: 'Hostel or address',
  page_no: 'Page their name is on',
  serial_no: 'Number on the list',
};
function formValue(key, value) {
  if (key === 'library_registered') return value ? 'Has a library card' : 'Never registered';
  if (key === 'accommodation_type') return value === 'off_campus' ? 'Off campus' : 'University hostel';
  return String(value);
}

function FormDataCard({ data, title = 'Details filled by the student' }) {
  const entries = Object.entries(data || {});
  if (!entries.length) return null;
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className="info-grid">
        {entries.map(([k, v]) => (
          <div key={k}>
            <div className="k">{FORM_LABELS[k] || k}</div>
            <div className="v" style={{ fontSize: 15 }}>{formValue(k, v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DocFields({ slot }) {
  const d = slot.document;
  const parts = [];
  if (slot.reference_label && d.reference_no) parts.push([slot.reference_label, d.reference_no]);
  if (d.amount != null) parts.push(['Amount', naira(d.amount)]);
  if (d.document_date) parts.push(['Date', formatDate(d.document_date)]);
  if (!parts.length) return null;
  return (
    <div className="doc-fields">
      {parts.map(([k, v]) => (
        <span key={k}>
          {k} <b>{v}</b>
        </span>
      ))}
    </div>
  );
}

const OCR_BADGE = {
  pending: ['grey', 'Reading the document automatically…'],
  match: ['green', '✓ Name and reg number found on the document'],
  partial: ['amber', null],
  no_match: ['amber', 'Name and reg number not found on the document. Check carefully.'],
  unreadable: ['grey', 'Could not read this photo automatically. Check it yourself.'],
  skipped: ['grey', 'PDF: not read automatically. Check it yourself.'],
};

/** The student's details beside the photo, and the automatic (OCR) check result. */
function IdentityCheck({ student, document: d, statedPage }) {
  let [color, text] = OCR_BADGE[d.ocr_status] || [];
  const pages = d.ocr_result?.pages_found;
  if (pages?.length && (d.ocr_status === 'match' || d.ocr_status === 'partial')) {
    const where = `page${pages.length > 1 ? 's' : ''} ${pages.join(', ')}`;
    if (statedPage && !pages.includes(Number(statedPage))) {
      color = 'amber';
      text = `Found on ${where}, but the student said page ${statedPage}. Check carefully.`;
    } else if (d.ocr_status === 'match') {
      text = `✓ Name and reg number found on ${where}${statedPage ? ' (the page the student gave)' : ''}`;
    }
  }
  const partial = d.ocr_status === 'partial' && d.ocr_result
    ? (d.ocr_result.reg_found ? 'Reg number found, but the name was not found. Check the name.' : 'Name found, but the reg number was not found. Check the reg number.')
    : null;
  return (
    <div className="small" style={{ margin: '4px 0 8px' }}>
      <div className="muted">
        Should show: <b style={{ color: 'var(--text)' }}>{student.full_name}</b> · <b style={{ color: 'var(--text)' }}>{student.matric_no}</b>
      </div>
      {color && <span className={`chip ${color}`} style={{ marginTop: 6, whiteSpace: 'normal' }}>{text || partial}</span>}
    </div>
  );
}

/** One document with Accept / Reject with note (saved immediately). */
function DocumentCard({ slot, student, statedPage, showName, canReview, onChanged }) {
  const toast = useToast();
  const d = slot.document;
  const [rejecting, setRejecting] = useState(false);
  const [reconsider, setReconsider] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function decide(status) {
    setBusy(true);
    try {
      await api.patch(`/review/documents/${d.document_id}`, {
        status,
        reviewer_note: status === 'rejected' ? note : undefined,
        identity_confirmed: status === 'accepted' && slot.check_identity ? confirmed : undefined,
      });
      setRejecting(false);
      setReconsider(false);
      setConfirmed(false);
      setNote('');
      await onChanged();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const deciding = canReview && d && (d.status === 'pending' || reconsider) && !rejecting;
  const title = slot.level ? levelLabel(slot.level) : slot.name;
  return (
    <div className="card doc-card">
      <DocThumb documentId={d?.document_id} mimeType={d?.mime_type} large label={d ? 'Loading' : 'Not uploaded'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <span className="bold" style={{ fontSize: 17 }}>{title}</span>
          {d ? <DocChip status={d.status} reviewer /> : <span className="chip grey">Not uploaded (optional)</span>}
        </div>
        {showName && slot.level > 0 && <div className="small muted">{slot.name}</div>}
        {d && <DocFields slot={slot} />}
        {d && slot.check_identity && <IdentityCheck student={student} document={d} statedPage={statedPage} />}
        {d?.duplicate_flag && (
          <div className="banner amber small" style={{ padding: '8px 12px', margin: '6px 0 10px', display: 'flex', gap: 8 }}>
            <Warning /> <span>Duplicate warning: this receipt number is already used on another student's file. Check carefully before accepting.</span>
          </div>
        )}
        {d?.status === 'rejected' && d.reviewer_note && <div className="note red">Note to student: "{d.reviewer_note}"</div>}

        {deciding && (
          <div className="stack" style={{ marginTop: 8, gap: 8 }}>
            {slot.check_identity && (
              <label className="row small" style={{ gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--green)' }} />
                <span>The name and reg number on this document match the student</span>
              </label>
            )}
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={() => decide('accepted')} disabled={busy || (slot.check_identity && !confirmed)}>
                Accept
              </button>
              {d.status !== 'rejected' && (
                <button type="button" className="btn btn-danger" onClick={() => setRejecting(true)} disabled={busy}>
                  Reject with note
                </button>
              )}
              {reconsider && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReconsider(false)}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
        {canReview && d && d.status !== 'pending' && !reconsider && !rejecting && (
          <button type="button" className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }} onClick={() => (d.status === 'accepted' ? setRejecting(true) : setReconsider(true))} disabled={busy}>
            {d.status === 'accepted' ? 'Changed your mind? Reject instead' : 'Accept instead'}
          </button>
        )}
        {canReview && rejecting && (
          <div className="stack" style={{ marginTop: 8, gap: 8 }}>
            <textarea className="textarea" style={{ minHeight: 70 }} placeholder="What is wrong with this document?" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} autoFocus />
            <div className="row">
              <button type="button" className="btn btn-danger btn-sm" disabled={busy || !note.trim()} aria-busy={busy} onClick={() => decide('rejected')}>
                Reject document
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRejecting(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PaymentsCard({ stage, canReview, onChanged }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ amount: '', description: '', purpose: stage.stage_key === 'library' ? 'library_fee' : 'fine' });
  const [busy, setBusy] = useState(false);
  const canCharge = canReview && ['departmental', 'faculty', 'library', 'alumni', 'student_affairs', 'security'].includes(stage.stage_key);

  async function raise(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/stages/${stage.stage_id}/charges`, { ...form, amount: Number(form.amount) });
      setOpen(false);
      setForm({ ...form, amount: '', description: '' });
      toast('Charge added. The student has been notified.');
      await onChanged();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function withdraw(p) {
    try {
      await api.del(`/payments/${p.payment_id}`);
      toast('Charge withdrawn');
      await onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  if (!stage.payments.length && !canCharge) return null;
  return (
    <div className="card stack">
      <div className="spread">
        <div className="card-title" style={{ margin: 0 }}>Payments</div>
        {canCharge && !open && (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpen(true)}>
            Raise a charge
          </button>
        )}
      </div>
      {stage.payments.length === 0 && <p className="muted small" style={{ margin: 0 }}>No payments on this stage.</p>}
      {stage.payments.map((p) => (
        <div key={p.payment_id} className="spread" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div>
            <div className="bold">{p.description}</div>
            <div className="small muted">{p.raised_by_staff ? 'Raised by this office' : 'Fixed fee'}{p.paid_at ? ` · paid ${formatDate(p.paid_at)}` : ''}</div>
          </div>
          <div className="row">
            <span className="bold">{naira(p.amount)}</span>
            <PaymentChip status={p.status} />
            {canReview && p.raised_by_staff && p.status !== 'success' && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => withdraw(p)}>
                Withdraw
              </button>
            )}
          </div>
        </div>
      ))}
      {open && (
        <form className="stack" onSubmit={raise} style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div className="field-row">
            <div className="field">
              <label>Amount (₦)</label>
              <input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
            </div>
            <div className="field">
              <label>Type</label>
              <select className="select" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })}>
                <option value="fine">Fine</option>
                <option value="library_fee">Library fee</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>What is it for?</label>
            <input className="input" placeholder="e.g. Missing 200 level teller" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={255} required />
          </div>
          <div className="row">
            <button className="btn btn-primary btn-sm" disabled={busy} aria-busy={busy}>Add charge</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

function DecisionPanel({ view, onDone }) {
  const toast = useToast();
  const { stage } = view;
  const [comment, setComment] = useState('');
  const [reopen, setReopen] = useState('');
  const [busy, setBusy] = useState(false);
  const isAudit = stage.stage_key === 'audit';

  const docs = stage.slots.filter((s) => s.document).map((s) => s.document);
  const reviewed = docs.filter((d) => d.status !== 'pending').length;
  const allAccepted = docs.every((d) => d.status === 'accepted');
  const unpaid = stage.payments.filter((p) => p.status !== 'success');
  const canApprove = view.can_review && allAccepted && unpaid.length === 0;
  const reopenable = (view.dossier || []).filter((s) => s.status === 'approved');

  async function act(kind) {
    setBusy(true);
    try {
      if (kind === 'approve') await api.post(`/review/stages/${stage.stage_id}/approve`, { comment: comment || undefined });
      else await api.post(`/review/stages/${stage.stage_id}/reject`, { comment, reopen_stage_key: isAudit ? reopen : undefined });
      toast(kind === 'approve' ? `${stage.name} approved for ${view.student.full_name}.` : 'Sent back to the student with your comment.');
      onDone();
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  }

  if (!view.can_review) {
    return (
      <aside className="card decision">
        <div className="card-title">Status</div>
        <StageChip status={stage.status} />
        {stage.comment && <p className="small muted">Last comment: "{stage.comment}"</p>}
        {stage.reviewed_at && <p className="small faint">Decided {formatDate(stage.reviewed_at, true)}</p>}
      </aside>
    );
  }

  return (
    <aside className="card decision stack">
      <div className="card-title" style={{ margin: 0 }}>Decision</div>
      {docs.length > 0 && (
        <div>
          <div className="spread small" style={{ marginBottom: 6 }}>
            <span>{stage.stage_key === 'departmental' || stage.stage_key === 'faculty' ? 'Receipts reviewed' : 'Documents reviewed'}</span>
            <span className="bold">
              {reviewed} of {docs.length}
            </span>
          </div>
          <div className="progress light">
            <span style={{ width: `${docs.length ? (reviewed / docs.length) * 100 : 0}%` }} />
          </div>
        </div>
      )}
      {isAudit && (
        <div className="field">
          <label htmlFor="reopen">Stage to send back (if rejecting)</label>
          <select id="reopen" className="select" value={reopen} onChange={(e) => setReopen(e.target.value)}>
            <option value="">Choose a stage…</option>
            {reopenable.map((s) => (
              <option key={s.stage_key} value={s.stage_key}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor="comment">Comment to student (required if rejecting)</label>
        <textarea id="comment" className="textarea" placeholder="Explain what needs to be fixed" value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      <button type="button" className="btn btn-primary btn-lg btn-disabled-grey" disabled={!canApprove || busy} aria-busy={busy} onClick={() => act('approve')}>
        {isAudit ? 'Approve and issue certificate' : 'Approve stage'}
      </button>
      <p className="small muted" style={{ margin: 0 }}>
        {isAudit
          ? 'Approving completes the clearance and issues the certificate.'
          : `Approve unlocks once every ${stage.stage_key === 'departmental' ? 'receipt' : 'document'} is accepted${unpaid.length ? ' and every charge is paid' : ''}. Approving opens ${NEXT_STAGE[stage.stage_key] || 'the next stage'}.`}
      </p>
      <button type="button" className="btn btn-danger btn-lg" disabled={busy || !comment.trim() || (isAudit && !reopen)} aria-busy={busy} onClick={() => act('reject')}>
        {isAudit ? 'Send back to student' : 'Reject stage'}
      </button>
      <p className="small faint" style={{ margin: 0, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        Every decision is saved with your name and the time.
      </p>
    </aside>
  );
}

/** Open a clearance slip PDF the system issued. */
function SlipLink({ slip }) {
  const toast = useToast();
  return (
    <button type="button" className="btn btn-outline btn-sm" onClick={() => openFile(`/slips/${slip.slip_id}/download?inline=1`).catch((e) => toast(e.message, 'error'))}>
      <Download /> {slip.title}
    </button>
  );
}

/** Security: the slips issued by the earlier offices replace the paper slips students used to bring. */
function EarlierSlips({ items }) {
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="card-title" style={{ margin: 0 }}>Clearance slips from earlier offices</div>
      <p className="small muted" style={{ margin: 0 }}>Issued by the system when each office approved the student. They cannot be edited by the student.</p>
      {items.map((e) => (
        <div key={e.stage_key} className="spread" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, flexWrap: 'wrap' }}>
          <div>
            <div className="bold">{e.stage_name}</div>
            <div className="small muted">
              {e.slip ? `${e.slip.slip_no} · ${formatDate(e.slip.issued_at)}${e.slip.issued_by ? ` · approved by ${e.slip.issued_by}` : ''}` : e.status === 'approved' ? 'Approved' : 'Not approved yet'}
            </div>
          </div>
          {e.slip ? <SlipLink slip={e.slip} /> : <StageChip status={e.status} />}
        </div>
      ))}
    </div>
  );
}

/** Audit sees the whole dossier, read-only, in the spec's order. */
function Dossier({ view }) {
  const toast = useToast();
  return (
    <div className="stack">
      <h2 className="section-title">Clearance file</h2>
      {view.dossier.map((s) => {
        const docs = s.slots.filter((sl) => sl.document);
        return (
          <div key={s.stage_key} className="card stack" style={{ gap: 10 }}>
            <div className="spread">
              <div className="bold" style={{ fontSize: 16 }}>{s.name}</div>
              <StageChip status={s.status} />
            </div>
            {s.slip && (
              <div style={{ alignSelf: 'flex-start' }}>
                <SlipLink slip={s.slip} />
              </div>
            )}
            {s.stage_key === 'letter' && view.request.has_letter && (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => downloadFile(`/letter/${view.request.request_id}/download`, 'Application-letter.pdf').catch((e) => toast(e.message, 'error'))}
              >
                <Download /> Application letter (PDF)
              </button>
            )}
            {s.form_data && <FormDataCard data={s.form_data} title="Details" />}
            {docs.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
                {docs.map((sl) => (
                  <div key={`${sl.required_doc_id}:${sl.level}`} className="stack" style={{ gap: 6 }}>
                    <DocThumb documentId={sl.document.document_id} mimeType={sl.document.mime_type} large />
                    <div className="small bold">{sl.level ? `${sl.name}, ${sl.level} level` : sl.name}</div>
                    {sl.document.reference_no && <div className="small muted">{sl.document.reference_no}</div>}
                    {sl.document.duplicate_flag && <span className="chip amber">Duplicate</span>}
                  </div>
                ))}
              </div>
            )}
            {s.payments.length > 0 && (
              <div className="small muted">
                Payments: {s.payments.map((p) => `${p.description} ${naira(p.amount)} (${p.status === 'success' ? 'paid' : p.status})`).join(', ')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Review() {
  const { stageId } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(
    (quiet = false) =>
      api
        .get(`/review/stages/${stageId}`, { quiet: quiet === true })
        .then(setView)
        .catch(setError),
    [stageId]
  );
  useEffect(() => {
    load();
  }, [load]);

  // While a photo is still being read automatically, refresh so its result appears.
  const reading = view?.stage.slots.some((s) => s.document?.ocr_status === 'pending');
  useEffect(() => {
    if (!reading) return undefined;
    const t = setInterval(() => load(true), 4000);
    return () => clearInterval(t);
  }, [reading, load]);

  if (error) return <ErrorText error={error} />;
  if (!view) return <PageLoading />;
  const { student, stage } = view;
  const distinctDocs = new Set(stage.slots.map((s) => s.name)).size;
  const heading = { departmental: 'Original departmental dues receipts', letter: 'Graduation list' }[stage.stage_key] || 'Documents';

  return (
    <>
      <Link to="/staff" className="back-link">
        ← Back to queue
      </Link>
      <h1>{stage.name.replace(/ \(Final\)$/, '')} review</h1>
      <div className="review-grid">
        <div className="stack">
          <div className="card">
            <div className="info-grid">
              <div><div className="k">Student</div><div className="v">{student.full_name}</div></div>
              <div><div className="k">Matric no.</div><div className="v">{student.matric_no}</div></div>
              <div><div className="k">Department</div><div className="v">{student.department}</div></div>
              <div><div className="k">Levels to clear</div><div className="v">{student.levels}</div></div>
              <div><div className="k">Submitted</div><div className="v">{formatDate(stage.submitted_at, true) || '—'}</div></div>
            </div>
          </div>

          {stage.status === 'rejected' && stage.comment && (
            <div className="banner red filled small">
              <div className="banner-title">Sent back to the student</div>"{stage.comment}"
            </div>
          )}

          <FormDataCard data={stage.form_data} />

          {stage.slots.length > 0 && (
            <>
              <h2 className="section-title">{heading}</h2>
              {stage.slots.map((slot) => (
                <DocumentCard key={`${slot.required_doc_id}:${slot.level}`} slot={slot} student={student} statedPage={stage.stage_key === 'letter' ? stage.form_data?.page_no : undefined} showName={distinctDocs > 1} canReview={view.can_review} onChanged={load} />
              ))}
            </>
          )}

          {view.earlier_slips && <EarlierSlips items={view.earlier_slips} />}
          <PaymentsCard stage={stage} canReview={view.can_review} onChanged={load} />
          {view.dossier && <Dossier view={view} />}
        </div>
        <DecisionPanel view={view} onDone={() => navigate('/staff')} />
      </div>
    </>
  );
}
