import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api/client.js';
import { useAuth, homeFor } from '../../auth/AuthContext.jsx';
import AuthLayout, { AuthField } from '../../components/AuthLayout.jsx';
import { IdCard, Key, Lock } from '../../components/Icons.jsx';
import { ErrorText, Spinner } from '../../components/ui.jsx';

const MATRIC = /^\d{4}\/\d{5,7}$/;
const initials = (name) => name.split(/\s+/).slice(0, 2).map((n) => n[0]).join('');

/**
 * Student login: type the reg number -> the matching name appears -> tap it ->
 * enter the password chosen at sign-up.
 */
export default function StudentLogin() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [matric, setMatric] = useState('');
  const [lookup, setLookup] = useState({ state: 'idle' }); // idle | loading | found | missing | error
  const [chosen, setChosen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef(null);

  useEffect(() => {
    setChosen(false);
    setPassword('');
    setError(null);
    const value = matric.trim();
    if (!MATRIC.test(value)) {
      setLookup({ state: 'idle' });
      return undefined;
    }
    setLookup({ state: 'loading' });
    const t = setTimeout(() => {
      api
        .get(`/auth/student/lookup?matric_no=${encodeURIComponent(value)}`, { quiet: true })
        .then((d) => setLookup({ state: 'found', ...d }))
        .catch((err) => setLookup(err.status === 404 ? { state: 'missing' } : { state: 'error', message: err.message }));
    }, 350);
    return () => clearTimeout(t);
  }, [matric]);

  useEffect(() => {
    if (chosen) formRef.current?.querySelector('#password')?.focus();
  }, [chosen]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api.post('/auth/student/login', { matric_no: matric.trim(), password });
      navigate(homeFor(signIn(data)), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Log in to continue your final year clearance."
      footer={
        <>
          <span>
            New here? <Link to="/student/signup">Create your clearance account</Link>
          </span>
          <span>
            <Link to="/student/forgot-password" className="forgot-inline">
              <Key /> Forgot your password?
            </Link>
          </span>
        </>
      }
    >
      <form ref={formRef} className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <AuthField id="matric" label="Reg number" icon={IdCard} inputMode="numeric" autoComplete="username" placeholder="e.g. 2022/252133" value={matric} onChange={(e) => setMatric(e.target.value)} autoFocus />

        {lookup.state === 'loading' && (
          <div className="row muted small">
            <Spinner /> Finding your account…
          </div>
        )}
        {lookup.state === 'missing' && (
          <div className="banner amber small">
            No clearance account for this reg number yet. <Link to={`/student/signup?matric=${encodeURIComponent(matric.trim())}`}>Create your account</Link>
          </div>
        )}
        {lookup.state === 'error' && <ErrorText error={lookup.message} />}

        {lookup.state === 'found' && !chosen && (
          <button type="button" className="lookup-result" onClick={() => setChosen(true)}>
            <span className="avatar">{initials(lookup.display_name)}</span>
            <span>
              <span className="bold" style={{ display: 'block' }}>{lookup.display_name}</span>
              <span className="small muted">{lookup.department} · tap to continue</span>
            </span>
          </button>
        )}

        {lookup.state === 'found' && chosen && (
          <>
            <div className="row small muted">
              <span className="avatar" style={{ width: 32, height: 32, flexBasis: 32, fontSize: 13 }}>{initials(lookup.display_name)}</span>
              <span>
                Logging in as <b style={{ color: 'var(--text)' }}>{lookup.display_name}</b> · {lookup.department}
              </span>
            </div>
            <AuthField id="password" label="Password" icon={Lock} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Link className="forgot-link" to={`/student/forgot-password?matric=${encodeURIComponent(matric.trim())}`}>
              <Key /> Forgot password?
            </Link>
            <ErrorText error={error} />
            <button className="btn btn-primary btn-block auth-submit" disabled={busy || !password} aria-busy={busy}>
              {busy ? 'Logging in…' : 'Log in'}
            </button>
          </>
        )}
      </form>
    </AuthLayout>
  );
}
