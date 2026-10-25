import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, formatDate } from '../../api/client.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Warning } from '../../components/Icons.jsx';
import { ErrorText, PageLoading } from '../../components/ui.jsx';

/** Stage list for the queue and "Reviewed by me". */
export function StageTable({ items, showStage, showDecision }) {
  const navigate = useNavigate();
  if (items.length === 0) return <div className="card empty">Nothing here right now.</div>;
  return (
    <div className="table-wrap"><table className="list stack-sm">
      <thead>
        <tr>
          <th>Student</th>
          <th>Reg no.</th>
          <th className="hide-sm">Department</th>
          {showStage && <th>Stage</th>}
          <th className="hide-sm">{showDecision ? 'Reviewed' : 'Submitted'}</th>
          {showDecision ? <th>Status</th> : <th className="hide-sm">Documents</th>}
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.stage_id} className="clickable" onClick={() => navigate(`/staff/review/${i.stage_id}`)}>
            <td>
              <div className="bold">{i.full_name}</div>
              {i.duplicates > 0 && (
                <span className="chip amber" style={{ marginTop: 4 }}>
                  <Warning size={13} /> Duplicate receipt
                </span>
              )}
            </td>
            <td>{i.matric_no}</td>
            <td className="hide-sm">{i.department}</td>
            {showStage && <td>{i.stage_name}</td>}
            <td className="hide-sm">{formatDate(showDecision ? i.reviewed_at : i.submitted_at, true)}</td>
            {showDecision ? (
              <td>
                <span className={`chip ${i.status === 'approved' ? 'green' : i.status === 'rejected' ? 'red' : 'grey'}`}>{i.status === 'approved' ? 'Approved' : i.status === 'rejected' ? 'Sent back' : i.status}</span>
              </td>
            ) : (
              <td className="hide-sm">{i.documents}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

export default function Queue() {
  const { user } = useAuth();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .get(`/review/queue${search ? `?search=${encodeURIComponent(search)}` : ''}`, { quiet: !!search })
        .then((d) => setItems(d.items))
        .catch(setError);
    }, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [search]);

  const isAdmin = user.role === 'admin';
  return (
    <>
      <h1>{isAdmin ? 'Pending reviews' : 'Review queue'}</h1>
      <div className="spread" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <p className="muted" style={{ margin: 0 }}>
          {isAdmin ? 'Every stage waiting for an office (read-only).' : 'Students waiting for your decision, oldest first.'}
        </p>
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search name or reg no." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <ErrorText error={error} />
      {items ? <StageTable items={items} showStage={isAdmin || user.role === 'audit' || user.role === 'departmental'} /> : !error && <PageLoading />}
    </>
  );
}

export function History() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get('/review/history').then((d) => setItems(d.items)).catch(setError);
  }, []);
  return (
    <>
      <h1>Reviewed by me</h1>
      <ErrorText error={error} />
      {items ? <StageTable items={items} showDecision /> : !error && <PageLoading />}
    </>
  );
}
