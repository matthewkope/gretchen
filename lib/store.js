import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.gretchen');
const TASKS_FILE = path.join(DIR, 'tasks.md');
const ARCHIVE_FILE = path.join(DIR, 'archive.md');
const PROJECTS_DIR = path.join(DIR, 'projects');

const TASK_RE = /^(\s*)- \[( |x)\] (.*)$/;
const TAG_RE = /#[\w][\w/-]*/g;

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

// Obsidian Tasks priorities, in rank order. No emoji = normal priority.
export const PRIORITIES = [
  { key: 'highest', emoji: '🔺' },
  { key: 'high', emoji: '⏫' },
  { key: 'medium', emoji: '🔼' },
  { key: 'low', emoji: '🔽' },
  { key: 'lowest', emoji: '⏬' },
];

export function priorityEmoji(key) {
  return PRIORITIES.find((p) => p.key === key)?.emoji || '';
}

export function prioritySuggestions(partial = '') {
  const p = partial.toLowerCase();
  return [{ key: 'none', emoji: '' }, ...PRIORITIES].filter((s) => s.key.startsWith(p));
}

function byDue(a, b) {
  if (!a.date && !b.date) return 0;
  if (!a.date) return 1;
  if (!b.date) return -1;
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

// priority first (no emoji = Obsidian's "normal", between medium and low),
// then due date ascending with undated tasks last
export function compareTasks(a, b) {
  const rank = (t) => {
    const i = PRIORITIES.findIndex((p) => p.key === t.priority);
    return i < 0 ? 2.5 : i; // none → between medium (2) and low (3)
  };
  return rank(a) - rank(b) || byDue(a, b);
}

// Obsidian Tasks-style sort keys ("sort by priority/due/tag/description/status")
export const SORT_KEYS = [
  { key: 'priority', desc: 'priority 🔺→⏬, then due date' },
  { key: 'due', desc: 'earliest due date first, undated last' },
  { key: 'tag', desc: 'first #tag A→Z, untagged last' },
  { key: 'description', desc: 'task text A→Z' },
  { key: 'status', desc: 'open tasks first, then done' },
];

export function sortSuggestions(partial = '') {
  const p = partial.toLowerCase();
  return SORT_KEYS.filter((s) => s.key.startsWith(p));
}

const COMPARATORS = {
  priority: compareTasks,
  due: (a, b) => byDue(a, b) || compareTasks(a, b),
  tag: (a, b) => {
    const ta = getTags(a)[0]?.toLowerCase();
    const tb = getTags(b)[0]?.toLowerCase();
    if (ta !== tb) return !ta ? 1 : !tb ? -1 : ta < tb ? -1 : 1;
    return compareTasks(a, b);
  },
  description: (a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || compareTasks(a, b),
  status: (a, b) => (a.done === b.done ? compareTasks(a, b) : a.done ? 1 : -1),
};

function extractPriority(text) {
  for (const p of PRIORITIES) {
    if (text.includes(p.emoji)) return { priority: p.key, text: text.replace(p.emoji, ' ') };
  }
  return { priority: null, text };
}

// Obsidian Tasks emoji format: description, then priority, 📅 due, ✅ done.
// Sub-tasks are nested checklist lines, indented 4 spaces per level.
// https://publish.obsidian.md/tasks/
export function formatTask(task) {
  let line = `${'    '.repeat(task.indent || 0)}- [${task.done ? 'x' : ' '}] ${task.title}`;
  if (task.priority) line += ` ${priorityEmoji(task.priority)}`;
  if (task.date) line += ` 📅 ${task.date}`;
  if (task.doneDate) line += ` ✅ ${task.doneDate}`;
  return line;
}

export function parseLine(line) {
  const m = line.match(TASK_RE);
  if (!m) return null;
  // tabs, 2-space, or 4-space nesting all map to indent levels
  const indent = Math.ceil(m[1].replace(/\t/g, '    ').length / 4);
  let rest = m[3];
  let date = null;
  let doneDate = null;
  // 📅 is current format; @date is the pre-emoji format, migrated on next save
  const due = rest.match(/(?:📅|@)\s?(\d{4}-\d{2}-\d{2})/u);
  if (due) {
    date = due[1];
    rest = rest.replace(due[0], '');
  }
  const done = rest.match(/✅\s?(\d{4}-\d{2}-\d{2})/u);
  if (done) {
    doneDate = done[1];
    rest = rest.replace(done[0], '');
  }
  const { priority, text } = extractPriority(rest);
  return { done: m[2] === 'x', title: text.replace(/\s{2,}/g, ' ').trim(), date, doneDate, priority, indent };
}

// Groups a flat list into blocks: each top-level task plus its sub-tasks.
export function taskBlocks(tasks) {
  const blocks = [];
  for (let i = 0; i < tasks.length; ) {
    let j = i + 1;
    while (j < tasks.length && (tasks[j].indent || 0) > (tasks[i].indent || 0)) j++;
    blocks.push(tasks.slice(i, j));
    i = j;
  }
  return blocks;
}

// Block-aware sort: parents are ordered by the chosen key, sub-tasks stay attached.
export function sortTasks(tasks, key = 'priority') {
  const cmp = COMPARATORS[key] || compareTasks;
  return taskBlocks(tasks)
    .sort((a, b) => cmp(a[0], b[0]))
    .flat();
}

export function getTags(task) {
  return [...new Set(task.title.match(TAG_RE) || [])];
}

function loadFile(file, header) {
  ensureDir();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# ${header}\n\n`);
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(parseLine)
    .filter(Boolean);
}

function saveFile(file, header, tasks) {
  ensureDir();
  fs.writeFileSync(file, `# ${header}\n\n${tasks.map(formatTask).join('\n')}\n`);
}

// project = null/undefined → the inbox (tasks.md); otherwise a file in projects/
function tasksFile(project) {
  return project ? path.join(PROJECTS_DIR, `${project}.md`) : TASKS_FILE;
}

function tasksHeader(project) {
  return project ? `Project: ${project}` : 'Gretchen Tasks';
}

export function loadTasks(project = null) {
  if (project) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  return loadFile(tasksFile(project), tasksHeader(project));
}

export function saveTasks(tasks, project = null) {
  if (project) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  saveFile(tasksFile(project), tasksHeader(project), tasks);
}

// "my cool project" → "my-cool-project"; returns null if nothing usable remains
export function slugifyProject(name) {
  const slug = name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
  return slug || null;
}

export function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function projectExists(name) {
  return fs.existsSync(tasksFile(name));
}

// existing projects (open-task counts) matching what's typed so far;
// "inbox" is always offered as a destination
export function projectSuggestions(partial = '') {
  const p = partial.toLowerCase().replace(/^#/, '');
  const all = [
    { name: 'inbox', count: loadTasks(null).filter((t) => !t.done).length },
    ...listProjects().map((name) => ({
      name,
      count: loadTasks(name).filter((t) => !t.done).length,
    })),
  ];
  return all.filter((s) => s.name.toLowerCase().startsWith(p));
}

// every task across the inbox and all projects (for the calendar)
export function loadAllTasks() {
  const all = [...loadTasks(null)];
  for (const name of listProjects()) all.push(...loadTasks(name));
  return all;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// year/month/week section labels for an archived task, from its ✅ date
export function archiveSections(task) {
  const date = task.doneDate || today();
  const d = new Date(`${date}T12:00:00`);
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return {
    year: date.slice(0, 4),
    month: MONTHS[d.getMonth()],
    week: `Week of ${MONTHS[monday.getMonth()]} ${monday.getDate()}`,
  };
}

function sortArchive(tasks) {
  return [...tasks].sort((a, b) => ((b.doneDate || '') < (a.doneDate || '') ? -1 : 1));
}

export function loadArchive() {
  return sortArchive(loadFile(ARCHIVE_FILE, 'Gretchen Archive'));
}

// Markdown stays Obsidian-friendly: tasks in Obsidian Tasks emoji format,
// grouped newest-first under # year / ## month / ### week headings.
export function saveArchive(tasks) {
  ensureDir();
  let out = '';
  let prev = {};
  for (const t of sortArchive(tasks)) {
    const s = archiveSections(t);
    if (s.year !== prev.year) out += `\n# ${s.year}\n`;
    if (s.year !== prev.year || s.month !== prev.month) out += `\n## ${s.month}\n`;
    if (s.year !== prev.year || s.month !== prev.month || s.week !== prev.week) out += `\n### ${s.week}\n\n`;
    out += `${formatTask(t)}\n`;
    prev = s;
  }
  fs.writeFileSync(ARCHIVE_FILE, out.replace(/^\n/, ''));
}

export function archiveTask(task) {
  const archive = loadArchive();
  // the archive is flat (grouped by completion week), so nesting is dropped
  archive.unshift({ ...task, done: true, doneDate: task.doneDate || today(), indent: 0 });
  saveArchive(archive);
}

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function today() {
  return iso(new Date());
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DATE_WORD = `\\d{4}-\\d{2}-\\d{2}|today|tomorrow|${WEEKDAYS.join('|')}`;

export function resolveDateWord(word) {
  const w = word.toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  const d = new Date();
  if (w === 'tomorrow') d.setDate(d.getDate() + 1);
  else if (w !== 'today') {
    const target = WEEKDAYS.indexOf(w);
    if (target < 0) return null;
    d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7 || 7));
  }
  return iso(d);
}

// Parse raw input into a task. #tags stay in the description (Obsidian style).
// Dates, in priority order:
//   "@today", "@friday", "@2026-06-15"     — @ followed by a date word
//   "due tomorrow", "due 2026-06-15"       — the word due followed by a date word
//   "call mom tomorrow"                    — a bare trailing date word
// Upcoming-date suggestions for the input menu, filtered by what's typed so far.
export function dateSuggestions(partial = '') {
  const p = partial.toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return [{ label: p, date: p }];
  const now = new Date();
  const add = (days) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
  const list = [
    { label: 'today', date: add(0) },
    { label: 'tomorrow', date: add(1) },
  ];
  for (let i = 2; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    list.push({ label: WEEKDAYS[d.getDay()], date: iso(d) });
  }
  list.push({ label: 'next week', date: add(7) });
  list.push({ label: 'in 2 weeks', date: add(14) });
  return list.filter((s) => s.label.startsWith(p) || s.date.startsWith(p));
}

// Existing tags (most used first) matching what's typed so far.
export function tagSuggestions(tasks, partial = '') {
  const p = partial.toLowerCase().replace(/^#/, '');
  const counts = {};
  for (const t of tasks) for (const tag of getTags(t)) counts[tag] = (counts[tag] || 0) + 1;
  return Object.entries(counts)
    .filter(([tag]) => tag.slice(1).toLowerCase().startsWith(p))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([tag, count]) => ({ tag, count }));
}

// Matches an unfinished "@..." or "due ..." date at the end of the input.
export const DATE_CTX = /(@|\bdue:?\s+)([\w-]*)$/i;

// Live replacement while typing: once a date word after @/due is closed off
// with a space, swap the whole clause for the 📅 emoji form.
export function autoFormatDates(text) {
  const m = text.match(new RegExp(`(@|\\bdue:?\\s+)(${DATE_WORD})(\\s)$`, 'iu'));
  if (!m) return text;
  const resolved = resolveDateWord(m[2]);
  if (!resolved) return text;
  return `${text.slice(0, m.index)}📅 ${resolved} `;
}

// Matches a just-completed "📅 date " at the end of the input, plus whatever
// priority word is being typed after it — drives the priority picker.
export const PRIO_CTX = /📅 (\d{4}-\d{2}-\d{2}) ([a-z]*)$/iu;

export function parseInput(raw) {
  let title = raw.trim().replace(/^- \[[ x]\]\s*/, '');
  let date = null;

  const prio = extractPriority(title);
  const priority = prio.priority;
  title = prio.text.trim();

  const emoji = title.match(/📅\s?(\d{4}-\d{2}-\d{2})/u);
  if (emoji) {
    date = emoji[1];
    title = (title.slice(0, emoji.index) + title.slice(emoji.index + emoji[0].length)).trim();
    return { done: false, title: title.replace(/\s{2,}/g, ' ').trim(), date, doneDate: null, priority, indent: 0 };
  }

  const at = title.match(new RegExp(`@(${DATE_WORD})\\b`, 'i'));
  const due = at ? null : title.match(new RegExp(`\\bdue:?\\s+(${DATE_WORD})\\b`, 'i'));
  const bare = at || due ? null : title.match(new RegExp(`\\b(today|tomorrow|${WEEKDAYS.join('|')})\\s*$`, 'i'));

  const hit = at || due || bare;
  if (hit) {
    const resolved = resolveDateWord(hit[1]);
    if (resolved) {
      date = resolved;
      title = (title.slice(0, hit.index) + title.slice(hit.index + hit[0].length)).trim();
    }
  }

  return { done: false, title: title.replace(/\s{2,}/g, ' ').trim(), date, doneDate: null, priority, indent: 0 };
}
