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
