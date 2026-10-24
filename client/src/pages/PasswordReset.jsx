import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client.js';
import AuthLayout, { AuthField } from '../components/AuthLayout.jsx';
import { Alert, CheckCircle, IdCard, Lock, Mail } from '../components/Icons.jsx';
import { ErrorText, PageLoading } from '../components/ui.jsx';

const LOGIN = { student: '/student/login', staff: '/staff/login' };

/** Forgot password: ask for the reg number/email; a one-time link is emailed. */
export function ForgotPassword({ portal }) {
  const [params] = useSearchParams();
  const [identifier, setIdentifier] = useState(params.get('matric') || params.get('email') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const student = portal === 'student';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone((await api.post('/auth/forgot-password', { user_type: portal, identifier: identifier.trim() })).message);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      audience={portal}
      title={done ? 'Check your email' : 'Forgot your password?'}
      subtitle={done ? null : student ? 'Enter your reg number or the email you signed up with. We will email you a link to choose a new password.' : 'Enter your staff email. We will email you a link to choose a new password.'}
      footer={
        <span>
          Remembered it? <Link to={LOGIN[portal]}>Back to log in</Link>
        </span>
      }
    >
      {done ? (
        <div className="stack" style={{ gap: 14 }}>
          <div className="banner green">
            <div className="banner-title">
              <Mail /> Reset link sent
            </div>
            <div className="small">{done}</div>
          </div>
          <p className="small muted" style={{ margin: 0 }}>No email after a few minutes? Check your spam folder, or try again.</p>
          <button type="button" className="btn btn-outline btn-block" onClick={() => setDone(null)}>
            Try again
          </button>
        </div>
      ) : (
        <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
          {student ? (
            <AuthField id="identifier" label="Reg number or email" icon={IdCard} placeholder="e.g. 2022/252133 or you@example.com" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" required autoFocus />
          ) : (
            <AuthField id="identifier" label="Email" icon={Mail} type="email" placeholder="you@example.com" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" required autoFocus />
          )}
          <ErrorText error={error} />
          <button className="btn btn-primary btn-block auth-submit" disabled={busy || !identifier.trim()} aria-busy={busy}>
            {busy ? 'Sending link…' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}

/** The page the emailed link opens: choose a new password. */
export function ResetPassword({ portal }) {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [state, setState] = useState('checking'); // checking | ready | invalid | done
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .get(`/auth/reset-password/check?token=${encodeURIComponent(token)}`)
      .then((d) => setState(d.valid ? 'ready' : 'invalid'))
      .catch(() => setState('invalid'));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    if (password !== confirm) return setError('The two passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password });
      setState('done');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const titles = { checking: 'Reset your password', ready: 'Choose a new password', invalid: 'Link not valid', done: 'Password changed' };
  return (
    <AuthLayout audience={portal} title={titles[state]} subtitle={state === 'ready' ? 'Use at least 8 characters. You will log in with it from now on.' : null}>
      {state === 'checking' && <PageLoading />}
      {state === 'invalid' && (
        <div className="stack" style={{ gap: 14 }}>
          <div className="banner red filled">
            <div className="banner-title">
              <Alert /> This reset link is invalid or has expired
            </div>
            <div className="small">Links work once and expire after 30 minutes. Ask for a new one.</div>
          </div>
          <Link className="btn btn-primary btn-block auth-submit" to={`/${portal}/forgot-password`}>
            Get a new link
          </Link>
        </div>
      )}
      {state === 'ready' && (
        <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
          <AuthField id="password" label="New password" icon={Lock} type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          <AuthField id="confirm" label="Confirm new password" icon={Lock} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          <ErrorText error={error} />
          <button className="btn btn-primary btn-block auth-submit" disabled={busy} aria-busy={busy}>
            {busy ? 'Saving…' : 'Save new password'}
          </button>
        </form>
      )}
      {state === 'done' && (
        <div className="stack" style={{ gap: 14 }}>
          <div className="banner green">
            <div className="banner-title">
              <CheckCircle /> Your password has been changed
            </div>
            <div className="small">Log in with your new password.</div>
          </div>
          <Link className="btn btn-primary btn-block auth-submit" to={LOGIN[portal]}>
            Go to log in
          </Link>
        </div>
      )}
    </AuthLayout>
  );
}
