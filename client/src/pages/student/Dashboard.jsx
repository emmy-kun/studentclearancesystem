import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, downloadFile, formatDate, naira } from '../../api/client.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Alert, Check, Download, Lock } from '../../components/Icons.jsx';
import { ErrorText, PageLoading, StageChip, useToast } from '../../components/ui.jsx';
import { OFFICE, stageSummary } from '../../stageText.js';
import StudentHeader from './StudentHeader.jsx';
import { useClearance, useUnreadCount } from './useClearance.js';

function StageIcon({ stage }) {
  const map = { approved: 'approved', rejected: 'rejected', locked: 'locked', awaiting_submission: 'open', pending: 'pending' };
  const cls = map[stage.status] || 'locked';
  let content = stage.sequence_order;
  if (stage.status === 'approved') content = <Check />;
  else if (stage.status === 'rejected') content = '!';
  else if (stage.status === 'locked') content = <Lock />;
  return <span className={`stage-icon ${cls}`}>{content}</span>;
}

/** The "Action needed at Library" card from the mockup. */
function ActionNeeded({ items }) {
  const first = items[0];
  const parts = [];
  const docs = first.rejected_documents.map((d) => (d.level ? `${d.level} level ${d.name.toLowerCase()}` : d.name.toLowerCase()));
  // Stage sent back: the office's comment. Document rejected during review: that document's note.
  const reason = first.status === 'rejected' ? first.comment : docs.length === 1 ? first.rejected_documents[0].reviewer_note : null;
  if (docs.length === 1) parts.push(`Your ${docs[0]} was rejected${reason ? `: "${reason}"` : '.'}`);
  else if (docs.length > 1) parts.push(`${docs.length} documents were rejected${reason ? `: "${reason}"` : '.'}`);
  else if (first.status === 'rejected') parts.push(first.comment ? `"${first.comment}"` : 'The office sent this stage back to you.');
  const unpaid = first.unpaid.reduce((sum, p) => sum + Number(p.amount), 0);
  if (unpaid > 0) {
    const KIND = { library_fee: 'library fee', fine: 'fine', stage_fee: 'fee', convocation: 'convocation fee' };
    const what = first.unpaid.length === 1 ? KIND[first.unpaid[0].purpose] || 'charge' : 'in charges';
    parts.push(`A ${naira(unpaid)} ${what} is ${parts.length ? 'also ' : ''}waiting.`);
  }

  return (
    <div className="banner red">
      <div className="banner-title">
        <Alert /> Action needed at {OFFICE[first.stage_key] || first.stage_name}
      </div>
      <p style={{ margin: '0 0 14px' }}>{parts.join(' ')}</p>
      <Link to={`/student/stage/${first.stage_id}`} className="btn btn-primary">
        {first.status === 'rejected' ? 'Fix and resubmit' : docs.length ? 'Replace document' : 'Pay now'}
      </Link>
      {items.length > 1 && <p className="small muted" style={{ margin: '10px 0 0' }}>{items.length - 1} more {items.length === 2 ? 'stage also needs' : 'stages also need'} your attention.</p>}
    </div>
  );
}

function CertificateCard() {
  const [cert, setCert] = useState(undefined);
  const toast = useToast();
  useEffect(() => {
    api.get('/certificate/mine').then((d) => setCert(d.certificate)).catch(() => setCert(null));
  }, []);
  if (!cert) return null;
  return (
    <div className="banner green">
      <div className="banner-title">
        <Check /> Clearance complete
      </div>
      <p style={{ margin: '0 0 12px' }}>
        Your clearance certificate <b>{cert.certificate_no}</b> was issued on {formatDate(cert.issue_date)}.
      </p>
      <p className="small" style={{ margin: '0 0 12px' }}>
        {cert.degree_issued_at ? (
          <>
            <b>Degree certificate collected</b> at the Registry on {formatDate(cert.degree_issued_at)}.
          </>
        ) : (
          <>
            <b>Next step:</b> take this certificate (printed or on your phone) and your ID card to the Registry to collect your degree certificate.
          </>
        )}
      </p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => downloadFile(`/certificate/${cert.certificate_id}/download`, `${cert.certificate_no}.pdf`).catch((e) => toast(e.message, 'error'))}
        >
          <Download /> Download certificate
        </button>
        <Link className="btn btn-outline" to={`/verify/${cert.verification_code}`}>
          Verify page
        </Link>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, reload } = useClearance();
  const unread = useUnreadCount();
  const [starting, setStarting] = useState(false);

  async function start() {
    setStarting(true);
    try {
      await api.post('/clearance');
      await reload();
      toast('Clearance started. Departmental clearance and the convocation fee are open.');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setStarting(false);
    }
  }

  if (!data && !error) return <PageLoading />;
  const request = data?.request;

  return (
    <div className="mobile-page">
      <StudentHeader user={user} progress={request ? data.progress : null} unread={unread} />
      <main className="content">
        <ErrorText error={error} />

        {data && !request && (
          <div className="card stack">
            <div className="card-title" style={{ margin: 0 }}>Start your final clearance</div>
            <p className="muted" style={{ margin: 0 }}>
              You will go through nine stages: departmental, faculty, library, alumni, accommodation, security, convocation fee, application letter and a final audit. Upload a clear photo of each document when its stage opens.
            </p>
            <button type="button" className="btn btn-primary btn-lg" onClick={start} disabled={starting} aria-busy={starting}>
              {starting ? 'Starting…' : 'Start clearance'}
            </button>
          </div>
        )}

        {request?.status === 'completed' && <CertificateCard />}
        {request && data.action_needed.length > 0 && <ActionNeeded items={data.action_needed} />}

        {request && (
          <>
            <h2 className="section-title">Your clearance stages</h2>
            <div className="stage-list">
              {data.stages.map((s) => {
                const locked = s.status === 'locked';
                return (
                  <div
                    key={s.stage_id}
                    className={`card ${locked ? 'locked' : 'link'}`}
                    role={locked ? undefined : 'link'}
                    tabIndex={locked ? undefined : 0}
                    onClick={() => !locked && navigate(`/student/stage/${s.stage_id}`)}
                    onKeyDown={(e) => !locked && e.key === 'Enter' && navigate(`/student/stage/${s.stage_id}`)}
                  >
                    <div className="stage-item">
                      <StageIcon stage={s} />
                      <div>
                        <div className="stage-name">
                          {s.sequence_order}. {s.name}
                        </div>
                        <div className="stage-summary">{stageSummary(s, user.levels_count)}</div>
                        <StageChip status={s.status} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <p className="center small" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
            Log out
          </button>
        </p>
      </main>
    </div>
  );
}
