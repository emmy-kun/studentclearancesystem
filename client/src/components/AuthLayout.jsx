import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import brand from '../brand.js';
import Logo from './Logo.jsx';
import { Check, Close, Eye, EyeOff, IdCard, Menu, Shield, User, UserPlus } from './Icons.jsx';

const SIDE = {
  student: {
    heading: 'Final year clearance, all in one place.',
    points: ['Upload your documents straight from your phone', 'Follow every office’s decision as it happens', 'Pay fees online and get a verifiable certificate'],
  },
  staff: {
    heading: 'Review clearance files for your office.',
    points: ['See the students waiting for your decision', 'Accept or send back each document with a note', 'Every decision is recorded with your name'],
  },
  verify: {
    heading: 'Check a clearance certificate or slip.',
    points: ['Scan the QR code or type the code', 'See who it was issued to and when', 'Works for anyone, no account needed'],
  },
};

const NAV_LINKS = [
  { to: '/student/login', label: 'Student login', icon: IdCard },
  { to: '/staff/login', label: 'Staff login', icon: User },
  { to: '/verify', label: 'Verify certificate', icon: Shield },
  { to: '/student/signup', label: 'Sign up', icon: UserPlus, cta: true },
];

/** Top bar for the public pages: links on wide screens, a hamburger menu on phones. */
function AuthNav() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className="auth-nav">
      <Link to="/student/login" className="auth-nav-brand" aria-label={brand.name}>
        <img className="auth-nav-wordmark" src={brand.wordmark} alt="" />
        <span className="auth-crest">
          <Logo />
        </span>
        <span>
          <span className="auth-brand-name">{brand.shortName}</span>
          <span className="auth-brand-sub">Clearance and certificate issuance</span>
        </span>
      </Link>

      <nav className="auth-nav-links" aria-label="Main">
        {NAV_LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} className={`auth-nav-link${l.cta ? ' auth-nav-cta' : ''}`}>
            {l.label}
          </NavLink>
        ))}
      </nav>

      <button type="button" className="auth-nav-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="auth-menu" aria-label={open ? 'Close menu' : 'Open menu'}>
        {open ? <Close size={22} /> : <Menu />}
      </button>

      {open && (
        <>
          <div className="auth-menu-backdrop" onClick={() => setOpen(false)} />
          <nav id="auth-menu" className="auth-menu" aria-label="Main">
            {NAV_LINKS.map(({ to, label, icon: Icon, cta }) => (
              <NavLink key={to} to={to} className={`auth-menu-link${cta ? ' auth-menu-cta' : ''}`}>
                <span className="auth-menu-icon">
                  <Icon size={18} />
                </span>
                {label}
              </NavLink>
            ))}
          </nav>
        </>
      )}
    </header>
  );
}

/**
 * Split-screen layout for the sign-in pages: a green brand panel (crest, heading,
 * key points) beside the form. On phones the panel shrinks to a compact header.
 * Public pages get the top bar (nav); pages for signed-in users pass nav={false}.
 */
export default function AuthLayout({ title, subtitle, audience = 'student', children, footer, nav = true }) {
  const side = SIDE[audience];
  return (
    <div className={nav ? 'auth-page has-nav' : 'auth-page'}>
      {nav && <AuthNav />}
      <div className="auth-split">
        <aside className={`auth-side auth-side-${audience}`}>
          <div className="auth-brand">
            <span className="auth-crest">
              <Logo />
            </span>
            <span>
              <span className="auth-brand-name">{brand.name}</span>
              <span className="auth-brand-sub">Clearance and certificate issuance</span>
            </span>
          </div>
          <div className="auth-side-body">
            <h2>{side.heading}</h2>
            <ul>
              {side.points.map((p) => (
                <li key={p}>
                  <span className="auth-tick">
                    <Check size={14} />
                  </span>
                  {p}
                </li>
              ))}
            </ul>
          </div>
          <p className="auth-side-foot">© {new Date().getFullYear()} {brand.name}</p>
        </aside>

        <main className="auth-main">
          <div className="auth-form">
            <h1>{title}</h1>
            {subtitle && <p className="auth-sub">{subtitle}</p>}
            {children}
            {footer && <div className="auth-footer">{footer}</div>}
          </div>
        </main>
      </div>
    </div>
  );
}

/** A labelled input with a leading icon; password fields get a show/hide button. */
export function AuthField({ id, label, icon: Icon, type = 'text', hint, ...props }) {
  const [show, setShow] = useState(false);
  const isPassword = type === 'password';
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-wrap">
        {Icon && (
          <span className="input-icon">
            <Icon />
          </span>
        )}
        <input id={id} className="input auth-input" type={isPassword && show ? 'text' : type} {...props} />
        {isPassword && (
          <button type="button" className="input-toggle" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>
            {show ? <EyeOff /> : <Eye />}
          </button>
        )}
      </div>
      {hint && <span className="help">{hint}</span>}
    </div>
  );
}
