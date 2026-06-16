// Minimal, zero-dependency iCalendar (RFC 5545) generator for the task export.
// Turns Gretchen tasks into an all-day VEVENT calendar so any calendar app can
// subscribe to `webcal://localhost:<port>/tasks.ics` and see due dates. Served
// live from the store, so editing a task shows up on the next calendar refresh.

const pad = (n) => String(n).padStart(2, '0');

// "2026-06-15" → "20260615" (iCalendar DATE form)
const compact = (iso) => iso.replace(/-/g, '');

// the day after `iso`, as "YYYY-MM-DD" — all-day DTEND is exclusive, so a
// single-day event ends on the following date
function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// UTC timestamp in iCalendar form: 20260615T143000Z
function dtstamp(date) {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

// stable per-task id (FNV-1a) so re-exports keep the same UID and calendars
// update events in place instead of duplicating them
function uid(t) {
  const s = `${t.project || ''}|${t.title || ''}|${t.date || ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}-${s.length}@gretchen`;
}

// escape a text value per RFC 5545 §3.3.11 (backslash first)
function esc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// fold a content line to <=75 octets, continuation lines prefixed with a space
// (RFC 5545 §3.1). Byte-aware so multi-byte chars are never split.
function fold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts = [];
  let seg = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    const max = parts.length === 0 ? 75 : 74; // continuation lines carry a leading space
    if (bytes + b > max) {
      parts.push(seg);
      seg = '';
      bytes = 0;
    }
    seg += ch;
    bytes += b;
  }
  if (seg) parts.push(seg);
  return parts.join('\r\n ');
}

const TAG_RE = /#[\w][\w/-]*/g;

// tasks: array of { title, date, done, doneDate, priority, project }. Only
// tasks with a `date` become events. Completed tasks are kept and marked ✓.
export function tasksToIcs(tasks, { now = new Date(), name = 'Gretchen Tasks' } = {}) {
  const stamp = dtstamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gretchen//Tasks//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    'X-APPLE-CALENDAR-COLOR:#D97757',
  ];

  for (const t of tasks) {
    if (!t.date) continue;
    const clean = (t.title || '').replace(TAG_RE, '').replace(/\s{2,}/g, ' ').trim() || 'task';
    const proj = t.project && t.project !== 'inbox' ? t.project : '';
    const summary = `${t.done ? '✓ ' : ''}${clean}${proj ? ` (${proj})` : ''}`;
    const tags = (t.title.match(TAG_RE) || []).join(' ');
    const desc = [
      proj && `Project: ${proj}`,
      tags && `Tags: ${tags}`,
      t.priority && `Priority: ${t.priority}`,
      t.done && t.doneDate && `Completed: ${t.doneDate}`,
    ]
      .filter(Boolean)
      .join('\n');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid(t)}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${compact(t.date)}`);
    lines.push(`DTEND;VALUE=DATE:${compact(nextDay(t.date))}`);
    lines.push(`SUMMARY:${esc(summary)}`);
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    lines.push('TRANSP:TRANSPARENT'); // don't show the user as "busy" all day
    lines.push(`CATEGORIES:Gretchen${proj ? `,${esc(proj)}` : ''}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
