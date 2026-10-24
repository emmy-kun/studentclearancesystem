import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, formatDate } from '../../api/client.js';
import { Back } from '../../components/Icons.jsx';
import { ErrorText, PageLoading } from '../../components/ui.jsx';

/** Notification list, shared by students (mobile page) and staff (inside the staff shell). */
export function NotificationList() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = () => api.get('/notifications?limit=100').then(setData).catch(setError);
  useEffect(() => {
    load();
  }, []);

  async function markAll() {
    await api.patch('/notifications/read-all');
    load();
  }
  async function markOne(n) {
    if (n.is_read) return;
    await api.patch(`/notifications/${n.notification_id}/read`);
    setData((d) => ({ ...d, unread_count: Math.max(0, d.unread_count - 1), items: d.items.map((x) => (x.notification_id === n.notification_id ? { ...x, is_read: true } : x)) }));
  }

  // Clicking a notification marks it read and opens the page it is about.
  async function open(n) {
    await markOne(n).catch(() => {});
    if (n.link) navigate(n.link);
  }

  if (error) return <ErrorText error={error} />;
  if (!data) return <PageLoading />;
  return (
    <div className="stack">
      <div className="spread">
        <span className="muted small">{data.unread_count} unread</span>
        {data.unread_count > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={markAll}>
            Mark all as read
          </button>
        )}
      </div>
      {data.items.length === 0 && <div className="card empty">No notifications yet.</div>}
      {data.items.map((n) => (
        <button
          type="button"
          key={n.notification_id}
          className="card"
          onClick={() => open(n)}
          style={{ textAlign: 'left', cursor: n.link || !n.is_read ? 'pointer' : 'default', borderLeft: n.is_read ? undefined : '4px solid var(--green)' }}
        >
          <div className={n.is_read ? 'muted' : 'bold'}>{n.message}</div>
          <div className="spread small" style={{ marginTop: 4 }}>
            <span className="faint">{formatDate(n.created_at, true)}</span>
            {n.link && <span style={{ color: 'var(--green)', fontWeight: 600 }}>Open ›</span>}
          </div>
        </button>
      ))}
    </div>
  );
}

export default function StudentNotifications() {
  return (
    <div className="mobile-page">
      <div className="topbar">
        <div className="wrap">
          <Link to="/student" className="topbar-back">
            <Back /> Dashboard
          </Link>
          <h1>Notifications</h1>
        </div>
      </div>
      <main className="content narrow">
        <NotificationList />
      </main>
    </div>
  );
}
