// Gretchen UI — vanilla JS over the JSON API. One global state object,
// re-fetched after every mutation; render() rebuilds the DOM from it.
const $ = (id) => document.getElementById(id);

let S = null;            // last /api/state payload
let project = 'inbox';   // current list
let tagFilter = null;    // '#tag' or null
let view = 'board';
let calCursor = null;    // Date the calendar cursor is on
let calMode = 'month';   // month | week | day
let editing = null;      // task index loaded into the prompt
let sugSel = 0;          // selected row in the suggestion strip
let suggestions = [];    // current strip items: { label, detail, apply }

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DATE_CTX = /(@|\bdue:?\s+)([\w-]*)$/i;
const PRIO_CTX = /📅 (\d{4}-\d{2}-\d{2}) ([a-z]*)$/iu;
const HASH_CTX = /#([\w/-]*)$/;

const COMMANDS = [
  { cmd: 'cal', desc: 'open the calendar' },
  { cmd: 'project', desc: 'open or create a project', arg: '<name>' },
  { cmd: 'inbox', desc: 'back to the inbox' },
  { cmd: 'move', desc: 'move selected/last task to a project', arg: '<name>' },
  { cmd: 'file', desc: 'file tagged tasks into matching projects' },
  { cmd: 'tag', desc: 'filter by #tag', arg: '<name>' },
  { cmd: 'all', desc: 'clear the tag filter' },
  { cmd: 'sort', desc: 'sort tasks', arg: '<key>' },
  { cmd: 'archive', desc: 'archive all completed tasks' },
  { cmd: 'archived', desc: 'view the archive' },
  { cmd: 'stats', desc: 'task counts at a glance' },
  { cmd: 'time', desc: 'time log summary' },
  { cmd: 'toggl', desc: 'connect Toggl Track to push time entries live' },
  { cmd: 'oura', desc: 'connect Oura Ring — sleep, readiness, ideal bedtime' },
  { cmd: 'location', desc: 'set your city for sunrise/sunset', arg: '<city>' },
  { cmd: 'exit', desc: 'this is a website — just close the tab :)' },
];

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const out = await res.json();
  if (out.error) toast(out.error);
  return out;
}

async function refresh() {
  S = await api(`/api/state?project=${encodeURIComponent(project)}`);
  render();
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3500);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* ── client-side date words (mirrors store.js for live 📅 replacement) ── */
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function resolveDateWord(word) {
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
const DATE_WORD = `\\d{4}-\\d{2}-\\d{2}|today|tomorrow|${WEEKDAYS.join('|')}`;
function autoFormatDates(text) {
  const m = text.match(new RegExp(`(@|\\bdue:?\\s+)(${DATE_WORD})(\\s)$`, 'iu'));
  if (!m) return text;
  const resolved = resolveDateWord(m[2]);
  return resolved ? `${text.slice(0, m.index)}📅 ${resolved} ` : text;
}

/* ── rendering ─────────────────────────────────────────────────────── */
function render() {
  if (!S) return;
  renderSidebar();
  renderTimerbar();
  if (view === 'board') renderBoard();
  if (view === 'calendar') renderCalendar();
  if (view === 'time') renderTime();
}

function renderSidebar() {
  // inbox lives in the nav above, not in the project list
  const projs = $('projects');
  projs.replaceChildren(...S.projects.filter((p) => p.name !== 'inbox').map((p) => {
    const row = el('div', `proj${p.name === project ? ' active' : ''}`);
    row.append(el('span', '', p.name), el('span', 'count', String(p.count)));
    row.onclick = () => { project = p.name; tagFilter = null; setView('board'); refresh(); };
    return row;
  }));
  if (projs.childElementCount === 0) {
    const hint = el('div', 'dim proj-empty', 'none yet — click + to add');
    hint.onclick = newProjectPrompt;
    projs.replaceChildren(hint);
  }
  $('nav-views').querySelector('[data-view=board]').classList.toggle('active', view === 'board' && project === 'inbox');

  const tags = $('tags');
  tags.replaceChildren(...S.tags.map(({ tag, count }) => {
    const row = el('div', `tagrow${tag === tagFilter ? ' active' : ''}`);
    row.append(el('span', '', tag), el('span', 'count', String(count)));
    row.onclick = () => { tagFilter = tagFilter === tag ? null : tag; setView('board'); render(); };
    return row;
  }));
  if (!S.tags.length) tags.replaceChildren(el('div', 'dim', 'no tags yet'));

  renderWellness();

  const st = S.stats;
  $('stats').textContent =
    `${st.open} open · ${st.done} done\n${st.due} due today · ${st.overdue} overdue\n${st.archived} archived · ${st.projects} projects`;
  $('stats').style.whiteSpace = 'pre';
}

function renderTimerbar() {
  const bar = $('timerbar');
  if (!S.tracking) return bar.classList.add('hidden');
  bar.classList.remove('hidden');
  bar.replaceChildren(
    el('span', '', `⏺ ${S.tracking.elapsed} — ${S.tracking.title}`),
    Object.assign(el('button', '', '⏹ stop'), { onclick: () => stopTimer() }),
  );
}

function dateSpan(t) {
  if (!t.date) return null;
  const cls = !t.done && t.date < S.today ? 'overdue' : t.date === S.today ? 'today' : '';
  return el('span', `date ${cls}`, `📅 ${t.date}`);
}

function renderBoard() {
  $('board-title').textContent = project;
  const tf = $('tag-filter');
  tf.classList.toggle('hidden', !tagFilter);
  tf.textContent = tagFilter ? `${tagFilter} — click the tag again to clear` : '';

  const sort = $('sort-sel');
  if (!sort.options.length) {
    sort.append(...S.sortKeys.map((k) => new Option(`sort: ${k.key}`, k.key)));
    sort.onchange = async () => { await api('/api/op', { op: 'sort', index: 0, project, arg: sort.value }); refresh(); };
  }

  const list = $('tasks');
  const visible = S.tasks.filter((t) => !tagFilter || t.tags.includes(tagFilter));
  list.replaceChildren(...visible.map(renderTask));
  if (!visible.length) list.replaceChildren(el('div', 'dim', 'no tasks — type below to add one'));
}

function renderTask(t) {
  const row = el('div', `task${t.done ? ' done' : ''}`);
  row.style.paddingLeft = `${8 + (t.indent || 0) * 26}px`;

  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = t.done;
  cb.onchange = () => op('toggle', t.i);

  const title = el('span', 'title');
  // tags inside the title are clickable filters
  for (const part of t.title.split(/(#[\w/-]+)/g)) {
    if (part.startsWith('#')) {
      const a = el('span', 'tag', part);
      a.onclick = () => { tagFilter = tagFilter === part ? null : part; render(); };
      title.append(a);
    } else title.append(part);
  }
  if (t.priority) title.append(' ' + (S.priorities.find((p) => p.key === t.priority)?.emoji || ''));

  const isTracking = S.tracking && S.tracking.title === t.title;
  if (isTracking) row.classList.add('tracking');
  const timer = el('button', `timer-btn${isTracking ? ' on' : ''}`, isTracking ? '■' : '▶');
  timer.title = isTracking ? 'stop timer' : 'start timer';
  timer.onclick = () => (isTracking ? stopTimer() : startTimer(t));

  const tools = el('span', 'tools');
  const mk = (label, tip, fn) => {
    const b = el('button', '', label);
    b.title = tip;
    b.onclick = fn;
    return b;
  };
  tools.append(
    mk('↑', 'move up', () => op('up', t.i)),
    mk('↓', 'move down', () => op('down', t.i)),
    mk('⇥', 'nest under the task above', () => op('indent', t.i)),
    mk('⇤', 'un-nest', () => op('outdent', t.i)),
    mk('✎', 'edit in the prompt', () => beginEdit(t)),
    mk('⌫', 'archive (with sub-tasks)', () => op('archive', t.i)),
    mk('✕', 'delete (with sub-tasks)', () => op('delete', t.i)),
  );
  // move-to-project dropdown
  const move = document.createElement('select');
  move.title = 'move to project';
  move.append(new Option('move…', ''), ...S.projects.filter((p) => p.name !== project).map((p) => new Option(p.name, p.name)));
  move.onchange = () => move.value && op('move', t.i, move.value);
  tools.append(move);

  row.append(cb, timer, title);
  const d = dateSpan(t);
  if (d) row.append(d);
  row.append(tools);
  return row;
}

async function op(name, index, arg) {
  await api('/api/op', { op: name, index, project, arg });
  refresh();
}

function beginEdit(t) {
  editing = t.i;
  const emoji = t.priority ? ` ${S.priorities.find((p) => p.key === t.priority)?.emoji}` : '';
  $('prompt').value = `${t.title}${emoji}${t.date ? ` 📅 ${t.date}` : ''}`;
  $('prompt').focus();
  $('hint').textContent = 'editing — enter saves · esc cancels';
}

function endEdit() {
  editing = null;
  $('prompt').value = '';
  $('hint').textContent = 'enter adds · dates like “due friday” / “@today” become 📅 · # tags · / commands';
  updateSuggestions();
}

/* ── timer ─────────────────────────────────────────────────────────── */
function startTimer(t) {
  api('/api/time', {
    action: 'start',
    title: t.title,
    project: project === 'inbox' ? '' : project,
    tags: t.tags.map((g) => g.slice(1)),
  }).then((out) => {
    if (out.toggl) toast(`⏺ tracking — ${out.toggl}`);
    refresh();
  });
}
function stopTimer() {
  api('/api/time', { action: 'stop' }).then((out) => {
    if (out.stopped) toast(`⏹ logged "${out.stopped.title}" to time.csv`);
    refresh();
  });
}
// tick the elapsed display once a second while tracking
setInterval(() => {
  if (S?.tracking && !document.hidden) refresh();
}, 1000);

/* ── prompt: suggestions + slash commands ──────────────────────────── */
function updateSuggestions() {
  const v = $('prompt').value;
  const box = $('suggest');
  suggestions = [];

  const insert = (replaceRe, text) => () => {
    const p = $('prompt');
    p.value = p.value.replace(replaceRe, '') + text;
    p.focus();
    updateSuggestions();
  };

  if (v.startsWith('/')) {
    const q = v.slice(1).split(/\s/)[0].toLowerCase();
    const rest = v.includes(' ') ? v.slice(v.indexOf(' ') + 1) : null;
    if (rest !== null && ['project', 'move', 'tag', 'sort'].includes(q)) {
      const pools = {
        project: S.projects.map((p) => ({ label: p.name, detail: `${p.count} open` })),
        move: S.projects.map((p) => ({ label: p.name, detail: `${p.count} open` })),
        tag: S.tags.map((t) => ({ label: t.tag.slice(1), detail: `${t.count} task${t.count === 1 ? '' : 's'}` })),
        sort: S.sortKeys.map((k) => ({ label: k.key, detail: k.desc })),
      };
      suggestions = pools[q]
        .filter((s) => s.label.toLowerCase().startsWith(rest.toLowerCase().replace(/^#/, '')))
        .map((s) => ({ ...s, apply: insert(/\s\S*$|\s$/, ` ${s.label}`) }));
    } else {
      suggestions = COMMANDS.filter((c) => c.cmd.startsWith(q)).map((c) => ({
        label: `/${c.cmd}${c.arg ? ` ${c.arg}` : ''}`,
        detail: c.desc,
        apply: insert(/^.*$/s, `/${c.cmd}${c.arg ? ' ' : ''}`),
      }));
    }
  } else if (HASH_CTX.test(v)) {
    const partial = v.match(HASH_CTX)[1].toLowerCase();
    suggestions = S.tags
      .filter((t) => t.tag.slice(1).toLowerCase().startsWith(partial))
      .map((t) => ({ label: t.tag, detail: `${t.count} task${t.count === 1 ? '' : 's'}`, apply: insert(HASH_CTX, `${t.tag} `) }));
  } else if (PRIO_CTX.test(v)) {
    const partial = v.match(PRIO_CTX)[2].toLowerCase();
    suggestions = [{ key: 'none', emoji: '' }, ...S.priorities]
      .filter((p) => p.key.startsWith(partial))
      .map((p) => ({
        label: `${p.emoji || '·'} ${p.key}`,
        detail: p.key === 'none' ? 'no priority (default)' : 'Obsidian Tasks priority',
        apply: insert(/([a-z]*)$/i, p.emoji ? `${p.emoji} ` : ''),
      }));
  } else if (DATE_CTX.test(v)) {
    const partial = v.match(DATE_CTX)[2].toLowerCase();
    suggestions = S.dates
      .filter((d) => d.label.startsWith(partial) || d.date.startsWith(partial))
      .map((d) => ({ label: d.label, detail: `📅 ${d.date}`, apply: insert(DATE_CTX, `📅 ${d.date} `) }));
  }

  sugSel = Math.min(sugSel, Math.max(0, suggestions.length - 1));
  box.classList.toggle('hidden', !suggestions.length);
  box.replaceChildren(...suggestions.map((s, i) => {
    const row = el('div', `sug${i === sugSel ? ' sel' : ''}`);
    row.append(el('span', 'lab', s.label), el('span', 'det', s.detail || ''));
    row.onclick = s.apply;
    return row;
  }));
}

async function runCommand(raw) {
  const [cmd, ...args] = raw.slice(1).trim().split(/\s+/);
  const arg = args.join(' ');
  const c = (cmd || '').toLowerCase();
  const go = (v) => { setView(v); render(); };

  if (['cal', 'calendar'].includes(c)) return go('calendar');
  if (['archived'].includes(c)) return go('archive');
  if (['time', 'timer', 'csv'].includes(c)) return go('time');
  if (['stats'].includes(c)) return toast($('stats').textContent.replace(/\n/g, ' · '));
  if (['inbox', 'home'].includes(c)) { project = 'inbox'; tagFilter = null; return refresh(); }
  if (['all'].includes(c)) { tagFilter = null; return render(); }
  if (['tag'].includes(c)) { tagFilter = arg ? `#${arg.replace(/^#/, '')}` : null; return render(); }
  if (['sort'].includes(c)) { await api('/api/op', { op: 'sort', index: 0, project, arg: arg || 'priority' }); return refresh(); }
  if (['archive', 'clear'].includes(c)) {
    const out = await api('/api/archive-done', { project });
    toast(`archived ${out.count} completed task${out.count === 1 ? '' : 's'}`);
    return refresh();
  }
  if (['file', 'sweep'].includes(c)) {
    const out = await api('/api/file', {});
    toast(`filed ${out.count} task${out.count === 1 ? '' : 's'} into matching projects`);
    return refresh();
  }
  if (['project', 'proj', 'projects'].includes(c)) {
    if (!arg) return toast('usage: /project <name> — see the sidebar for the list');
    const out = await api('/api/project', { name: arg });
    if (out.ok) { project = out.name; tagFilter = null; refresh(); }
    return;
  }
  if (['move', 'mv'].includes(c)) {
    if (!arg) return toast('usage: /move <project> — or use a task’s move… dropdown');
    const last = S.tasks[S.tasks.length - 1];
    if (!last) return toast('no task to move');
    return op('move', last.i, arg);
  }
  if (['toggl'].includes(c)) { setView('time'); render(); return $('toggl-token')?.focus(); }
  if (['oura', 'sleep', 'ring'].includes(c)) {
    if (arg === 'off') return ouraAction({ action: 'disconnect' }, 'Oura disconnected');
    if (S.oura?.connected) return ouraAction({ action: 'refresh' }, 'sleep refreshed');
    return openOuraConnect($('wellness'), S.oura);
  }
  if (['location', 'loc', 'sun'].includes(c)) {
    if (arg === 'clear') return locationAction({ action: 'clear' }, 'location cleared');
    if (arg) return setLocation(arg);
    return inlineField($('wellness'), { placeholder: 'city name', onSubmit: setLocation });
  }
  if (['exit', 'quit', 'q'].includes(c)) return toast('this is a website — just close the tab :)');
  toast(`unknown command /${cmd}`);
}

$('prompt').addEventListener('keydown', (e) => {
  const p = $('prompt');
  if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); sugSel = (sugSel - 1 + suggestions.length) % suggestions.length; return updateSuggestions(); }
  if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); sugSel = (sugSel + 1) % suggestions.length; return updateSuggestions(); }
  if (e.key === 'Tab' && suggestions.length) { e.preventDefault(); return suggestions[sugSel].apply(); }
  if (e.key === 'Escape') return endEdit();
  if (e.key !== 'Enter') return;
  e.preventDefault();

  const v = p.value.trim();
  if (!v) return;
  if (v.startsWith('/')) {
    p.value = '';
    updateSuggestions();
    return runCommand(v);
  }
  const submit = editing != null
    ? api('/api/op', { op: 'edit', index: editing, project, arg: v })
    : api('/api/input', { text: v, project });
  endEdit();
  submit.then(refresh);
});

$('prompt').addEventListener('input', () => {
  const p = $('prompt');
  const formatted = autoFormatDates(p.value);
  if (formatted !== p.value) p.value = formatted;
  sugSel = 0;
  updateSuggestions();
});

/* ── views ─────────────────────────────────────────────────────────── */
function setView(v) {
  view = v;
  for (const b of document.querySelectorAll('.navbtn'))
    b.classList.toggle('active', b.dataset.view === v && (v !== 'board' || project === 'inbox'));
  for (const s of document.querySelectorAll('.view')) s.classList.add('hidden');
  $(`view-${v}`).classList.remove('hidden');
  if (v === 'archive') renderArchive();
  if (v === 'calendar') renderCalendar();
  if (v === 'time') renderTime();
  if (v === 'board') $('prompt').focus();
  else document.activeElement?.blur(); // so calendar keys aren't eaten by a focused button
}

document.querySelectorAll('.navbtn').forEach((b) => (b.onclick = () => {
  if (b.dataset.view === 'board') { // the inbox entry: always the inbox list
    project = 'inbox';
    tagFilter = null;
    setView('board');
    refresh();
  } else setView(b.dataset.view);
}));

// Inline new-project input. window.prompt() is a no-op inside the Mac app's
// WKWebView (no UI delegate), so we add the field to the sidebar directly —
// this works the same in the browser and the app. A refresh() after creation
// rebuilds the project list, which removes this temporary row.
function newProjectPrompt() {
  const projs = $('projects');
  let row = projs.querySelector('.proj-new');
  if (!row) {
    row = el('div', 'proj-new');
    const input = el('input');
    input.placeholder = 'new project name';
    input.maxLength = 40;
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const name = input.value.trim();
        if (name) runCommand(`/project ${name}`); // refresh() will clear this row
        else renderSidebar();
      } else if (e.key === 'Escape') {
        renderSidebar(); // drop the input
      }
    };
    row.append(input);
    projs.prepend(row);
  }
  row.querySelector('input').focus();
}
$('new-project').onclick = newProjectPrompt;
$('file-btn').onclick = () => runCommand('/file');
$('archive-done-btn').onclick = () => runCommand('/archive');

/* calendar — month/week/day views over every project's dated tasks,
   with the CLI's keys: m/w/d, tab/v cycles, enter zooms, arrows move a day,
   ↑/↓ a week, shift+←/→ a whole period, t = today, esc = back to tasks */
const CAL_MODES = ['month', 'week', 'day'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function cursor() {
  if (!calCursor) {
    const [y, m, d] = S.today.split('-').map(Number);
    calCursor = new Date(y, m - 1, d);
  }
  return calCursor;
}
function calMove(days) {
  const c = cursor();
  calCursor = new Date(c.getFullYear(), c.getMonth(), c.getDate() + days);
  renderCalendar();
}
function calMoveMonth(n) {
  const c = cursor();
  const last = new Date(c.getFullYear(), c.getMonth() + n + 1, 0).getDate();
  calCursor = new Date(c.getFullYear(), c.getMonth() + n, Math.min(c.getDate(), last));
  renderCalendar();
}
function calJump(dir) { // shift+←/→ and the ‹ › buttons: one period per press
  if (calMode === 'month') calMoveMonth(dir);
  else calMove(calMode === 'week' ? dir * 7 : dir);
}

function calDayCell(d, { month, eventLimit }) {
  const key = iso(d);
  const cell = el('div', 'cal-day');
  if (month != null && d.getMonth() !== month) cell.classList.add('out');
  if (key === S.today) cell.classList.add('today');
  if (key === iso(cursor())) cell.classList.add('cursor');
  cell.onclick = () => { calCursor = d; renderCalendar(); };
  cell.ondblclick = () => { calCursor = d; calMode = 'day'; renderCalendar(); };
  cell.append(el('div', 'n', String(d.getDate())));
  const tasks = calByDate()[key] || [];
  for (const t of tasks.slice(0, eventLimit)) {
    const row = el('div', `cal-task${t.done ? ' done' : ''}`, `• ${t.title}`);
    row.title = `${t.title} (${t.project})`;
    cell.append(row);
  }
  if (tasks.length > eventLimit) cell.append(el('div', 'cal-task dim', `+${tasks.length - eventLimit} more`));
  return cell;
}

let _byDate = null;
function calByDate() {
  if (!_byDate) {
    _byDate = {};
    for (const t of S.all) if (t.date) (_byDate[t.date] ||= []).push(t);
  }
  return _byDate;
}

function renderCalendar() {
  _byDate = null;
  const c = cursor();
  const weekStart = new Date(c.getFullYear(), c.getMonth(), c.getDate() - c.getDay());

  $('cal-title').textContent =
    calMode === 'day' ? `${MONTH_NAMES[c.getMonth()]} ${c.getDate()}, ${c.getFullYear()}`
    : calMode === 'week' ? `Week of ${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getDate()}, ${weekStart.getFullYear()}`
    : `${MONTH_NAMES[c.getMonth()]} ${c.getFullYear()}`;
  for (const b of document.querySelectorAll('.cal-mode')) b.classList.toggle('active', b.dataset.mode === calMode);

  const grid = $('cal-grid');
  grid.className = calMode;
  grid.replaceChildren();

  if (calMode === 'day') {
    const key = iso(c);
    const box = el('div', 'day-view');
    box.append(el('h2', '', `${DOW_NAMES[c.getDay()]}, ${MONTH_NAMES[c.getMonth()]} ${c.getDate()}, ${c.getFullYear()}${key === S.today ? ' (today)' : ''}`));
    const tasks = calByDate()[key] || [];
    if (!tasks.length) box.append(el('div', 'dim', 'No tasks due this day.'));
    for (const t of tasks) {
      const cls = t.done ? 'done' : !t.done && t.date < S.today ? 'overdue' : '';
      box.append(el('div', `day-task ${cls}`, `${t.done ? '[x]' : '[ ]'} ${t.title}  (${t.project})`));
    }
    grid.append(box);
  } else {
    for (const d of ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) {
      const h = el('div', 'cal-dow', d);
      h.style.minHeight = '0';
      grid.append(h);
    }
    if (calMode === 'week') {
      for (let i = 0; i < 7; i++) {
        const d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
        grid.append(calDayCell(d, { eventLimit: 12 }));
      }
    } else {
      const first = new Date(c.getFullYear(), c.getMonth(), 1);
      const start = new Date(c.getFullYear(), c.getMonth(), 1 - first.getDay());
      for (let i = 0; i < 42; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        grid.append(calDayCell(d, { month: c.getMonth(), eventLimit: 3 }));
      }
    }
  }

  const n = (calByDate()[iso(c)] || []).length;
  $('cal-foot').textContent =
    `${iso(c)}${iso(c) === S.today ? ' (today)' : ''} — ${n} task${n === 1 ? '' : 's'}` +
    '   ·   m/w/d views · tab cycles · enter zooms · ←/→ day · ↑/↓ week · shift+←/→ period · t today · esc back';
}

$('cal-prev').onclick = () => calJump(-1);
$('cal-next').onclick = () => calJump(1);
$('cal-today').onclick = () => { calCursor = null; renderCalendar(); };
document.querySelectorAll('.cal-mode').forEach((b) => (b.onclick = () => { calMode = b.dataset.mode; renderCalendar(); }));

document.addEventListener('keydown', (e) => {
  if (view !== 'calendar' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const k = e.key;
  const handled = () => e.preventDefault();
  if (k === 'm') { calMode = 'month'; handled(); return renderCalendar(); }
  if (k === 'w') { calMode = 'week'; handled(); return renderCalendar(); }
  if (k === 'd') { calMode = 'day'; handled(); return renderCalendar(); }
  if (k === 'Tab' || k === 'v') { calMode = CAL_MODES[(CAL_MODES.indexOf(calMode) + 1) % 3]; handled(); return renderCalendar(); }
  if (k === 'Enter') { calMode = calMode === 'month' ? 'week' : 'day'; handled(); return renderCalendar(); }
  if (k === 'ArrowLeft') { handled(); return e.shiftKey ? calJump(-1) : calMove(-1); }
  if (k === 'ArrowRight') { handled(); return e.shiftKey ? calJump(1) : calMove(1); }
  if (k === 'ArrowUp') { handled(); return calMove(-7); }
  if (k === 'ArrowDown') { handled(); return calMove(7); }
  if (k === 't') { calCursor = null; handled(); return renderCalendar(); }
  if (k === 'Escape') { handled(); return setView('board'); }
});

/* archive — grouped year / month / week, newest first, with unarchive */
async function renderArchive() {
  const { tasks } = await api('/api/archive');
  const list = $('archive-list');
  list.replaceChildren();
  let prev = {};
  for (const t of tasks) {
    const s = t.sections;
    if (s.year !== prev.year) list.append(el('div', 'arch-h1', s.year));
    if (s.year !== prev.year || s.month !== prev.month) list.append(el('div', 'arch-h2', s.month));
    if (s.year !== prev.year || s.month !== prev.month || s.week !== prev.week) list.append(el('div', 'arch-h3', s.week));
    prev = s;

    const row = el('div', 'task done');
    const title = el('span', 'title', `✓ ${t.title}`);
    const un = el('button', '', '↩ unarchive');
    un.title = 'restore to the inbox as an open task';
    un.onclick = async () => { await api('/api/unarchive', { index: t.i }); renderArchive(); refresh(); };
    row.append(title);
    if (t.doneDate) row.append(el('span', 'date', `✅ ${t.doneDate}`));
    row.append(un);
    list.append(row);
  }
  if (!tasks.length) list.append(el('div', 'dim', 'nothing archived yet'));
}

/* time — summary, the CSV (newest first), Toggl import email */
// sidebar wellness block: sunrise/sunset (from /location) and last night's
// Oura sleep. Display always visible; setup happens inline, no popups (so it
// works in the Mac app's WKWebView, where window.prompt is a no-op).
function inlineField(host, { placeholder, type, onSubmit }) {
  const row = el('div', 'well-input');
  const input = el('input');
  if (type) input.type = type;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { const v = input.value.trim(); if (v) onSubmit(v); }
    else if (e.key === 'Escape') renderSidebar();
  };
  row.append(input);
  host.append(row);
  input.focus();
}

function renderWellness() {
  const box = $('wellness');
  if (!box) return;
  box.replaceChildren();
  box.append(el('div', 'side-head', 'today'));
  const sun = S.sun || { located: false };
  const oura = S.oura || { connected: false };

  // ── sunrise / sunset ──
  const sunRow = el('div', 'well-row');
  if (sun.located && sun.sunrise) {
    sunRow.append(el('span', 'well-main', `☀ ${sun.sunrise}  →  ☾ ${sun.sunset}`));
    const tools = el('span', 'well-tools');
    tools.append(mkWellTool('✎', 'change city', () => inlineField(box, { placeholder: 'city name', onSubmit: setLocation })));
    tools.append(mkWellTool('×', 'clear location', () => locationAction({ action: 'clear' }, 'location cleared')));
    sunRow.append(tools);
    sunRow.append(el('div', 'well-sub dim', sun.place));
  } else if (sun.located) {
    sunRow.append(el('span', 'dim', 'polar day/night — no sunrise today'));
  } else {
    const add = el('button', 'well-add', '+ set location for sunrise/sunset');
    add.onclick = () => inlineField(box, { placeholder: 'city name, e.g. Falls Church', onSubmit: setLocation });
    sunRow.append(add);
  }
  box.append(sunRow);

  // ── Oura sleep ──
  const sleepRow = el('div', 'well-row');
  if (!oura.connected) {
    const add = el('button', 'well-add', '+ connect Oura sleep');
    add.onclick = () => openOuraConnect(box, oura);
    sleepRow.append(add);
  } else if (oura.data) {
    const d = oura.data;
    const head = el('div', 'well-main');
    head.append(el('span', 'sleep-score', `😴 ${d.score ?? '–'}`));
    head.append(el('span', 'ready-score', `  ⚡ ${d.readiness ?? '–'}`));
    const tools = el('span', 'well-tools');
    tools.append(mkWellTool('↻', 'refresh from Oura', () => ouraAction({ action: 'refresh' }, 'sleep refreshed')));
    if (!oura.env) tools.append(mkWellTool('×', 'disconnect Oura', () => ouraAction({ action: 'disconnect' }, 'Oura disconnected')));
    head.append(tools);
    sleepRow.append(head);
    if (d.duration) sleepRow.append(el('div', 'well-sub dim', `${d.duration} slept`));
    if (d.bedtime) {
      const bed = el('div', 'well-sub');
      bed.append(el('span', 'bedtime', `🛏 bed by ${d.bedtime}`));
      sleepRow.append(bed);
    }
    if (d.day) sleepRow.append(el('div', 'well-sub dim', d.day));
  } else {
    sleepRow.append(el('span', 'dim', 'sleep — syncing… '));
    sleepRow.append(mkWellTool('↻', 'refresh from Oura', () => ouraAction({ action: 'refresh' }, 'sleep refreshed')));
  }
  box.append(sleepRow);
}

function mkWellTool(label, tip, fn) {
  const b = el('button', 'well-tool', label);
  b.title = tip;
  b.onclick = fn;
  return b;
}

function openOuraConnect(box, oura) {
  const wrap = el('div', 'well-input');
  const input = el('input');
  input.type = 'password';
  input.placeholder = 'paste Oura token';
  input.autocomplete = 'off';
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') connectOura(input.value);
    else if (e.key === 'Escape') renderSidebar();
  };
  const link = el('a', 'toggl-link', 'get token ↗');
  link.href = (oura && oura.tokenUrl) || 'https://cloud.ouraring.com/personal-access-tokens';
  link.target = '_blank';
  link.rel = 'noreferrer';
  wrap.append(input, link);
  box.append(wrap);
  input.focus();
}

async function connectOura(token) {
  const out = await api('/api/oura', { action: 'connect', token });
  if (out.ok) { toast(`Oura connected${out.name ? ` as ${out.name}` : ''}`); refresh(); }
}
async function ouraAction(body, okMsg) {
  const out = await api('/api/oura', body);
  if (out.ok) { toast(okMsg); refresh(); }
}
async function setLocation(city) {
  const out = await api('/api/location', { action: 'set', city });
  if (out.ok) { toast(`location set: ${out.name}`); refresh(); }
}
async function locationAction(body, okMsg) {
  const out = await api('/api/location', body);
  if (out.ok) { toast(okMsg); refresh(); }
}

function renderToggl() {
  const box = $('toggl-box');
  if (!box) return;
  const tg = S.toggl || { connected: false, map: {}, tokenUrl: 'https://track.toggl.com/profile' };
  box.replaceChildren();

  const head = el('div', 'toggl-head');
  head.append(el('span', 'toggl-dot' + (tg.connected ? ' on' : ''), tg.connected ? '●' : '○'));
  head.append(el('span', '', tg.connected ? 'Toggl Track — connected' : 'Toggl Track — not connected'));
  box.append(head);

  if (!tg.connected) {
    box.append(el('div', 'dim', 'Push ▶ time entries to Toggl live, named after the task and filed under the matching Toggl project. Entries always log locally to time.csv too.'));
    const row = el('div', 'toggl-row');
    const input = el('input');
    input.id = 'toggl-token';
    input.type = 'password';
    input.placeholder = 'paste your Toggl API token';
    input.autocomplete = 'off';
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') connectToggl(input.value); };
    const connect = el('button', '', 'connect');
    connect.onclick = () => connectToggl(input.value);
    const getlink = el('a', 'toggl-link', 'get token ↗');
    getlink.href = tg.tokenUrl;
    getlink.target = '_blank';
    getlink.rel = 'noreferrer';
    row.append(input, connect, getlink);
    box.append(row);
    return;
  }

  // connected: routing map + disconnect
  const note = el('div', 'dim', 'Routing: a project (or first #tag) goes to the Toggl project of the same name, created if missing. Add an override below.');
  box.append(note);

  const map = tg.map || {};
  const keys = Object.keys(map);
  if (keys.length) {
    const list = el('div', 'toggl-maps');
    for (const k of keys) {
      const m = el('div', 'toggl-map');
      m.append(el('span', 'mk', k), el('span', 'arrow', '→'), el('span', 'mv', map[k]));
      const x = el('button', 'mx', '✕');
      x.title = 'remove this mapping';
      x.onclick = () => togglAction({ action: 'unmap', from: k }, `unmapped ${k}`);
      m.append(x);
      list.append(m);
    }
    box.append(list);
  }

  const addRow = el('div', 'toggl-row');
  const from = el('input');
  from.placeholder = 'project or #tag';
  from.onkeydown = (e) => e.stopPropagation();
  const to = el('input');
  to.placeholder = 'Toggl project';
  to.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') addMapping(from.value, to.value); };
  const add = el('button', '', 'map');
  add.onclick = () => addMapping(from.value, to.value);
  addRow.append(from, el('span', 'dim', '→'), to, add);
  box.append(addRow);

  const foot = el('div', 'toggl-row');
  const dis = el('button', '', 'disconnect');
  dis.disabled = !!tg.env;
  dis.title = tg.env ? 'token comes from $TOGGL_API_TOKEN — unset it to disconnect' : 'remove the saved token';
  dis.onclick = () => togglAction({ action: 'disconnect' }, 'Toggl disconnected');
  foot.append(dis);
  if (tg.env) foot.append(el('span', 'dim', 'token from $TOGGL_API_TOKEN'));
  box.append(foot);
}

async function connectToggl(token) {
  const out = await api('/api/toggl', { action: 'connect', token });
  if (out.ok) { toast(`Toggl connected as ${out.name}`); refresh(); }
}
async function addMapping(from, to) {
  if (!from.trim() || !to.trim()) return toast('both a name and a Toggl project are needed');
  const out = await api('/api/toggl', { action: 'map', from: from.trim(), to: to.trim() });
  if (out.ok) { toast(`mapped ${from.trim().replace(/^#/, '')} → ${out.name}`); refresh(); }
}
async function togglAction(body, okMsg) {
  const out = await api('/api/toggl', body);
  if (out.ok) { toast(okMsg); refresh(); }
}

async function renderTime() {
  renderToggl();
  const { entries, today, total } = S.time;
  $('time-summary').textContent = `${entries} entr${entries === 1 ? 'y' : 'ies'} · ${today} today · ${total} total`;
  const { header, rows, path } = await api('/api/time-log');
  const table = $('time-table');
  table.replaceChildren();
  if (header) {
    const tr = el('tr');
    tr.append(...header.split(',').map((h) => el('th', '', h)));
    table.append(tr);
    for (const r of rows.slice(0, 50)) {
      const tr2 = el('tr');
      // naive CSV split is fine for display; quoted fields are rare here
      tr2.append(...r.split(',').map((c) => el('td', '', c.replace(/^"|"$/g, ''))));
      table.append(tr2);
    }
  } else table.append(el('tr', '', 'no time entries yet — press ▶ on a task'));
  $('time-path').textContent = `${path} — Toggl Track import format (upload at track.toggl.com)`;
  $('email-input').value = S.email || '';
}
$('email-save').onclick = async () => {
  await api('/api/time', { action: 'email', value: $('email-input').value });
  toast('email saved — Toggl’s importer matches rows to it');
  refresh();
};

refresh().then(() => $('prompt').focus());
