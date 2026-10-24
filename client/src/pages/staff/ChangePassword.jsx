import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client.js';
import { useAuth, homeFor } from '../../auth/AuthContext.jsx';
import AuthLayout, { AuthField } from '../../components/AuthLayout.jsx';
import { Lock } from '../../components/Icons.jsx';
import { ErrorText } from '../../components/ui.jsx';

/** Forced on first login (must_change_password), and available later from the shell. */
export default function ChangePassword() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const forced = user?.must_change_password;

  async function submit(e) {
    e.preventDefault();
    if (form.new_password !== form.confirm) return setError('The two new passwords do not match');
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/auth/staff/change-password', { current_password: form.current_password, new_password: form.new_password });
      setUser(res.user);
      navigate(homeFor(res.user), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      nav={false}
      audience="staff"
      title={forced ? 'Set your own password' : 'Change password'}
      subtitle={forced ? 'For security, replace the password you were given before continuing.' : 'Choose a new password for your account.'}
      footer={
        forced ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={logout} style={{ alignSelf: 'center' }}>
            Log out
          </button>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(-1)} style={{ alignSelf: 'center' }}>
            Cancel
          </button>
        )
      }
    >
      <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <div className="banner green small" style={{ padding: '10px 12px' }}>
          Account: <b>{user?.email}</b>
          <div className="muted" style={{ marginTop: 2 }}>Next time, log in with this email and your new password.</div>
        </div>
        <AuthField id="cur" label={forced ? 'Password you were given' : 'Current password'} icon={Lock} type="password" autoComplete="current-password" value={form.current_password} onChange={set('current_password')} required />
        <AuthField id="new" label="New password" icon={Lock} type="password" autoComplete="new-password" minLength={8} value={form.new_password} onChange={set('new_password')} hint="At least 8 characters." required />
        <AuthField id="confirm" label="Confirm new password" icon={Lock} type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required />
        <ErrorText error={error} />
        <button className="btn btn-primary btn-block auth-submit" disabled={busy} aria-busy={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </AuthLayout>
  );
}
