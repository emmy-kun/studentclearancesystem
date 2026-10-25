import { useEffect, useState } from 'react';
import { api, formatDate, openFile } from '../../api/client.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Alert, Check, FileIcon } from '../../components/Icons.jsx';
import { ErrorText, PageLoading, useToast } from '../../components/ui.jsx';

/** Name, reg no., department... in two columns. */
function Details({ rows }) {
  return (
    <div className="registry-details">
      {rows.map(([label, value]) => (
        <div key={label}>
          <div className="small muted">{label}</div>
          <div className="bold">{value}</div>
        </div>
      ))}
    </div>
  );
}

function Collected({ collection }) {
  return (
    <div className="banner amber">
      <div className="banner-title">
        <Alert /> Degree certificate already collected
      </div>
      <div className="small">
        Collected on {formatDate(collection.issued_at, true)}
        {collection.issued_by && <> · recorded by {collection.issued_by}</>}
        {collection.serial_no && <> · serial no. {collection.serial_no}</>}
        {collection.note && <> · “{collection.note}”</>}
      </div>
      <div className="small" style={{ marginTop: 6 }}>Do not hand over another degree certificate.</div>
    </div>
  );
}

/** Record that the signed degree certificate was handed to the student. */
function IssueForm({ result, onIssued }) {
  const toast = useToast();
  const [checked, setChecked] = useState(false);
  const [serial, setSerial] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { certificate } = await api.post(`/registry/certificates/${result.certificate_id}/issue`, { identity_checked: checked, serial_no: serial, note });
      toast('Degree certificate collection recorded');
      onIssued(certificate);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" style={{ gap: 14 }} onSubmit={submit}>
      <div className="card-title" style={{ margin: 0 }}>Hand over the degree certificate</div>
      <label className="row small" style={{ gap: 8, cursor: 'pointer', alignItems: 'flex-start' }}>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ width: 18, height: 18, marginTop: 1, accentColor: 'var(--green)', flex: '0 0 18px' }} />
        <span>I have checked the student’s ID card, and the name and reg number match the details above.</span>
      </label>
      <div className="field-row">
        <div className="field">
          <label htmlFor="serial">Degree certificate serial no. (optional)</label>
          <input id="serial" className="input" value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={40} placeholder="Printed on the certificate" />
        </div>
        <div className="field">
          <label htmlFor="note">Note (optional)</label>
          <input id="note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="e.g. Collected in person" />
        </div>
      </div>
      <ErrorText error={error} />
      <div>
        <button className="btn btn-primary" disabled={busy || !checked} aria-busy={busy}>
          <Check /> {busy ? 'Recording…' : 'Record as collected'}
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>The student is notified, and the collection is recorded with your name. This can only be done once.</p>
    </form>
  );
}

/**
 * Registry: the student brings the clearance certificate; look it up by its number,
 * the QR code or the reg number, check it, then record the degree certificate hand-over.
 */
export default function RegistryCheck() {
  const { user } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function search(e) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.get(`/registry/lookup?q=${encodeURIComponent(q.trim())}`));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Check a clearance certificate</h1>
      <p className="muted">
        Ask the student for their clearance certificate (printed or on their phone). Enter its certificate number, the student’s reg number, or the address from its QR code.
      </p>
      <form className="row registry-search" onSubmit={search}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. CLR-2026-000020 or 2022/248400" autoFocus spellCheck={false} />
        <button className="btn btn-primary" disabled={busy || !q.trim()} aria-busy={busy}>
          {busy ? 'Checking…' : 'Check'}
        </button>
      </form>
      <ErrorText error={error} />

      {result && !result.found && (
        <div className="banner red filled">
          <div className="banner-title">
            <Alert /> No valid clearance certificate
          </div>
          <div className="small">{result.reason} Do not issue a degree certificate.</div>
        </div>
      )}

      {result?.found && (
        <div className="stack" style={{ gap: 14 }}>
          <div className="card stack" style={{ gap: 14 }}>
            <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
              <span className="chip green">
                <Check size={13} /> Genuine · clearance complete
              </span>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => openFile(`/certificate/${result.certificate_id}/download?inline=1`).catch((e) => toast(e.message, 'error'))}>
                <FileIcon size={16} /> View clearance certificate
              </button>
            </div>
            <Details
              rows={[
                ['Name', result.student.full_name],
                ['Reg number', result.student.matric_no],
                ['Department', result.student.department],
                ['Faculty', result.student.faculty],
                ['Session', result.session],
                ['Certificate no.', result.certificate_no],
                ['Clearance certificate issued', formatDate(result.issue_date)],
              ]}
            />
          </div>
          {result.collection ? (
            <Collected collection={result.collection} />
          ) : user.role === 'registry' ? (
            <IssueForm result={result} onIssued={(c) => setResult({ found: true, ...c })} />
          ) : (
            <div className="banner">
              <div className="small">The degree certificate has not been collected yet. Only Registry officers can record a collection.</div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function RegistryCollected() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get('/registry/collected').then((d) => setItems(d.items)).catch(setError);
  }, []);
  return (
    <>
      <h1>Collected degree certificates</h1>
      <p className="muted">Most recent first.</p>
      <ErrorText error={error} />
      {!items ? (
        !error && <PageLoading />
      ) : items.length === 0 ? (
        <div className="card empty">No degree certificates have been collected yet.</div>
      ) : (
        <div className="table-wrap"><table className="list stack-sm">
          <thead>
            <tr>
              <th>Student</th>
              <th>Reg no.</th>
              <th className="hide-sm">Certificate no.</th>
              <th className="hide-sm">Serial no.</th>
              <th>Collected</th>
              <th className="hide-sm">Recorded by</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.certificate_id}>
                <td className="bold">{c.student.full_name}</td>
                <td>{c.student.matric_no}</td>
                <td className="hide-sm">{c.certificate_no}</td>
                <td className="hide-sm">{c.collection.serial_no || '—'}</td>
                <td>{formatDate(c.collection.issued_at, true)}</td>
                <td className="hide-sm">{c.collection.issued_by || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
