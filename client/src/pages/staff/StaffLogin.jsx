import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api/client.js';
import { useAuth, homeFor } from '../../auth/AuthContext.jsx';
import AuthLayout, { AuthField } from '../../components/AuthLayout.jsx';
import { Key, Lock, Mail } from '../../components/Icons.jsx';
import { ErrorText } from '../../components/ui.jsx';

export default function StaffLogin() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api.post('/auth/staff/login', { email, password });
      navigate(homeFor(signIn(data)), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      audience="staff"
      title="Staff sign in"
      subtitle="For clearance offices and the system administrator."
      footer={<span>Don't have an account? Ask the administrator to create one for you.</span>}
    >
      <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <AuthField id="email" label="Email" icon={Mail} type="email" autoComplete="username" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <AuthField id="password" label="Password" icon={Lock} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <Link className="forgot-link" to={`/staff/forgot-password${email.trim() ? `?email=${encodeURIComponent(email.trim())}` : ''}`}>
          <Key /> Forgot password?
        </Link>
        <ErrorText error={error} />
        <button className="btn btn-primary btn-block auth-submit" disabled={busy} aria-busy={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthLayout>
  );
}
