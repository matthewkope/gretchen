import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.gretchen');
const TASKS_FILE = path.join(DIR, 'tasks.md');
const ARCHIVE_FILE = path.join(DIR, 'archive.md');
const BOARD_FILE = path.join(DIR, 'kanban.md');
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
  // which sprint a card belonged to when archived (Dataview inline field, so it
  // round-trips through Obsidian and shows as a badge in the archive view)
  if (task.sprint) line += ` [sprint:: ${task.sprint}]`;
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
  // [sprint:: …] marks which sprint an archived card came from
  let sprint = null;
  const sp = rest.match(/\[sprint::\s*([^\]]+)\]/);
  if (sp) {
    sprint = sp[1].trim();
    rest = rest.replace(sp[0], '');
  }
  const { priority, text } = extractPriority(rest);
  return { done: m[2] === 'x', title: text.replace(/\s{2,}/g, ' ').trim(), date, doneDate, priority, sprint, indent };
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

export function archiveTask(task, sprint) {
  const archive = loadArchive();
  // the archive is flat (grouped by completion week), so nesting is dropped.
  // `sprint` (optional) records which sprint board the card came from.
  archive.unshift({ ...task, done: true, doneDate: task.doneDate || today(), indent: 0, sprint: sprint || task.sprint || null });
  saveArchive(archive);
}

// ── Kanban board (kanban.md) ───────────────────────────────────────────────
// A standalone board: `# heading` lines are columns, the task lines under each
// are its cards. Same Obsidian-friendly markdown as everything else, just
// grouped by status instead of by file. Separate from the inbox/projects.
const DEFAULT_COLUMNS = ['To do', 'In Progress', 'Done'];
const BOARDS_DIR = path.join(DIR, 'boards');

// Each board is its own sprint, in its own file. The default board stays at
// kanban.md (so existing data, the CLI, and Obsidian links keep working); any
// extra boards live in ~/.gretchen/boards/<slug>.md. A board is addressed by a
// slug; '' or 'default' means the kanban.md board.
function isDefaultBoard(slug) {
  return !slug || slug === 'default';
}
export function boardFile(slug) {
  return isDefaultBoard(slug) ? BOARD_FILE : path.join(BOARDS_DIR, `${slug}.md`);
}

export function loadBoard(slug) {
  ensureDir();
  const file = boardFile(slug);
  if (!fs.existsSync(file)) {
    const columns = DEFAULT_COLUMNS.map((name) => ({ name, cards: [] }));
    saveBoard(columns, slug);
    return columns;
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let i = 0;
  // skip the Obsidian-Kanban YAML frontmatter (--- … ---), if present
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    i++;
  }
  const columns = [];
  let cur = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('%%')) break; // the %% kanban:settings footer — stop
    const h = line.match(/^#+\s+(.*\S)\s*$/); // ## Lane (also tolerates # / ###)
    if (h) {
      cur = { name: h[1].trim(), cards: [] };
      columns.push(cur);
      continue;
    }
    const t = parseLine(line);
    if (t && cur) cur.cards.push({ ...t, indent: 0 }); // the board is flat
  }
  if (!columns.length) {
    const def = DEFAULT_COLUMNS.map((name) => ({ name, cards: [] }));
    saveBoard(def, slug);
    return def;
  }
  return columns;
}

// Written in the Obsidian Kanban plugin's markdown format, so ~/.gretchen/
// kanban.md opens as a board in Obsidian: a `kanban-plugin: board` frontmatter,
// `## Lane` headings, `- [ ]` card list items, and the settings footer.
export function saveBoard(columns, slug) {
  writeBoard(columns, readSprint(slug), slug); // preserve the sprint frontmatter on every save
}

function writeBoard(columns, sprint, slug) {
  ensureDir();
  const file = boardFile(slug);
  if (!isDefaultBoard(slug)) fs.mkdirSync(BOARDS_DIR, { recursive: true });
  const fence = '```';
  const lanes = columns
    .map((c) => {
      const cards = c.cards.map((t) => formatTask({ ...t, indent: 0 })).join('\n');
      return `## ${c.name}\n\n${cards}${cards ? '\n' : ''}`;
    })
    .join('\n');
  // YAML frontmatter: the kanban-plugin marker plus the sprint fields (so the
  // board stays a time-boxed, named sprint that round-trips through Obsidian too)
  const fm = ['kanban-plugin: board'];
  if (sprint) {
    fm.push(`sprint: ${sprint.number}`);
    if (sprint.name) fm.push(`sprint-name: ${sprint.name}`);
    if (sprint.goal) fm.push(`sprint-goal: ${sprint.goal}`);
    if (sprint.start) fm.push(`sprint-start: ${sprint.start}`);
    if (sprint.end) fm.push(`sprint-end: ${sprint.end}`);
  }
  const body =
    `---\n\n${fm.join('\n')}\n\n---\n\n` +
    lanes +
    `\n\n%% kanban:settings\n${fence}\n{"kanban-plugin":"board"}\n${fence}\n%%\n`;
  fs.writeFileSync(file, body);
}

// ── Sprint metadata (per-board frontmatter) ────────────────────────────────
// Each board is a sprint: a number, a name, a goal, and a start/end date. The
// duration is just end − start (the UI lets you set a length, which sets end).
function addDays(isoStr, n) {
  const d = new Date(`${isoStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
}
function defaultSprint() {
  const start = today();
  return { number: 1, name: '', goal: '', start, end: addDays(start, 13) };
}
// the display label for a sprint: its name, else "Sprint N"
export function sprintLabel(sprint) {
  return (sprint?.name || '').trim() || `Sprint ${sprint?.number || 1}`;
}
// parse just the sprint fields out of a board's frontmatter (no column side effects)
function readSprint(slug) {
  const file = boardFile(slug);
  if (!fs.existsSync(file)) return defaultSprint();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines[0]?.trim() !== '---') return defaultSprint();
  const s = defaultSprint();
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const m = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'sprint') s.number = Number(v) || s.number;
    else if (k === 'sprint-name') s.name = v.trim();
    else if (k === 'sprint-goal') s.goal = v.trim();
    else if (k === 'sprint-start') s.start = v.trim();
    else if (k === 'sprint-end') s.end = v.trim();
  }
  return s;
}

export function loadSprint(slug) {
  ensureDir();
  return readSprint(slug);
}

// patch the sprint frontmatter, leaving the columns untouched
export function saveSprint(patch, slug) {
  const sprint = { ...readSprint(slug), ...patch };
  writeBoard(loadBoard(slug), sprint, slug);
  return sprint;
}

// Start the next sprint on a board: archive the Done column's cards (stamped with
// the sprint they came from), roll the rest forward, bump the number, and stamp
// fresh dates (same length as the sprint just ended).
export function startNewSprint({ goal = '', name, start, end } = {}, slug) {
  const prev = readSprint(slug);
  const board = loadBoard(slug);
  const label = sprintLabel(prev);
  // "Done" by name (case-insensitive), else the last column, is what gets archived
  let idx = board.findIndex((c) => /^done$/i.test(c.name));
  if (idx < 0) idx = board.length - 1;
  let archived = 0;
  if (board[idx]) {
    for (const card of board[idx].cards) { archiveTask(card, label); archived++; }
    board[idx].cards = [];
  }
  const len = Math.max(1, Math.round((new Date(prev.end) - new Date(prev.start)) / 86400000)) || 13;
  const newStart = start || today();
  const sprint = {
    number: (prev.number || 1) + 1,
    name: name != null ? name : '', // a fresh sprint starts unnamed unless given one
    goal,
    start: newStart,
    end: end || addDays(newStart, len),
  };
  writeBoard(board, sprint, slug);
  return { sprint, archived, doneColumn: board[idx]?.name };
}

// ── Multiple boards ─────────────────────────────────────────────────────────
// The default board (kanban.md) plus every ~/.gretchen/boards/*.md, each with
// its own sprint. Slugs are stable ids; the display name comes from the sprint.
export function listBoards() {
  ensureDir();
  const boards = [{ slug: 'default', sprint: readSprint('default') }];
  if (fs.existsSync(BOARDS_DIR)) {
    for (const f of fs.readdirSync(BOARDS_DIR).filter((f) => f.endsWith('.md')).sort()) {
      const slug = f.slice(0, -3);
      boards.push({ slug, sprint: readSprint(slug) });
    }
  }
  return boards.map((b) => ({ ...b, name: sprintLabel(b.sprint) }));
}

// create a new sprint board; the slug is derived from the name and kept unique
export function addBoard({ name = '', goal = '', start, end } = {}) {
  ensureDir();
  fs.mkdirSync(BOARDS_DIR, { recursive: true });
  const base = slugifyProject(name) || 'sprint';
  let slug = base;
  for (let n = 2; fs.existsSync(boardFile(slug)) || isDefaultBoard(slug); n++) slug = `${base}-${n}`;
  const s = start || today();
  const sprint = { number: 1, name: name.trim(), goal, start: s, end: end || addDays(s, 13) };
  writeBoard(DEFAULT_COLUMNS.map((nm) => ({ name: nm, cards: [] })), sprint, slug);
  return { slug, sprint };
}

export function deleteBoard(slug) {
  if (isDefaultBoard(slug)) return { error: 'the default board can’t be deleted' };
  const file = boardFile(slug);
  if (!fs.existsSync(file)) return { error: 'no such board' };
  fs.unlinkSync(file);
  return { ok: true };
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
