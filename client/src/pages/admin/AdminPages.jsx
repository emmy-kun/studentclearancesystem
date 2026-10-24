import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, formatDate } from '../../api/client.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { ErrorText, PageLoading, StageChip, useToast } from '../../components/ui.jsx';
import { AUDIT_ACTION, ROLE_LABEL, auditSummary, plural } from '../../stageText.js';

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

function usePaged(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get(path).then(setData).catch(setError), [path]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, reload: load };
}

function Pager({ data, page, setPage }) {
  if (!data || data.total <= data.page_size) return null;
  const pages = Math.ceil(data.total / data.page_size);
  return (
    <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
      <span className="small muted">
        Page {page} of {pages} · {data.total} total
      </span>
      <button type="button" className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
      <button type="button" className="btn btn-outline btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
    </div>
  );
}

function useDepartments() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    api.get('/admin/faculties').then((d) => setItems(d.items)).catch(() => {});
  }, []);
  return items;
}

function DepartmentSelect({ faculties, value, onChange, placeholder = 'All departments', ...rest }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      <option value="">{placeholder}</option>
      {faculties.map((f) => (
        <optgroup key={f.faculty_id} label={`Faculty of ${f.name}`}>
          {f.departments.map((d) => (
            <option key={d.department_id} value={d.department_id}>{d.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function AdminRequests() {
  const navigate = useNavigate();
  const faculties = useDepartments();
  const [filters, setFilters] = useState({ status: '', department_id: '', search: '' });
  const [page, setPage] = useState(1);
  const { data, error } = usePaged(`/admin/requests?${qs({ ...filters, page })}`);
  const set = (k) => (v) => {
    setFilters({ ...filters, [k]: v });
    setPage(1);
  };

  return (
    <>
      <h1>Clearance requests</h1>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 14 }}>
        <input className="input" style={{ maxWidth: 240 }} placeholder="Search name or reg no." value={filters.search} onChange={(e) => set('search')(e.target.value)} />
        <select className="select" style={{ maxWidth: 180 }} value={filters.status} onChange={(e) => set('status')(e.target.value)}>
          <option value="">Any status</option>
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
        </select>
        <div style={{ maxWidth: 260 }}>
          <DepartmentSelect faculties={faculties} value={filters.department_id} onChange={set('department_id')} />
        </div>
      </div>
      <ErrorText error={error} />
      {!data ? (
        !error && <PageLoading />
      ) : data.items.length === 0 ? (
        <div className="card empty">No clearance requests match.</div>
      ) : (
        <div className="table-wrap"><table className="list">
          <thead>
            <tr>
              <th>Student</th>
              <th>Reg no.</th>
              <th className="hide-sm">Department</th>
              <th>Progress</th>
              <th>Current stage</th>
              <th className="hide-sm">Started</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.request_id} className={r.current_stage_id ? 'clickable' : ''} onClick={() => r.current_stage_id && navigate(`/staff/review/${r.current_stage_id}`)}>
                <td className="bold">{r.full_name}</td>
                <td>{r.matric_no}</td>
                <td className="hide-sm">{r.department}</td>
                <td style={{ minWidth: 120 }}>
                  <div className="small">{r.approved} of {r.total_stages}</div>
                  <div className="progress light" style={{ height: 6 }}>
                    <span style={{ width: `${(r.approved / r.total_stages) * 100}%` }} />
                  </div>
                </td>
                <td>
                  {r.status === 'completed' ? (
                    <span className="chip green">Completed {formatDate(r.completed_at)}</span>
                  ) : (
                    <>
                      <div className="small">{r.current_stage}</div>
                      <StageChip status={r.current_status} />
                    </>
                  )}
                </td>
                <td className="hide-sm">{formatDate(r.initiated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <Pager data={data} page={page} setPage={setPage} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Students: list, CSV import, results release, account reset
// ---------------------------------------------------------------------------

/** A ready-made CSV with the right headings and one example row. */
function downloadTemplate(e) {
  e.preventDefault();
  const csv = [
    'matric_no,full_name,email,department,faculty,levels_count,graduation_session',
    '2022/123456,SURNAME FIRSTNAME MIDDLENAME,student@example.com,Computer Science,Physical Sciences,4,2025/2026',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'class-list-template.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function ImportCard({ onDone }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  async function run(e) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await api.upload('/admin/students/import', form);
      setReport(r);
      onDone();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" onSubmit={run}>
      <div className="card-title" style={{ margin: 0 }}>Import class list</div>
      <p className="small muted" style={{ margin: 0 }}>
        Upload the class list as a spreadsheet saved in CSV format (in Excel: <i>File → Save As → CSV</i>). Each row is one student with their reg number, full name, email, department and faculty. Students already on the system are left unchanged.
      </p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="file-pick">
          <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files[0] || null)} />
          <span className="btn btn-outline btn-sm">Choose file</span>
          <span className="small muted">{file ? file.name : 'No file chosen'}</span>
        </label>
        <button className="btn btn-primary btn-sm" disabled={!file || busy} aria-busy={busy}>{busy ? 'Importing…' : 'Import students'}</button>
      </div>
      <div className="row small" style={{ gap: 16, flexWrap: 'wrap' }}>
        <a href="#template" onClick={downloadTemplate}>Download a template</a>
        <details className="help-more">
          <summary>What goes in each column?</summary>
          <ul className="small muted">
            <li><b>Required:</b> reg number, full name (surname first), email, department, faculty</li>
            <li><b>Optional:</b> number of years (4 or 5, default 4), admission year, graduation session (e.g. 2025/2026), accommodation (on or off campus), phone</li>
            <li>New departments and faculties in the file are created automatically.</li>
          </ul>
        </details>
      </div>
      {report && (
        <div className="banner green small">
          <b>Import finished:</b> {plural(report.rows_imported, 'student')} added, {report.rows_skipped} already on the system, {report.rows_failed} could not be added
          {report.departments_created ? `, ${plural(report.departments_created, 'new department')}` : ''}.
          {report.failed.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {report.failed.slice(0, 10).map((f) => (
                <li key={f.row}>Row {f.row} ({f.student}): {f.reason}</li>
              ))}
              {report.failed.length > 10 && <li>…and {report.failed.length - 10} more</li>}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

export function AdminStudents() {
  const toast = useToast();
  const faculties = useDepartments();
  const [filters, setFilters] = useState({ search: '', department_id: '' });
  const [page, setPage] = useState(1);
  const { data, error, reload } = usePaged(`/admin/students?${qs({ ...filters, page })}`);

  async function action(fn, message) {
    try {
      await fn();
      toast(message);
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  async function editEmail(s) {
    const email = window.prompt(`New email for ${s.full_name}`, s.email);
    if (email && email !== s.email) action(() => api.patch(`/admin/students/${s.student_id}`, { email }), 'Email updated');
  }

  return (
    <>
      <h1>Students</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginBottom: 16 }}>
        <ImportCard onDone={reload} />
      </div>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 14 }}>
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search name, reg no. or email" value={filters.search} onChange={(e) => (setFilters({ ...filters, search: e.target.value }), setPage(1))} />
        <div style={{ maxWidth: 260 }}>
          <DepartmentSelect faculties={faculties} value={filters.department_id} onChange={(v) => (setFilters({ ...filters, department_id: v }), setPage(1))} />
        </div>
      </div>
      <ErrorText error={error} />
      {!data ? (
        !error && <PageLoading />
      ) : (
        <div className="table-wrap"><table className="list">
          <thead>
            <tr>
              <th>Student</th>
              <th>Reg no.</th>
              <th className="hide-sm">Email</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((s) => (
              <tr key={s.student_id}>
                <td>
                  <div className="bold">{s.full_name}</div>
                  <div className="small muted">{s.department}</div>
                </td>
                <td>{s.matric_no}</td>
                <td className="hide-sm small">{s.email}</td>
                <td>
                  <div className="actions" style={{ gap: 4 }}>
                    {s.registered ? <span className="chip green">Signed up</span> : <span className="chip grey">No account yet</span>}
                    {s.request_status === 'completed' ? <span className="chip green">Clearance completed</span> : s.request_status ? <span className="chip blue">Clearance in progress</span> : <span className="chip grey">Clearance not started</span>}
                  </div>
                </td>
                <td>
                  <div className="actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => editEmail(s)}>Edit email</button>
                  {s.registered && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--red)' }}
                      onClick={() => window.confirm(`Reset ${s.full_name}'s account? They will have to sign up again.`) && action(() => api.post(`/admin/students/${s.student_id}/reset-account`), 'Account reset')}
                    >
                      Reset account
                    </button>
                  )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <Pager data={data} page={page} setPage={setPage} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Staff accounts
// ---------------------------------------------------------------------------

const ROLES = ['departmental', 'faculty', 'library', 'alumni', 'student_affairs', 'security', 'audit', 'registry', 'admin'];

function NewStaffForm({ faculties, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ full_name: '', email: '', role: 'departmental', department_id: '', faculty_id: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/admin/staff', { ...form, department_id: Number(form.department_id) || null, faculty_id: Number(form.faculty_id) || null });
      onCreated({ email: form.email, password: r.temporary_password });
      setForm({ ...form, full_name: '', email: '' });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="card-title" style={{ margin: 0 }}>Create a staff account</div>
      <div className="field-row">
        <div className="field"><label>Full name</label><input className="input" value={form.full_name} onChange={set('full_name')} required /></div>
        <div className="field"><label>Email</label><input className="input" type="email" value={form.email} onChange={set('email')} required /></div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>Role</label>
          <select className="select" value={form.role} onChange={set('role')}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </div>
        {form.role === 'departmental' && (
          <div className="field"><label>Department</label><DepartmentSelect faculties={faculties} value={form.department_id} onChange={(v) => setForm({ ...form, department_id: v })} placeholder="Choose…" required /></div>
        )}
        {form.role === 'faculty' && (
          <div className="field">
            <label>Faculty</label>
            <select className="select" value={form.faculty_id} onChange={set('faculty_id')} required>
              <option value="">Choose…</option>
              {faculties.map((f) => <option key={f.faculty_id} value={f.faculty_id}>{f.name}</option>)}
            </select>
          </div>
        )}
      </div>
      <button className="btn btn-primary" disabled={busy} aria-busy={busy} style={{ alignSelf: 'flex-start' }}>{busy ? 'Creating…' : 'Create account'}</button>
    </form>
  );
}

export function AdminStaff() {
  const { user } = useAuth();
  const toast = useToast();
  const faculties = useDepartments();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [secret, setSecret] = useState(null);
  const load = useCallback(() => api.get('/admin/staff').then((d) => setItems(d.items)).catch(setError), []);
  useEffect(() => {
    load();
  }, [load]);

  async function toggle(s) {
    try {
      await api.patch(`/admin/staff/${s.staff_id}`, { is_active: !s.is_active });
      toast(s.is_active ? 'Account deactivated' : 'Account reactivated');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  async function reset(s) {
    if (!window.confirm(`Give ${s.full_name} a new temporary password?`)) return;
    try {
      const r = await api.post(`/admin/staff/${s.staff_id}/reset-password`);
      setSecret({ email: s.email, password: r.temporary_password });
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return (
    <>
      <h1>Staff accounts</h1>
      {secret && (
        <div className="banner green" style={{ marginBottom: 14 }}>
          <div className="banner-title">Temporary password for {secret.email}</div>
          <code style={{ fontSize: 18, letterSpacing: 1 }}>{secret.password}</code>
          <div className="small" style={{ marginTop: 6 }}>Give this to the staff member now. It is shown only once; they must change it at first login.</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSecret(null)}>I have noted it</button>
        </div>
      )}
      <div style={{ marginBottom: 16 }}>
        <NewStaffForm faculties={faculties} onCreated={(s) => (setSecret(s), load())} />
      </div>
      <ErrorText error={error} />
      {!items ? (
        !error && <PageLoading />
      ) : (
        <div className="table-wrap"><table className="list">
          <thead>
            <tr><th>Name</th><th>Role</th><th className="hide-sm">Scope</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.staff_id} style={{ opacity: s.is_active ? 1 : 0.6 }}>
                <td><div className="bold">{s.full_name}</div><div className="small muted">{s.email}</div></td>
                <td>{ROLE_LABEL[s.role]}</td>
                <td className="hide-sm">{s.department || (s.faculty ? `Faculty of ${s.faculty}` : 'All students')}</td>
                <td>
                  {s.is_active ? <span className="chip green">Active</span> : <span className="chip grey">Deactivated</span>}
                  {s.must_change_password && s.is_active && <div className="small faint">Has not set a password yet</div>}
                </td>
                <td>
                  {s.staff_id !== user.id && (
                    <div className="actions">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => reset(s)}>Reset password</button>
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: s.is_active ? 'var(--red)' : 'var(--green)' }} onClick={() => toggle(s)}>
                        {s.is_active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Faculties & departments
// ---------------------------------------------------------------------------

export function AdminStructure() {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [newFaculty, setNewFaculty] = useState('');
  const [newDept, setNewDept] = useState({});
  const load = useCallback(() => api.get('/admin/faculties').then((d) => setItems(d.items)), []);
  useEffect(() => {
    load();
  }, [load]);

  async function run(fn, message) {
    try {
      await fn();
      toast(message);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  const rename = (label, current, fn) => {
    const name = window.prompt(`Rename ${label}`, current);
    if (name && name !== current) run(() => fn(name), 'Renamed');
  };

  if (!items) return <PageLoading />;
  return (
    <>
      <h1>Faculties &amp; departments</h1>
      <form className="row card" style={{ marginBottom: 16, flexWrap: 'wrap' }} onSubmit={(e) => (e.preventDefault(), run(() => api.post('/admin/faculties', { name: newFaculty }), 'Faculty added').then(() => setNewFaculty('')))}>
        <input className="input" style={{ maxWidth: 320 }} placeholder="New faculty name" value={newFaculty} onChange={(e) => setNewFaculty(e.target.value)} required />
        <button className="btn btn-primary btn-sm">Add faculty</button>
      </form>
      <div className="stack">
        {items.map((f) => (
          <div key={f.faculty_id} className="card">
            <div className="spread" style={{ marginBottom: 8 }}>
              <div className="bold" style={{ fontSize: 17 }}>Faculty of {f.name}</div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => rename('faculty', f.name, (name) => api.patch(`/admin/faculties/${f.faculty_id}`, { name }))}>Rename</button>
            </div>
            {f.departments.map((d) => (
              <div key={d.department_id} className="spread" style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
                <span>{d.name} <span className="small faint">· {plural(d.students, 'student')}</span></span>
                <span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => rename('department', d.name, (name) => api.patch(`/admin/departments/${d.department_id}`, { name, faculty_id: f.faculty_id }))}>Rename</button>
                  {d.students === 0 && (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => window.confirm(`Delete ${d.name}?`) && run(() => api.del(`/admin/departments/${d.department_id}`), 'Department deleted')}>
                      Delete
                    </button>
                  )}
                </span>
              </div>
            ))}
            <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => (e.preventDefault(), run(() => api.post('/admin/departments', { name: newDept[f.faculty_id], faculty_id: f.faculty_id }), 'Department added').then(() => setNewDept({ ...newDept, [f.faculty_id]: '' })))}>
              <input className="input" style={{ maxWidth: 300 }} placeholder="New department" value={newDept[f.faculty_id] || ''} onChange={(e) => setNewDept({ ...newDept, [f.faculty_id]: e.target.value })} required />
              <button className="btn btn-outline btn-sm">Add</button>
            </form>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Required documents editor
// ---------------------------------------------------------------------------

const APPLIES = { always: 'Always', off_campus: 'Off-campus students only', library_registered: 'Has a library card', library_not_registered: 'Never registered with library' };

function DocForm({ initial, stageKey, onSaved, onCancel }) {
  const toast = useToast();
  const [f, setF] = useState(initial || { name: '', description: '', per_level: false, applies_if: 'always', reference_label: '', collects_amount: false, collects_date: false, check_identity: true, is_required: true, display_order: 10 });
  const set = (k, v) => setF({ ...f, [k]: v });
  async function save(e) {
    e.preventDefault();
    try {
      if (initial) await api.patch(`/admin/required-documents/${initial.required_doc_id}`, f);
      else await api.post('/admin/required-documents', { ...f, stage_key: stageKey });
      toast('Saved');
      onSaved();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  const check = (k, label) => (
    <label className="row small" style={{ gap: 6 }}>
      <input type="checkbox" checked={Boolean(f[k])} onChange={(e) => set(k, e.target.checked)} /> {label}
    </label>
  );
  return (
    <form className="stack" onSubmit={save} style={{ background: '#fafbfa', padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
      <div className="field-row">
        <div className="field"><label>Document name</label><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} required /></div>
        <div className="field"><label>Reference field label</label><input className="input" placeholder="e.g. Receipt no. (blank = none)" value={f.reference_label || ''} onChange={(e) => set('reference_label', e.target.value)} /></div>
      </div>
      <div className="field"><label>Help text for students</label><input className="input" value={f.description || ''} onChange={(e) => set('description', e.target.value)} /></div>
      <div className="field-row">
        <div className="field">
          <label>Applies to</label>
          <select className="select" value={f.applies_if} onChange={(e) => set('applies_if', e.target.value)}>
            {Object.entries(APPLIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="field"><label>Order</label><input className="input" type="number" min={0} max={100} value={f.display_order} onChange={(e) => set('display_order', e.target.value)} /></div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
        {check('per_level', 'One per level (100 to final)')}
        {check('collects_amount', 'Ask for amount')}
        {check('collects_date', 'Ask for date')}
        {check('check_identity', 'Check name and reg number')}
        {check('is_required', 'Required')}
      </div>
      <div className="row">
        <button className="btn btn-primary btn-sm">Save</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function AdminDocuments() {
  const toast = useToast();
  const [stages, setStages] = useState(null);
  const [editing, setEditing] = useState(null); // required_doc_id or `new:<stage>`
  const load = useCallback(() => api.get('/admin/required-documents').then((d) => setStages(d.stages)), []);
  useEffect(() => {
    load();
  }, [load]);

  async function remove(d) {
    if (!window.confirm(`Remove "${d.name}"?`)) return;
    try {
      await api.del(`/admin/required-documents/${d.required_doc_id}`);
      toast('Removed');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  if (!stages) return <PageLoading />;
  const done = () => (setEditing(null), load());
  return (
    <>
      <h1>Required documents</h1>
      <p className="muted" style={{ marginTop: -10 }}>What students upload at each stage. Changes apply to stages that open from now on, and to open stages the next time students view them.</p>
      <div className="stack">
        {stages.filter((s) => !['letter', 'audit'].includes(s.stage_key)).map((s) => (
          <div key={s.stage_key} className="card stack" style={{ gap: 8 }}>
            <div className="spread">
              <div className="bold" style={{ fontSize: 17 }}>{s.sequence_order}. {s.name}</div>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditing(`new:${s.stage_key}`)}>Add document</button>
            </div>
            {s.documents.map((d) =>
              editing === d.required_doc_id ? (
                <DocForm key={d.required_doc_id} initial={d} onSaved={done} onCancel={() => setEditing(null)} />
              ) : (
                <div key={d.required_doc_id} className="spread" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div>
                    <div className="bold">{d.name} {!d.is_required && <span className="chip grey">Optional</span>}</div>
                    <div className="small muted">
                      {[d.per_level && 'one per level', d.applies_if !== 'always' && APPLIES[d.applies_if], d.reference_label && `asks for ${d.reference_label}`, d.collects_amount && 'amount', d.collects_date && 'date', d.check_identity ? 'name & reg number checked' : 'not name-checked', d.uploads && plural(d.uploads, 'upload')].filter(Boolean).join(' · ') || 'photo only'}
                    </div>
                  </div>
                  <span style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(d.required_doc_id)}>Edit</button>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => remove(d)}>Remove</button>
                  </span>
                </div>
              )
            )}
            {editing === `new:${s.stage_key}` && <DocForm stageKey={s.stage_key} onSaved={done} onCancel={() => setEditing(null)} />}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export function AdminAuditLog() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const { data, error } = usePaged(`/admin/audit-logs?${qs({ action, page })}`);
  return (
    <>
      <h1>Audit log</h1>
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <select className="select" style={{ maxWidth: 260 }} value={action} onChange={(e) => (setAction(e.target.value), setPage(1))}>
          <option value="">All actions</option>
          <option value="stage.">Stage decisions</option>
          <option value="document.">Documents</option>
          <option value="payment.">Payments</option>
          <option value="staff.">Staff accounts</option>
          <option value="student">Students & sign-ups</option>
          <option value="auth.">Logins</option>
          <option value="results.">Results release</option>
        </select>
      </div>
      <ErrorText error={error} />
      {!data ? (
        !error && <PageLoading />
      ) : (
        <div className="table-wrap"><table className="list">
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th className="hide-sm">Details</th></tr>
          </thead>
          <tbody>
            {data.items.map((l) => (
              <tr key={l.log_id}>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{formatDate(l.created_at, true)}</td>
                <td className="small">{l.actor_name || (l.actor_type === 'system' ? 'System' : 'Removed account')}</td>
                <td>{AUDIT_ACTION[l.action] || l.action}</td>
                <td className="hide-sm small muted" style={{ maxWidth: 420 }}>
                  {auditSummary(l.detail)}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <Pager data={data} page={page} setPage={setPage} />
    </>
  );
}
