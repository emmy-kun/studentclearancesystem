import { useEffect, useState } from 'react';
import { api, downloadFile, naira } from '../../api/client.js';
import { Download, Warning } from '../../components/Icons.jsx';
import { ErrorText, PageLoading, useToast } from '../../components/ui.jsx';
import { plural } from '../../stageText.js';

function Stat({ label, value, sub }) {
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, margin: '2px 0' }}>{value}</div>
      {sub && <div className="small faint">{sub}</div>}
    </div>
  );
}

/**
 * Files waiting for review per stage: one series, so one hue (brand green,
 * validated), no legend; thin bars with a 4px rounded end; only the extreme is
 * labelled; every bar has a hover tooltip; full numbers are in the table below.
 */
function WaitingChart({ stages }) {
  const [hover, setHover] = useState(null);
  const rows = stages.filter((s) => s.review_mode === 'manual');
  const max = Math.max(1, ...rows.map((s) => s.pending));
  const top = rows.reduce((a, b) => (b.pending > (a?.pending ?? -1) ? b : a), null);
  if (!top || top.pending === 0) return <p className="muted" style={{ margin: 0 }}>No files are waiting for review right now.</p>;
  return (
    <div className="stack" style={{ gap: 2 }} onMouseLeave={() => setHover(null)}>
      {rows.map((s) => (
        <div
          key={s.stage_key}
          onMouseEnter={() => setHover(s.stage_key)}
          style={{ display: 'grid', gridTemplateColumns: '170px 1fr', alignItems: 'center', gap: 12, padding: '5px 0', position: 'relative', cursor: 'default' }}
        >
          <span className="small" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 22, borderLeft: '1px solid var(--border)' }}>
            <div
              style={{
                width: s.pending ? `${(s.pending / max) * 85}%` : 0,
                height: 18,
                background: 'var(--green)',
                borderRadius: '0 4px 4px 0',
                opacity: hover && hover !== s.stage_key ? 0.55 : 1,
                transition: 'opacity .15s',
              }}
            />
            {top && s.stage_key === top.stage_key && s.pending > 0 && <span className="small bold">{s.pending}</span>}
          </div>
          {hover === s.stage_key && (
            <div
              role="tooltip"
              style={{ position: 'absolute', left: 182, top: -34, background: '#1c2420', color: '#fff', fontSize: 12.5, padding: '6px 10px', borderRadius: 8, whiteSpace: 'nowrap', zIndex: 2, pointerEvents: 'none' }}
            >
              <b>{s.name}</b>: {s.pending} waiting · {s.rejected} sent back · avg review {s.avg_review_hours ?? '—'} h
            </div>
          )}
        </div>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 12 }}>
        <span />
        <span className="small faint">Files waiting for the office (0 to {max})</span>
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get('/admin/dashboard').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorText error={error} />;
  if (!data) return <PageLoading />;
  const { students, requests, payments, stages, bottleneck, departments } = data;

  return (
    <>
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <h1>Dashboard</h1>
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => downloadFile('/admin/reports/clearance.pdf', `clearance-report-${new Date().toISOString().slice(0, 10)}.pdf`).catch((e) => toast(e.message, 'error'))}
        >
          <Download /> Export PDF report
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Stat label="Students on class list" value={students.total} sub={`${students.registered} signed up`} />
        <Stat label="Clearances started" value={requests.total} sub={`${requests.in_progress} in progress`} />
        <Stat label="Completed" value={requests.completed} sub={`${requests.completion_rate}% completion rate`} />
        <Stat label="Payments received" value={naira(payments.collected)} sub={plural(payments.count, 'payment')} />
      </div>

      {bottleneck && (
        <div className="banner amber" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Warning />
          <div>
            <b>Bottleneck: {bottleneck.name}</b>. {plural(bottleneck.pending, 'file')} waiting for review
            {bottleneck.avg_review_hours != null ? `, average review time ${bottleneck.avg_review_hours} h` : ''}.
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Files waiting for review, by stage</div>
        <WaitingChart stages={stages} />
      </div>

      <div className="card" style={{ marginBottom: 16, padding: 0, overflow: 'auto' }}>
        <table className="list" style={{ border: 0 }}>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Open</th>
              <th>Waiting</th>
              <th>Sent back</th>
              <th>Approved</th>
              <th className="hide-sm">Avg review (h)</th>
              <th className="hide-sm">Avg total (h)</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s) => (
              <tr key={s.stage_key}>
                <td className="bold">{s.name}</td>
                <td>{s.awaiting_submission}</td>
                <td>{s.pending}</td>
                <td>{s.rejected}</td>
                <td>{s.approved}</td>
                <td className="hide-sm">{s.avg_review_hours ?? '—'}</td>
                <td className="hide-sm">{s.avg_total_hours ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table className="list" style={{ border: 0 }}>
          <thead>
            <tr>
              <th>Department</th>
              <th>Students</th>
              <th>Started</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.department}>
                <td className="bold">{d.department}</td>
                <td>{d.students}</td>
                <td>{d.started}</td>
                <td>{d.completed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
