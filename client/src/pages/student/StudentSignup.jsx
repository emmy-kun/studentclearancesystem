import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../../api/client.js';
import { useAuth, homeFor } from '../../auth/AuthContext.jsx';
import AuthLayout, { AuthField } from '../../components/AuthLayout.jsx';
import { IdCard, Lock, Mail, User } from '../../components/Icons.jsx';
import { ErrorText } from '../../components/ui.jsx';

/** Sign-up: reg number + name must match the class list; email and password are the student's own. */
export default function StudentSignup() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ matric_no: params.get('matric') || '', full_name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    if (form.password !== form.confirm) return setError('The two passwords do not match');
    setBusy(true);
    setError(null);
    try {
      const { confirm, ...body } = form;
      const data = await api.post('/auth/student/signup', body);
      navigate(homeFor(signIn(data)), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Use your reg number and name exactly as they appear on your class list."
      footer={
        <span>
          Already have an account? <Link to="/student/login">Log in</Link>
        </span>
      }
    >
      <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <AuthField id="matric_no" label="Reg number" icon={IdCard} inputMode="numeric" placeholder="e.g. 2022/252133" value={form.matric_no} onChange={set('matric_no')} required />
        <AuthField id="full_name" label="Full name" icon={User} autoComplete="name" placeholder="SURNAME FIRSTNAME MIDDLENAME" value={form.full_name} onChange={set('full_name')} hint="Surname first, as on the class list." required />
        <AuthField id="email" label="Email address" icon={Mail} type="email" autoComplete="email" placeholder="you@example.com" value={form.email} onChange={set('email')} hint="Clearance updates are sent here." required />
        <div className="field-row">
          <AuthField id="password" label="Password" icon={Lock} type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={set('password')} required />
          <AuthField id="confirm" label="Confirm password" icon={Lock} type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required />
        </div>
        <span className="help" style={{ marginTop: -8 }}>At least 8 characters.</span>
        <ErrorText error={error} />
        <button className="btn btn-primary btn-block auth-submit" disabled={busy} aria-busy={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  );
}
