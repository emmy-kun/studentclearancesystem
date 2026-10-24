// One-off helper: turns the pasted class list ("1. SURNAME FIRST MIDDLE - 2022/123456")
// into the CSV format the importer expects. The source list has only names and
// matric numbers, so the other columns are filled with simulated defaults.
//
//   node scripts/convertClassList.js ../data/class-list-raw.txt ../data/class-list.csv
import fs from 'node:fs';

const DEFAULTS = {
  department: 'Computer Science',
  faculty: 'Physical Sciences',
  levels_count: 4,
  graduation_session: '2025/2026',
  emailDomain: 'clearance.test', // simulated; a .test domain can never reach a real inbox
};

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('Usage: node scripts/convertClassList.js <raw.txt> <out.csv>');
  process.exit(1);
}

const LINE = /^\s*\d+\.\s*(.+?)\s+-\s+(\d{4}\/\d+)\s*$/;
const clean = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
const csvField = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;

const rows = [];
const unparsed = [];
for (const line of fs.readFileSync(inPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const m = LINE.exec(line);
  if (!m) {
    unparsed.push(line);
    continue;
  }
  const fullName = m[1].replace(/\s+/g, ' ').trim();
  const matric = m[2];
  const [year, digits] = matric.split('/');
  const [surname, first] = fullName.split(' ');
  const local = [clean(surname), clean(first)].filter(Boolean).join('.');
  rows.push({
    matric_no: matric,
    full_name: fullName,
    email: `${local}.${digits}@${DEFAULTS.emailDomain}`,
    department: DEFAULTS.department,
    faculty: DEFAULTS.faculty,
    levels_count: DEFAULTS.levels_count,
    admission_year: year,
    graduation_session: DEFAULTS.graduation_session,
  });
}

const header = Object.keys(rows[0]);
const out = [header.join(','), ...rows.map((r) => header.map((h) => csvField(r[h])).join(','))].join('\n');
fs.writeFileSync(outPath, out + '\n');

console.log(`Wrote ${rows.length} rows to ${outPath}`);
if (unparsed.length) console.log(`Could not parse ${unparsed.length} lines:\n  ${unparsed.join('\n  ')}`);
