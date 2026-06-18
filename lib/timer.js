import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Local time tracking: every ctrl+t session is appended to ~/.gretchen/time.csv,
// whether or not Toggl is connected. The columns follow Toggl Track's CSV
// import template (Email, Description, Start date, Start time, Duration are
// what their importer requires), so the file uploads straight into
// track.toggl.com — and being plain CSV it works anywhere else too.
const DIR = path.join(os.homedir(), '.gretchen');
const CSV_FILE = path.join(DIR, 'time.csv');
const EMAIL_FILE = path.join(DIR, 'time-email');

const HEADER = 'Email,Project,Description,Start date,Start time,Duration,Tags';

export function timeCsvPath() {
  return CSV_FILE;
}

// Toggl's importer matches rows to workspace members by email
export function getEmail() {
  try {
    return fs.readFileSync(EMAIL_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

export function setEmail(addr) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(EMAIL_FILE, `${addr.trim()}\n`);
}

function csvField(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function two(n) {
  return String(n).padStart(2, '0');
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

export function logEntry({ description, project = '', tags = [], startedAt, stoppedAt }) {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(CSV_FILE)) fs.writeFileSync(CSV_FILE, `${HEADER}\n`);
  const start = new Date(startedAt);
  const row = [
    getEmail(),
    project,
    description,
    `${start.getFullYear()}-${two(start.getMonth() + 1)}-${two(start.getDate())}`,
    `${two(start.getHours())}:${two(start.getMinutes())}:${two(start.getSeconds())}`,
    fmtDuration(stoppedAt - startedAt),
    tags.join(', '),
  ];
  fs.appendFileSync(CSV_FILE, `${row.map(csvField).join(',')}\n`);
}

// summary for /time: entry count, time logged today, total time
export function timeStats() {
  if (!fs.existsSync(CSV_FILE)) return { entries: 0, today: '00:00:00', total: '00:00:00' };
  const lines = fs.readFileSync(CSV_FILE, 'utf8').split('\n').slice(1).filter(Boolean);
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  let today = 0;
  let total = 0;
  for (const line of lines) {
    // duration is the 6th field; naive split is fine unless an earlier field
    // was quoted, in which case fall back to a regex scan for HH:MM:SS
    const cols = line.includes('"') ? null : line.split(',');
    const dur = cols ? cols[5] : (line.match(/\b(\d{2,}):(\d{2}):(\d{2})\b/) || [])[0];
    const m = (dur || '').match(/^(\d+):(\d{2}):(\d{2})$/);
    if (!m) continue;
    const secs = +m[1] * 3600 + +m[2] * 60 + +m[3];
    total += secs;
    const date = cols ? cols[3] : (line.match(/\b\d{4}-\d{2}-\d{2}\b/) || [])[0];
    if (date === todayStr) today += secs;
  }
  return { entries: lines.length, today: fmtDuration(today * 1000), total: fmtDuration(total * 1000) };
}

// minimal CSV row split that respects double-quoted fields
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// this week's tracked time (Mon–Sun): per-day seconds and per-project totals,
// for the home "This week" widget. Pass weekOffset (0 = current, -1 = last).
export function weekStats(weekOffset = 0) {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + weekOffset * 7);
  const LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    days.push({
      date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
      label: LABELS[i],
      short: `${d.getDate()}-${d.getMonth() + 1}`, // e.g. 15-6, like Toggl's axis
      secs: 0,
    });
  }
  const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
  const projects = {};
  let total = 0;
  if (fs.existsSync(CSV_FILE)) {
    const lines = fs.readFileSync(CSV_FILE, 'utf8').split('\n').slice(1).filter(Boolean);
    for (const line of lines) {
      const c = splitCsv(line); // Email, Project, Description, Start date, Start time, Duration, Tags
      const day = byDate[c[3]];
      if (!day) continue;
      const m = (c[5] || '').match(/^(\d+):(\d{2}):(\d{2})$/);
      if (!m) continue;
      const secs = +m[1] * 3600 + +m[2] * 60 + +m[3];
      day.secs += secs;
      const proj = (c[1] || '').trim() || 'Untitled';
      projects[proj] = (projects[proj] || 0) + secs;
      total += secs;
    }
  }
  const projList = Object.entries(projects)
    .sort((a, b) => b[1] - a[1])
    .map(([name, secs]) => ({ name, secs }));
  return { weekStart: days[0].date, days, projects: projList, total };
}
