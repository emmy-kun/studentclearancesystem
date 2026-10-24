import { Link } from 'react-router';
import BrandMark from '../../components/BrandMark.jsx';
import { Bell } from '../../components/Icons.jsx';

/** Green header from the dashboard mockup: brand, bell, name, department, matric, progress. */
export default function StudentHeader({ user, progress, unread = 0 }) {
  const pct = progress ? Math.round((progress.approved / progress.total) * 100) : 0;
  return (
    <header className="s-header">
      <div className="wrap">
        <div className="s-header-top">
          <Link to="/student" className="brand">
            <BrandMark /> Student Clearance
          </Link>
          <Link to="/student/notifications" className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
            <Bell />
            {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
          </Link>
        </div>
        <h1 className="s-name">{user.full_name}</h1>
        <div className="s-meta">
          {user.department} · Faculty of {user.faculty}
        </div>
        <div className="s-meta">
          Matric no. {user.matric_no}
          {user.class_of ? ` · Class of ${user.class_of}` : ''}
        </div>
        {progress && (
          <>
            <div className="progress-label">
              <span>Clearance progress</span>
              <span>
                {progress.approved} of {progress.total} stages approved
              </span>
            </div>
            <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </div>
          </>
        )}
      </div>
    </header>
  );
}
