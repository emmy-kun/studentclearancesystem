import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import BrandMark from '../../components/BrandMark.jsx';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ROLE_LABEL } from '../../stageText.js';
import { Close, Menu } from '../../components/Icons.jsx';

/** Shared staff layout from the reviewer mockup: green sidebar, content on the right. */
export default function StaffShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [queueCount, setQueueCount] = useState(null);
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const isAdmin = user.role === 'admin';
  const isRegistry = user.role === 'registry';

  useEffect(() => {
    if (!isRegistry) api.get('/review/queue', { quiet: true }).then((d) => setQueueCount(d.items.length)).catch(() => {});
    api.get('/notifications?unread=1&limit=1', { quiet: true }).then((d) => setUnread(d.unread_count)).catch(() => {});
    setMenuOpen(false);
  }, [location.pathname]);

  const scope = user.department || user.faculty ? (user.role === 'faculty' ? `Faculty of ${user.faculty}` : user.department) : null;
  const links = [
    ...(isAdmin
      ? [
          ['/admin', 'Dashboard', null, true],
          ['/admin/requests', 'Clearance requests'],
          ['/admin/students', 'Students'],
          ['/admin/staff', 'Staff accounts'],
          ['/admin/structure', 'Faculties & departments'],
          ['/admin/documents', 'Required documents'],
          ['/admin/audit-log', 'Audit log'],
        ]
      : []),
    ...(isRegistry
      ? [
          ['/staff/registry', 'Check certificate', null, true],
          ['/staff/registry/collected', 'Collected certificates'],
        ]
      : [['/staff', isAdmin ? 'Pending reviews' : 'Review queue', queueCount, true]]),
    ...(isAdmin ? [['/staff/registry/collected', 'Degree collections']] : isRegistry ? [] : [['/staff/history', 'Reviewed by me']]),
    ['/staff/notifications', 'Notifications', unread || null],
  ];

  return (
    <div className="staff-shell">
      <aside className="sidebar">
        <Link to={isAdmin ? '/admin' : isRegistry ? '/staff/registry' : '/staff'} className="brand">
          <BrandMark /> Student Clearance
        </Link>
        <nav className="nav">
          {links.map(([to, label, count, end]) => (
            <NavLink key={to} to={to} end={end}>
              <span>{label}</span>
              {count ? <span className="count">{count}</span> : null}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="bold">{user.full_name}</div>
          <div style={{ opacity: 0.85 }}>{ROLE_LABEL[user.role]}</div>
          {scope && <div style={{ opacity: 0.85 }}>{scope}</div>}
          <div className="row" style={{ gap: 8 }}>
            <Link to="/staff/password" style={{ color: '#fff', fontSize: 13, marginTop: 10 }}>
              Change password
            </Link>
            <button type="button" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </aside>

      {/* Phones and narrow windows: a top bar with a menu button instead of the sidebar. */}
      <div className="mobile-staff-bar">
        <div className="mobile-staff-top">
          <Link to={isAdmin ? '/admin' : isRegistry ? '/staff/registry' : '/staff'} className="brand" style={{ fontSize: 15 }}>
            <BrandMark /> Student Clearance
          </Link>
          <button type="button" className="mobile-staff-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-controls="staff-menu" aria-label={menuOpen ? 'Close menu' : 'Open menu'}>
            {menuOpen ? <Close size={22} /> : <Menu />}
            {!menuOpen && (unread || queueCount) ? <span className="mobile-staff-dot" /> : null}
          </button>
        </div>
        {menuOpen && (
          <nav id="staff-menu" className="mobile-staff-menu" aria-label="Main">
            {links.map(([to, label, count, end]) => (
              <NavLink key={to} to={to} end={end}>
                <span>{label}</span>
                {count ? <span className="count">{count}</span> : null}
              </NavLink>
            ))}
            <div className="mobile-staff-who">
              <span className="bold">{user.full_name}</span> · {ROLE_LABEL[user.role]}
              {scope && <> · {scope}</>}
            </div>
            <div className="mobile-staff-actions">
              <Link to="/staff/password">Change password</Link>
              <button type="button" onClick={logout}>
                Log out
              </button>
            </div>
          </nav>
        )}
      </div>

      <main className="staff-main">
        <Outlet />
      </main>
    </div>
  );
}
