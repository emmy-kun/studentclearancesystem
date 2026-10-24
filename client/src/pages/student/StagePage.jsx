import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, downloadFile, naira } from '../../api/client.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Back, Camera, Card, Download } from '../../components/Icons.jsx';
import { DocChip, DocThumb, ErrorText, PageLoading, PaymentChip, useToast } from '../../components/ui.jsx';
import { OFFICE, levelLabel } from '../../stageText.js';
import { useClearance } from './useClearance.js';

const EDITABLE = ['awaiting_submission', 'rejected'];

// ---------------------------------------------------------------------------
// Form sections
// ---------------------------------------------------------------------------

function LibraryForm({ stage, editable, onSave }) {
  const value = stage.form_data?.library_registered;
  const option = (val, label) => (
    <label className={`radio-card${value === val ? ' selected' : ''}${editable ? '' : ' disabled'}`}>
      <input type="radio" name="library_registered" checked={value === val} disabled={!editable} onChange={() => onSave({ library_registered: val })} />
      <span>{label}</span>
    </label>
  );
  return (
    <div className="stack" style={{ gap: 10 }}>
      {option(true, 'I have a library card')}
      {option(false, 'I was never registered with the library')}
    </div>
  );
}

function TextFields({ fields, values, setValues, editable }) {
  return fields.map(([key, label, props = {}]) => (
    <div className="field" key={key}>
      <label htmlFor={key}>{label}</label>
      <input id={key} className="input" value={values[key] || ''} disabled={!editable} onChange={(e) => setValues({ ...values, [key]: e.target.value })} {...props} />
    </div>
  ));
}

function AccommodationForm({ stage, editable, onSave, saving }) {
  const [values, setValues] = useState(stage.form_data || {});
  useEffect(() => setValues(stage.form_data || {}), [stage.form_data]);
  const type = values.accommodation_type;
  const pick = (t) => {
    const next = { ...values, accommodation_type: t };
    setValues(next);
    onSave(next); // changing type changes which documents are needed, so save at once
  };
  return (
    <div className="stack">
      <div className="stack" style={{ gap: 10 }}>
        {[
          ['on_campus', 'I lived in a university hostel'],
          ['off_campus', 'I lived off campus'],
        ].map(([t, label]) => (
          <label key={t} className={`radio-card${type === t ? ' selected' : ''}${editable ? '' : ' disabled'}`}>
            <input type="radio" name="accommodation_type" checked={type === t} disabled={!editable} onChange={() => pick(t)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {type === 'on_campus' && (
        <>
          <TextFields
            editable={editable}
            values={values}
            setValues={setValues}
            fields={[
              ['hostel_name', 'Hostel name', { placeholder: 'e.g. Eni Njoku Hall' }],
              ['block', 'Block (if any)'],
            ]}
          />
          <div className="field-row">
            <TextFields editable={editable} values={values} setValues={setValues} fields={[['room_no', 'Room number'], ['bed_space', 'Bed space']]} />
          </div>
        </>
      )}
      {type === 'off_campus' && <TextFields editable={editable} values={values} setValues={setValues} fields={[['off_campus_address', 'Off-campus address']]} />}
      {editable && type && (
        <button type="button" className="btn btn-outline" disabled={saving} aria-busy={saving} onClick={() => onSave(values)}>
          {saving ? 'Saving…' : 'Save details'}
        </button>
      )}
    </div>
  );
}

function SecurityForm({ stage, editable, onSave, saving, prefill }) {
  const [values, setValues] = useState({ ...prefill, ...(stage.form_data || {}) });
  useEffect(() => setValues({ ...prefill, ...(stage.form_data || {}) }), [stage.form_data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <TextFields
        editable={editable}
        values={values}
        setValues={setValues}
        fields={[
          ['full_name', 'Full name'],
          ['matric_no', 'Reg number'],
          ['department', 'Department'],
          ['phone', 'Phone number', { inputMode: 'tel', autoComplete: 'tel' }],
          ['hostel_or_address', 'Hostel or address'],
        ]}
      />
      {editable && (
        <button type="button" className="btn btn-outline" disabled={saving} aria-busy={saving} onClick={() => onSave(values)}>
          {saving ? 'Saving…' : 'Save details'}
        </button>
      )}
    </div>
  );
}

/** Graduation list: the page (and number) where the student's name appears. */
function ListingForm({ stage, editable, onSave, saving }) {
  const [values, setValues] = useState({ page_no: '', serial_no: '', ...(stage.form_data || {}) });
  useEffect(() => setValues({ page_no: '', serial_no: '', ...(stage.form_data || {}) }), [stage.form_data]);
  return (
    <div className="stack">
      <div className="field-row">
        <div className="field">
          <label htmlFor="page_no">Page number</label>
          <input id="page_no" className="input" inputMode="numeric" value={values.page_no ?? ''} disabled={!editable} onChange={(e) => setValues({ ...values, page_no: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="serial_no">Your number on the list (if any)</label>
          <input id="serial_no" className="input" value={values.serial_no ?? ''} disabled={!editable} onChange={(e) => setValues({ ...values, serial_no: e.target.value })} />
        </div>
      </div>
      {editable && (
        <button type="button" className="btn btn-outline" disabled={saving} aria-busy={saving} onClick={() => onSave(values)}>
          {saving ? 'Saving…' : 'Save details'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload slot
// ---------------------------------------------------------------------------

function SlotCard({ slot, stage, onUpdated }) {
  const toast = useToast();
  const doc = slot.document;
  const fileRef = useRef(null);
  const [ref, setRef] = useState(doc?.reference_no || '');
  const [amount, setAmount] = useState(doc?.amount ? String(doc.amount) : '');
  const [date, setDate] = useState(doc?.document_date ? String(doc.document_date).slice(0, 10) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const stageEditable = EDITABLE.includes(stage.status);
  // Rejected documents can be replaced straight away, even while the rest of the stage is under review.
  const canChange = (stageEditable && doc?.status !== 'accepted') || (stage.status === 'pending' && doc?.status === 'rejected');
  const hasInputs = slot.reference_label || slot.collects_amount || slot.collects_date;

  function pickFile() {
    setError(null);
    if (slot.reference_label && !ref.trim()) return setError(`Enter the ${slot.reference_label.replace(/\.$/, '').toLowerCase()} first`);
    if (slot.collects_amount && !amount.trim()) return setError('Enter the amount on the document first');
    if (slot.collects_date && !date) return setError('Enter the date on the document first');
    fileRef.current?.click();
  }

  async function upload(file) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('required_doc_id', slot.required_doc_id);
    form.append('level', slot.level);
    if (slot.reference_label) form.append('reference_no', ref);
    if (slot.collects_amount) form.append('amount', amount);
    if (slot.collects_date) form.append('document_date', date);
    form.append('file', file);
    try {
      const res = await api.upload(`/stages/${stage.stage_id}/documents`, form);
      onUpdated(res.clearance);
      toast('Uploaded');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    try {
      onUpdated(await api.del(`/documents/${doc.document_id}`));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const title = slot.level ? `${slot.name}, ${levelLabel(slot.level)}` : slot.name;
  return (
    <div className={`slot${doc?.status === 'rejected' ? ' rejected' : ''}`}>
      <div className="slot-head">
        <DocThumb documentId={doc?.document_id} mimeType={doc?.mime_type} />
        <div className="stack" style={{ gap: 6, minWidth: 0 }}>
          <div className="bold">{title}</div>
          <div>
            <DocChip status={doc?.status} />
          </div>
          {doc?.status === 'rejected' && doc.reviewer_note && <div className="note red">Reviewer: "{doc.reviewer_note}"</div>}
          {slot.description && !doc && <div className="note">{slot.description}</div>}
          {!slot.is_required && <div className="note">Optional</div>}
        </div>
      </div>

      {canChange && (
        <>
          <button type="button" className="btn btn-primary btn-block" onClick={pickFile} disabled={busy} aria-busy={busy}>
            <Camera /> {busy ? 'Uploading…' : doc ? 'Retake or choose photo' : 'Take or choose photo'}
          </button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden onChange={(e) => upload(e.target.files[0])} />
        </>
      )}

      {hasInputs && (
        <div className="stack" style={{ gap: 10 }}>
          {slot.reference_label && (
            <div className="field">
              <label>{slot.reference_label.replace(/\.$/, '')}</label>
              <input className="input" value={ref} disabled={!canChange} onChange={(e) => setRef(e.target.value)} maxLength={60} />
            </div>
          )}
          {(slot.collects_amount || slot.collects_date) && (
            <div className="field-row">
              {slot.collects_amount && (
                <div className="field">
                  <label>Amount (₦)</label>
                  <input className="input" inputMode="decimal" value={amount} disabled={!canChange} onChange={(e) => setAmount(e.target.value)} />
                </div>
              )}
              {slot.collects_date && (
                <div className="field">
                  <label>Date on document</label>
                  <input className="input" type="date" value={date} max={new Date().toISOString().slice(0, 10)} disabled={!canChange} onChange={(e) => setDate(e.target.value)} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <ErrorText error={error} />
      {canChange && doc?.status === 'pending' && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={remove} disabled={busy} aria-busy={busy} style={{ alignSelf: 'flex-start' }}>
          Remove upload
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment row
// ---------------------------------------------------------------------------

function PaymentRow({ payment, stage }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function pay() {
    setBusy(true);
    try {
      const { authorization_url } = await api.post(`/payments/${payment.payment_id}/initialize`);
      window.location.assign(authorization_url);
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="bold">{payment.description || `${stage.name} fee`}</div>
          <div className="small muted">{payment.raised_by_staff ? `Amount set by ${OFFICE[stage.stage_key]} staff` : 'Fixed clearance fee'}</div>
        </div>
        <div className="bold" style={{ fontSize: 17 }}>{naira(payment.amount)}</div>
      </div>
      <div>
        <PaymentChip status={payment.status} />
      </div>
      {payment.status !== 'success' && (
        <button type="button" className="btn btn-outline btn-block" onClick={pay} disabled={busy || stage.status === 'locked'} aria-busy={busy}>
          <Card /> {busy ? 'Opening Paystack…' : `Pay ${naira(payment.amount)} online`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function SlipButton({ slip }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className="btn btn-outline btn-sm"
      style={{ marginTop: 10 }}
      onClick={() => downloadFile(`/slips/${slip.slip_id}/download`, `${slip.slip_no}.pdf`).catch((e) => toast(e.message, 'error'))}
    >
      <Download /> Download {slip.title}
    </button>
  );
}

function StatusBanner({ stage }) {
  const office = OFFICE[stage.stage_key];
  if (stage.status === 'rejected') {
    const unpaid = stage.payments.some((p) => p.status !== 'success');
    return (
      <div className="banner red filled">
        <div className="banner-title">Sent back by the {office}</div>
        {stage.comment && <p style={{ margin: '0 0 4px' }}>"{stage.comment}"</p>}
        <div className="small">Fix the item{stage.slots.filter((s) => s.document?.status === 'rejected').length === 1 ? '' : 's'} marked below{unpaid ? ', pay the outstanding fee' : ''}, then resubmit.</div>
      </div>
    );
  }
  if (stage.status === 'pending' && stage.slots.some((s) => s.document?.status === 'rejected')) {
    return (
      <div className="banner red filled">
        <div className="banner-title">The {office} rejected a document</div>
        <div className="small">Take a new photo of the item marked below. It goes straight back to the {office}; the rest of your documents stay under review.</div>
      </div>
    );
  }
  if (stage.status === 'pending') {
    return (
      <div className="banner blue">
        <div className="banner-title">Submitted</div>
        <div className="small">Waiting for the {office} to review your documents. You will be notified of the decision.</div>
      </div>
    );
  }
  if (stage.status === 'approved') {
    return (
      <div className="banner green">
        <div className="banner-title">Approved</div>
        <div className="small">This stage is complete.{stage.slip ? ` Your ${stage.slip.title} has been issued and is attached to your file automatically.` : ''}</div>
        {stage.slip && <SlipButton slip={stage.slip} />}
      </div>
    );
  }
  return null;
}

export default function StagePage() {
  const { stageId } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const { data, setData, error } = useClearance();
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  if (!data && !error) return <PageLoading />;
  const stage = data?.stages?.find((s) => s.stage_id === Number(stageId));
  if (!stage) {
    return (
      <div className="mobile-page content">
        <ErrorText error={error || 'Stage not found'} />
        <Link to="/student">Back to dashboard</Link>
      </div>
    );
  }

  const editable = EDITABLE.includes(stage.status);
  const affairs = data.stages.find((s) => s.stage_key === 'student_affairs')?.form_data || {};
  const securityPrefill = {
    full_name: user.full_name,
    matric_no: user.matric_no,
    department: user.department,
    phone: user.phone || '',
    hostel_or_address: affairs.off_campus_address || [affairs.hostel_name, affairs.room_no && `Room ${affairs.room_no}`].filter(Boolean).join(', '),
  };

  async function saveForm(values) {
    setSaving(true);
    try {
      setData(await api.put(`/stages/${stage.stage_id}/form`, values));
      toast('Saved');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const next = await api.post(`/stages/${stage.stage_id}/submit`);
      setData(next);
      const after = next.stages.find((s) => s.stage_id === stage.stage_id);
      toast(after.status === 'approved' ? `${stage.name} confirmed and approved.` : `Submitted to the ${OFFICE[stage.stage_key]}.`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  }


  let n = 0;
  const sectionTitle = (t) => `${++n}. ${t}`;
  // Nothing to submit for the letter (generated) or for a pay-only automatic stage (convocation completes on payment).
  const payOnly = stage.review_mode === 'auto' && stage.slots.length === 0 && !stage.has_form;
  const showSubmit = editable && !payOnly;
  const hasSide = stage.payments.length > 0 || showSubmit;
  const submitLabel = submitting ? 'Submitting…' : stage.status === 'rejected' ? 'Resubmit for review' : 'Submit for review';

  return (
    <div className="mobile-page">
      <div className="topbar">
        <div className="wrap">
          <Link to="/student" className="topbar-back">
            <Back /> Stage {stage.sequence_order} of {data.progress.total}
          </Link>
          <h1>{stage.name}</h1>
        </div>
      </div>

      <main className="content">
        <StatusBanner stage={stage} />

        {/* Phone: one column. Desktop: documents on the left, payment and submit on the right. */}
        <div className={`stage-layout${hasSide ? '' : ' single'}`}>
        <div className="stage-main">

        {stage.stage_key === 'letter' && (
          <div className="card stack">
            <div className="card-title" style={{ margin: 0 }}>Graduation list and application letter</div>
            <p className="muted" style={{ margin: 0 }}>
              {data.request.has_letter
                ? 'Your department has verified your name on the graduation list. Your letter to the Office of the Deputy Registrar, applying to collect your Statement of Results and Original Degree Certificate, has been generated.'
                : 'Upload the graduation list and enter the page your name is on. Once your department verifies it, your letter to the Office of the Deputy Registrar, applying to collect your Statement of Results and Original Degree Certificate, is generated for you.'}
            </p>
            {data.request.has_letter && (
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => downloadFile(`/letter/${data.request.request_id}/download`, 'Application-letter.pdf').catch((e) => toast(e.message, 'error'))}
              >
                <Download /> Download letter
              </button>
            )}
          </div>
        )}

        {stage.stage_key === 'audit' && (
          <div className="card">
            <p className="muted" style={{ margin: 0 }}>
              The Audit unit reviews your whole clearance file. There is nothing to upload here. If Audit finds a problem, it sends the affected stage back to you with a comment.
            </p>
          </div>
        )}

        {stage.has_form && (
          <section className="card">
            <h2 className="card-title">{sectionTitle({ library: 'Library registration', student_affairs: 'Accommodation details', security: 'Your details', letter: 'Where your name appears' }[stage.stage_key])}</h2>
            {stage.stage_key === 'letter' && <ListingForm stage={stage} editable={editable} onSave={saveForm} saving={saving} />}
            {stage.stage_key === 'library' && <LibraryForm stage={stage} editable={editable && !saving} onSave={saveForm} />}
            {stage.stage_key === 'student_affairs' && <AccommodationForm stage={stage} editable={editable} onSave={saveForm} saving={saving} />}
            {stage.stage_key === 'security' && <SecurityForm stage={stage} editable={editable} onSave={saveForm} saving={saving} prefill={securityPrefill} />}
          </section>
        )}

        {stage.slots.length > 0 && (
          <section className="card stack">
            <h2 className="card-title" style={{ margin: 0 }}>{sectionTitle('Documents to upload')}</h2>
            <div className="slots-grid">
              {stage.slots.map((slot) => (
                <SlotCard key={`${slot.required_doc_id}:${slot.level}:${slot.document?.document_id || 'new'}`} slot={slot} stage={stage} onUpdated={setData} />
              ))}
            </div>
            <p className="help" style={{ margin: 0 }}>Photos must show the whole document, with all text readable. JPG, PNG or PDF, up to 5 MB.</p>
          </section>
        )}
        {stage.has_form && stage.stage_key === 'library' && stage.slots.length === 0 && editable && (
          <p className="help">Choose an option above to see which documents to upload.</p>
        )}
        </div>

        {hasSide && (
        <aside className="stage-side">
        {stage.payments.length > 0 && (
          <section className="card stack">
            <h2 className="card-title" style={{ margin: 0 }}>{sectionTitle('Payment')}</h2>
            {stage.payments.map((p) => (
              <PaymentRow key={p.payment_id} payment={p} stage={stage} />
            ))}
            <p className="help" style={{ margin: 0 }}>
              Paid securely through Paystack. {stage.review_mode === 'auto' ? 'This stage is completed automatically as soon as your payment is confirmed, and your receipt is issued.' : `The ${OFFICE[stage.stage_key]} cannot approve your stage until this is paid.`}
            </p>
          </section>
        )}

        {showSubmit && stage.blockers.length > 0 && (
          <div className="card">
            <div className="bold" style={{ marginBottom: 6 }}>Before you can submit</div>
            <ul style={{ margin: 0, paddingLeft: 20 }} className="muted small">
              {stage.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}
        {showSubmit && (
          <div className="side-submit">
            <button type="button" className="btn btn-primary btn-block btn-lg" onClick={submit} disabled={!stage.can_submit || submitting} aria-busy={submitting}>
              {submitLabel}
            </button>
          </div>
        )}
        <ErrorText error={submitError} />
        </aside>
        )}
        </div>
      </main>

      {showSubmit && (
        <div className="sticky-bottom">
          <div>
            <button type="button" className="btn btn-primary btn-block btn-lg" onClick={submit} disabled={!stage.can_submit || submitting} aria-busy={submitting}>
              {submitLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
