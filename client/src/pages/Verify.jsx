import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, formatDate } from '../api/client.js';
import AuthLayout, { AuthField } from '../components/AuthLayout.jsx';
import { Alert, Check, IdCard, Shield } from '../components/Icons.jsx';
import { Spinner } from '../components/ui.jsx';

/**
 * Public verification, no login: type the certificate number and the student's reg
 * number, or scan the QR code on a certificate or slip (opens /verify/<code>).
 */
export default function Verify() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [mode, setMode] = useState(code ? 'code' : 'number'); // number | code
  const [certNo, setCertNo] = useState('');
  const [matric, setMatric] = useState('');
  const [input, setInput] = useState(code || '');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const check = (path) => {
    setLoading(true);
    setResult(null);
    api
      .get(path)
      .then(setResult)
      .catch((err) => setResult({ valid: false, error: err.message }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (code) check(`/verify/${encodeURIComponent(code)}`);
  }, [code]);

  function submit(e) {
    e.preventDefault();
    if (mode === 'number') {
      check(`/verify?certificate_no=${encodeURIComponent(certNo.trim())}&matric_no=${encodeURIComponent(matric.trim())}`);
    } else {
      const c = input.trim().split('/').pop();
      if (c) navigate(`/verify/${c}`);
    }
  }

  function switchMode(next) {
    setMode(next);
    setResult(null);
  }

  return (
    <AuthLayout
      audience="verify"
      title="Verify a document"
      subtitle={
        mode === 'number'
          ? 'Enter the certificate number and the student’s reg number, or scan the QR code on the certificate.'
          : 'Enter the verification code printed under the QR code on a certificate or clearance slip.'
      }
    >
      <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
        {mode === 'number' ? (
          <>
            <AuthField id="certificate_no" label="Certificate number" icon={Shield} value={certNo} onChange={(e) => setCertNo(e.target.value)} placeholder="e.g. CLR-2026-000019" spellCheck={false} autoCapitalize="characters" required />
            <AuthField id="matric_no" label="Reg number" icon={IdCard} inputMode="numeric" value={matric} onChange={(e) => setMatric(e.target.value)} placeholder="e.g. 2022/252133" required />
          </>
        ) : (
          <AuthField id="code" label="Verification code" icon={Shield} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Code from the certificate or slip" spellCheck={false} required />
        )}
        <button className="btn btn-primary btn-block auth-submit" disabled={loading} aria-busy={loading}>
          {loading ? 'Checking…' : 'Check document'}
        </button>
        <button type="button" className="link-button small" onClick={() => switchMode(mode === 'number' ? 'code' : 'number')}>
          {mode === 'number' ? 'Checking a clearance slip? Use its verification code' : 'Use the certificate number instead'}
        </button>
      </form>

      {loading && (
        <div className="row muted">
          <Spinner /> Checking…
        </div>
      )}
      {result?.valid && (
        <div className="banner green">
          <div className="banner-title">
            <Check /> Valid {result.document || 'certificate'}
          </div>
          <div className="stack" style={{ gap: 4, marginTop: 6 }}>
            <div><span className="muted">Name:</span> <b>{result.name}</b></div>
            <div><span className="muted">Reg no.:</span> <b>{result.matric_no}</b></div>
            <div><span className="muted">Department:</span> {result.department}, Faculty of {result.faculty}</div>
            <div><span className="muted">Session:</span> {result.session}</div>
            {result.type === 'slip' ? (
              <div><span className="muted">Slip no.:</span> {result.slip_no}</div>
            ) : (
              <div><span className="muted">Certificate no.:</span> {result.certificate_no}</div>
            )}
            <div><span className="muted">Issued:</span> {formatDate(result.issue_date)}</div>
          </div>
        </div>
      )}
      {result && !result.valid && (
        <div className="banner red filled">
          <div className="banner-title">
            <Alert /> Not a valid document
          </div>
          <div className="small">{result.error || (mode === 'number'
            ? 'No certificate matches this certificate number and reg number. Check both for typing mistakes.'
            : 'No clearance certificate or slip matches this code. It may have been typed wrongly or altered.')}</div>
        </div>
      )}
    </AuthLayout>
  );
}
