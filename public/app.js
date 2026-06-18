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
let sel = 0;             // selected task on the board (index into visibleTasks)
let visibleTasks = [];   // tasks currently rendered on the board
let sugSel = 0;          // selected row in the suggestion strip
let suggestions = [];    // current strip items: { label, detail, apply }
let dragFrom = null;     // file index of the task being dragged, or null
let dragEl = null;       // the row element being dragged (for live reordering)

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DATE_CTX = /(@|\bdue:?\s+)([\w-]*)$/i;
// a trailing "du"/"due" being typed — show the date picker before the space
const DUE_PREFIX = /\bdue?$/i;
const PRIO_CTX = /📅 (\d{4}-\d{2}-\d{2}) ([a-z]*)$/iu;
const HASH_CTX = /#([\w/-]*)$/;

const COMMANDS = [
  { cmd: 'cal', desc: 'open the calendar' },
  { cmd: 'kanban', desc: 'open the kanban board' },
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
  { cmd: 'calendars', desc: 'connect Apple Calendar (read-only) & publish your tasks' },
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

/* ── sound: a synthesized "bamboo clonk" when a task box is checked ──────
   Web Audio, no asset to ship. Two inharmonic sine partials with a fast
   exponential decay give a hollow, woody knock; a short filtered noise burst
   is the attack. Gated by the Sounds setting (on by default). */
let audioCtx = null;
function soundOn() {
  try { return localStorage.getItem('gretchen-sound') !== 'off'; } catch { return true; }
}
function playClonk() {
  if (!soundOn()) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const ctx = audioCtx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(ctx.destination);

    // inharmonic partials → hollow bamboo tone, with a tiny downward "clonk" glide
    for (const [f, g] of [[460, 1.0], [1180, 0.35]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f * 1.15, t);
      osc.frequency.exponentialRampToValueAtTime(f, t + 0.035);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(g, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0008, t + 0.17);
      osc.connect(env).connect(out);
      osc.start(t);
      osc.stop(t + 0.2);
    }

    // short filtered noise burst for the woody attack ("k")
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.02), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700;
    const ng = ctx.createGain();
    ng.gain.value = 0.3;
    noise.connect(bp).connect(ng).connect(out);
    noise.start(t);
  } catch {}
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
  if (view === 'kanban') renderKanban();
  if (view === 'time') renderTime();
  if (view === 'settings') renderSettings();
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
    const name = el('span', '', tag);
    const c = tagColor(tag);
    if (c) name.style.color = c; // custom colour; otherwise the CSS default
    row.append(name, el('span', 'count', String(count)));
    row.onclick = () => { tagFilter = tagFilter === tag ? null : tag; setView('board'); render(); };
    return row;
  }));
  if (!S.tags.length) tags.replaceChildren(el('div', 'dim', 'no tags yet'));

  if (view === 'home') renderHome(); // wellness now lives in the home view, not the sidebar

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
  tf.style.color = (tagFilter && tagColor(tagFilter)) || ''; // '' falls back to the CSS default

  const list = $('tasks');
  const visible = S.tasks.filter((t) => !tagFilter || t.tags.includes(tagFilter));
  visibleTasks = visible;
  // under a tag filter, also list kanban cards carrying that tag — shown with
  // the column they live in, click to jump to the board
  const kanMatches = tagFilter ? (S.kanbanCards || []).filter((c) => (c.tags || []).includes(tagFilter)) : [];
  if (!visible.length && !kanMatches.length) {
    list.replaceChildren(el('div', 'dim', 'no tasks — type below to add one'));
    return;
  }
  if (sel >= visible.length) sel = visible.length - 1;
  if (sel < 0) sel = 0;
  // FLIP step 1 — remember where each task currently sits before we rebuild
  const firstTops = new Map();
  for (const child of list.children)
    if (child.dataset.flipkey != null) firstTops.set(child.dataset.flipkey, child.getBoundingClientRect().top);

  const rows = visible.map(renderTask);
  if (rows[sel]) rows[sel].classList.add('selected');
  list.replaceChildren(...rows, ...kanMatches.map(renderKanbanRow));
  if (rows[sel]) rows[sel].scrollIntoView({ block: 'nearest' });
  flipSlide(list, firstTops); // step 2 — slide moved tasks from their old spot to the new one
}

// FLIP "play": each row that changed position is inverted back to where it was,
// then transitioned to its new spot — so reordering tasks slides instead of snapping
function flipSlide(list, firstTops) {
  if (!firstTops.size || prefersReducedMotion()) return;
  const moved = [];
  for (const child of list.children) {
    const prevTop = firstTops.get(child.dataset.flipkey);
    if (prevTop == null) continue;
    const delta = prevTop - child.getBoundingClientRect().top;
    if (!delta) continue;
    child.style.transform = `translateY(${delta}px)`;
    child.style.transition = 'transform 0s';
    moved.push(child);
  }
  if (!moved.length) return;
  requestAnimationFrame(() => {
    for (const child of moved) {
      child.style.transition = 'transform 200ms cubic-bezier(.2,.7,.3,1)';
      child.style.transform = '';
    }
  });
}

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

// a read-only row for a kanban card surfaced by a tag filter: shows the column
// (location) it lives in, and jumps to the board when clicked
function renderKanbanRow(card) {
  const row = el('div', 'task kanban-src');
  const loc = el('span', 'kanban-badge', `📊 ${card.column}`);
  loc.title = 'on the kanban board';
  const title = el('span', 'title');
  for (const part of card.title.split(/(#[\w/-]+)/g)) {
    if (part.startsWith('#')) {
      const a = el('span', 'tag', part);
      const c = tagColor(part);
      if (c) a.style.color = c;
      a.onclick = (e) => { e.stopPropagation(); tagFilter = tagFilter === part ? null : part; render(); };
      title.append(a);
    } else if (part) title.append(part);
  }
  if (card.priority) title.append(' ' + (S.priorities.find((p) => p.key === card.priority)?.emoji || ''));
  row.append(loc, title);
  const d = dateSpan(card);
  if (d) row.append(d);
  row.onclick = () => { setView('kanban'); render(); };
  return row;
}

function renderTask(t) {
  const row = el('div', `task${t.done ? ' done' : ''}`);
  // content key for the reorder slide (FLIP): stable across reordering, unlike
  // the file index which shifts when tasks move
  row.dataset.flipkey = `${t.title}|${t.date || ''}|${t.priority || ''}`;
  if (t.indent) row.style.marginLeft = `${t.indent * 24}px`;

  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = t.done;
  cb.onchange = () => { if (cb.checked) playClonk(); op('toggle', t.i); };

  const title = el('span', 'title');
  // the title shows just the words; #tags move to bubbles in the meta row
  title.append(
    t.title.split(/(#[\w/-]+)/g).filter((p) => !p.startsWith('#')).join('').replace(/\s{2,}/g, ' ').trim()
  );

  const isTracking = S.tracking && S.tracking.title === t.title;
  if (isTracking) row.classList.add('tracking');
  const timer = el('button', `timer-btn${isTracking ? ' on' : ''}`, isTracking ? '■' : '▶');
  timer.title = isTracking ? 'stop timer' : 'start timer';
  timer.onclick = () => (isTracking ? stopTimer() : startTimer(t));

  row.append(cb, timer, title);
  // right-side meta, left → right: tag bubbles · priority · date
  const meta = el('span', 'task-meta');
  for (const tg of t.tags || []) {
    const b = el('span', 'tag', tg);
    const c = tagColor(tg);
    if (c) b.style.color = c; // custom colour; otherwise the CSS default yellow
    b.onclick = () => { tagFilter = tagFilter === tg ? null : tg; render(); };
    meta.append(b);
  }
  if (t.priority) meta.append(el('span', 'task-prio', S.priorities.find((p) => p.key === t.priority)?.emoji || ''));
  const d = dateSpan(t);
  if (d) meta.append(d);
  if (meta.childElementCount) row.append(meta);

  // Live drag-and-drop reorder: while a row is dragged, the others slide out of
  // the way in real time (see the #tasks dragover handler), and the new order
  // commits on release. Disabled under a tag filter, since the visible order
  // wouldn't match the file order we reorder against.
  if (!tagFilter) {
    row.draggable = true;
    row.dataset.fi = t.i; // file index, read back on commit
    row.addEventListener('dragstart', (e) => {
      dragEl = row;
      dragFrom = t.i;
      requestAnimationFrame(() => row.classList.add('dragging')); // after the drag image is grabbed
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(t.i)); // Firefox needs a payload
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      clearRowTransforms();
      if (dragFrom == null) return;
      // commit: place the dragged task before whatever row now follows it
      const next = row.nextElementSibling;
      const to = next && next.dataset.fi != null ? Number(next.dataset.fi) : S.tasks.length;
      const from = dragFrom;
      dragEl = null;
      dragFrom = null;
      sel = reorderedIndex(S.tasks, from, to); // keep the highlight on the dragged task
      op('reorder', from, to);
    });
  }

  // single click selects the task — highlight in place (no rebuild) so the
  // node stays put and the double-click below still fires
  row.addEventListener('click', (e) => {
    if (e.target.closest('input, button, select, .tag')) return; // toggles/filters keep their behavior
    const i = visibleTasks.indexOf(t);
    if (i < 0) return;
    sel = i;
    $('prompt').blur(); // leave the add-bar so ↑/↓ navigate the list
    for (const r of $('tasks').children) r.classList.remove('selected');
    row.classList.add('selected');
  });
  // double click edits the task inline, right inside its bubble
  row.addEventListener('dblclick', (e) => {
    if (e.target.closest('input, button, select, .tag')) return;
    startInlineEdit(row, t);
  });
  return row;
}

// clear any leftover slide transforms on the task rows
function clearRowTransforms() {
  for (const r of $('tasks').children) { r.style.transition = ''; r.style.transform = ''; }
}

// element-keyed FLIP for live dragging: the rows persist during a drag, so we
// key by the node itself — which also stays correct when two tasks share a title
function captureRects(list, except) {
  const m = new Map();
  for (const c of list.children)
    if (c.classList.contains('task') && c !== except) m.set(c, c.getBoundingClientRect().top);
  return m;
}
function playRectFlip(map, dur = 180) {
  const moved = [];
  for (const [node, prevTop] of map) {
    const delta = prevTop - node.getBoundingClientRect().top;
    if (!delta) continue;
    node.style.transition = 'transform 0s';
    node.style.transform = `translateY(${delta}px)`;
    moved.push(node);
  }
  if (!moved.length) return;
  requestAnimationFrame(() => {
    for (const node of moved) {
      node.style.transition = `transform ${dur}ms cubic-bezier(.2,.7,.3,1)`;
      node.style.transform = '';
    }
  });
}

async function op(name, index, arg) {
  await api('/api/op', { op: name, index, project, arg });
  refresh();
}

// edit a task in place: the bubble's content becomes an input holding the
// task text (title, priority emoji, 📅 date). Enter or click-away saves;
// Escape (or emptying it) cancels. A focused input also pauses the live poll.
function startInlineEdit(row, t) {
  const emoji = t.priority ? ` ${S.priorities.find((p) => p.key === t.priority)?.emoji || ''}` : '';
  const input = el('input', 'task-edit');
  input.value = `${t.title}${emoji}${t.date ? ` 📅 ${t.date}` : ''}`;
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (!v) return renderBoard();
    api('/api/op', { op: 'edit', index: t.i, project, arg: v }).then((out) => {
      out && out.ok ? refresh() : renderBoard();
    });
  };
  const cancel = () => { if (done) return; done = true; renderBoard(); };
  input.onkeydown = (e) => {
    e.stopPropagation(); // keep the board's global key handlers out
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  input.onblur = commit; // clicking away saves
  row.classList.add('editing');
  row.replaceChildren(input);
  input.focus();
  input.select();
}

// where the dragged task lands after a reorder — mirrors the server's reorder
// so the LIST highlight can follow the task to its new spot (not the row it
// displaced). `to` is the file index it's dropped before (>= length appends).
function reorderedIndex(tasks, from, to) {
  const blockRange = (i) => {
    let start = i;
    while (start > 0 && (tasks[start].indent || 0) > 0) start--;
    let end = start + 1;
    while (end < tasks.length && (tasks[end].indent || 0) > (tasks[start].indent || 0)) end++;
    return [start, end];
  };
  const [s, e] = blockRange(from);
  const insertAt = !(to >= 0 && to < tasks.length) ? tasks.length : blockRange(to)[0];
  if (insertAt > s && insertAt < e) return from; // dropped onto itself
  const at = insertAt >= e ? insertAt - (e - s) : insertAt;
  return at + (from - s); // preserve the item's offset within its block
}

function beginEdit(t) {
  editing = t.i;
  const emoji = t.priority ? ` ${S.priorities.find((p) => p.key === t.priority)?.emoji}` : '';
  $('prompt').value = `${t.title}${emoji}${t.date ? ` 📅 ${t.date}` : ''}`;
  openPrompt();
  $('hint').textContent = 'editing — enter saves · esc cancels';
}

const HINT_TEXT = 'enter add · ↑/↓ menu · tab insert · esc close · / commands';
function endEdit() {
  editing = null;
  $('prompt').value = '';
  $('hint').textContent = HINT_TEXT;
  updateSuggestions();
  closePrompt();
}

// the add-task bar is an overlay: ⇧N (or the /e revise flow) opens it, esc /
// submitting closes it, and the rest of the board dims behind a backdrop.
function openPrompt() {
  $('promptwrap').classList.remove('hidden');
  $('prompt').focus();
  updateSuggestions();
}
function closePrompt() {
  $('promptwrap').classList.add('hidden');
  document.activeElement?.blur(); // drop focus so board / view keys work again
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
    sugSel = 0; // fresh context (e.g. the priority list after a date) starts at the top
    updateSuggestions();
  };
  // matches a finished "...📅 DATE <priority-emoji> " — the moment to offer tags
  const prioEmojis = (S.priorities || []).map((p) => p.emoji).filter(Boolean);
  const prioDone = prioEmojis.length
    ? new RegExp(`📅 \\d{4}-\\d{2}-\\d{2} (?:${prioEmojis.join('|')}) $`, 'u')
    : null;

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
      .map((t) => ({ label: t.tag, detail: `${t.count} task${t.count === 1 ? '' : 's'}`,
        apply: insert(HASH_CTX, `${t.tag} `), enterInserts: true })); // enter completes the tag (like dates/priorities), so the flow continues instead of submitting early
  } else if (PRIO_CTX.test(v)) {
    const partial = v.match(PRIO_CTX)[2].toLowerCase();
    suggestions = [{ key: 'none', emoji: '' }, ...S.priorities]
      .filter((p) => p.key.startsWith(partial))
      .map((p) => ({
        label: `${p.emoji || '·'} ${p.key}`,
        detail: p.key === 'none' ? 'no priority (default)' : 'Obsidian Tasks priority',
        apply: insert(/([a-z]*)$/i, p.emoji ? `${p.emoji} ` : ''),
        enterInserts: !!p.emoji, // enter sets a real priority; enter on "none" submits the task
      }));
  } else if (prioDone && prioDone.test(v)) {
    // due + priority are set — now pick a #tag, or "no tag" to finish
    suggestions = [
      { label: '· no tag', detail: 'add the task as is', apply: () => submitPrompt() },
      ...S.tags.map((t) => ({ label: t.tag, detail: `${t.count} task${t.count === 1 ? '' : 's'}`,
        apply: insert(/\s*$/, ` ${t.tag} `), enterInserts: true })),
    ];
  } else if (DATE_CTX.test(v) || DUE_PREFIX.test(v)) {
    // "@x" / "due x" filter by the partial; a bare "du"/"due" shows them all
    const m = v.match(DATE_CTX);
    const partial = m ? m[2].toLowerCase() : '';
    const replaceRe = m ? DATE_CTX : DUE_PREFIX;
    suggestions = S.dates
      .filter((d) => d.label.startsWith(partial) || d.date.startsWith(partial))
      .map((d) => ({ label: d.label, detail: `📅 ${d.date}`, apply: insert(replaceRe, `📅 ${d.date} `), enterInserts: true }));
  }

  sugSel = Math.min(sugSel, Math.max(0, suggestions.length - 1));
  box.classList.toggle('hidden', !suggestions.length);
  let selRow = null;
  box.replaceChildren(...suggestions.map((s, i) => {
    const row = el('div', `sug${i === sugSel ? ' sel' : ''}`);
    if (i === sugSel) selRow = row;
    row.append(el('span', 'lab', s.label), el('span', 'det', s.detail || ''));
    row.onclick = s.apply;
    return row;
  }));
  // keep the highlighted command visible as you arrow past the box's max-height
  selRow?.scrollIntoView({ block: 'nearest' });
}

async function runCommand(raw) {
  const [cmd, ...args] = raw.slice(1).trim().split(/\s+/);
  const arg = args.join(' ');
  const c = (cmd || '').toLowerCase();
  const go = (v) => { setView(v); render(); };

  if (['cal', 'calendar'].includes(c)) return go('calendar');
  if (['kanban', 'kan'].includes(c)) return go('kanban');
  if (['archived'].includes(c)) return go('archive');
  if (['time', 'timer', 'csv'].includes(c)) return go('time');
  if (['stats'].includes(c)) return toast($('stats').textContent.replace(/\n/g, ' · '));
  if (['inbox'].includes(c)) { project = 'inbox'; tagFilter = null; setView('board'); return refresh(); }
  if (['all'].includes(c)) { tagFilter = null; setView('board'); return render(); }
  if (['tag'].includes(c)) { tagFilter = arg ? `#${arg.replace(/^#/, '')}` : null; setView('board'); return render(); }
  if (['sort'].includes(c)) { await api('/api/op', { op: 'sort', index: 0, project, arg: arg || 'priority' }); setView('board'); return refresh(); }
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
    if (out.ok) { project = out.name; tagFilter = null; setView('board'); refresh(); }
    return;
  }
  if (['move', 'mv'].includes(c)) {
    if (!arg) return toast('usage: /move <project> — or use a task’s move… dropdown');
    const last = S.tasks[S.tasks.length - 1];
    if (!last) return toast('no task to move');
    return op('move', last.i, arg);
  }
  if (['toggl'].includes(c)) { setView('time'); render(); return $('toggl-token')?.focus(); }
  if (['calendars', 'cals'].includes(c)) return go('settings');
  if (['oura', 'sleep', 'ring'].includes(c)) {
    if (arg === 'off') return ouraAction({ action: 'disconnect' }, 'Oura disconnected');
    if (S.oura?.connected) return ouraAction({ action: 'refresh' }, 'sleep refreshed');
    setView('home'); // wellness setup lives on the home page now
    return openOuraConnect($('home-body'), S.oura);
  }
  if (['location', 'loc', 'sun'].includes(c)) {
    if (arg === 'clear') return locationAction({ action: 'clear' }, 'location cleared');
    if (arg) return setLocation(arg);
    setView('home');
    return inlineField($('home-body'), { placeholder: 'city name', onSubmit: setLocation });
  }
  if (['exit', 'quit', 'q'].includes(c)) return toast('this is a website — just close the tab :)');
  toast(`unknown command /${cmd}`);
}

$('prompt').addEventListener('keydown', (e) => {
  const p = $('prompt');
  if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); sugSel = (sugSel - 1 + suggestions.length) % suggestions.length; return updateSuggestions(); }
  if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); sugSel = (sugSel + 1) % suggestions.length; return updateSuggestions(); }
  if (e.key === 'Tab' && suggestions.length) { e.preventDefault(); return suggestions[sugSel].apply(); }
  if (e.key === 'Escape') { e.preventDefault(); endEdit(); $('prompt').blur(); return; }
  // enter on a date (or a real priority) populates it and moves to the next
  // prompt instead of submitting; enter on "none"/no suggestion submits
  if (e.key === 'Enter' && suggestions[sugSel]?.enterInserts) { e.preventDefault(); return suggestions[sugSel].apply(); }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  submitPrompt();
});

// add (or save) the task in the prompt; shared by Enter and the "no tag" pick
function submitPrompt() {
  const p = $('prompt');
  const v = p.value.trim();
  if (!v) return;
  if (v.startsWith('/')) {
    p.value = '';
    updateSuggestions();
    closePrompt();
    return runCommand(v);
  }
  const submit = editing != null
    ? api('/api/op', { op: 'edit', index: editing, project, arg: v })
    : api('/api/input', { text: v, project });
  endEdit();
  submit.then(() => refresh());
}

// click the dimmed backdrop (anywhere outside the panel) to dismiss the bar
$('promptwrap').addEventListener('mousedown', (e) => {
  if (e.target === $('promptwrap')) { e.preventDefault(); endEdit(); }
});

$('prompt').addEventListener('input', () => {
  const p = $('prompt');
  const formatted = autoFormatDates(p.value);
  if (formatted !== p.value) p.value = formatted;
  sugSel = 0;
  updateSuggestions();
});

/* ── kanban board ──────────────────────────────────────────────────────
   A standalone board (kanban.md): columns are headings, cards are tasks.
   Drag a card between columns to change its status; drag column headers to
   reorder. Cards reuse the board's tag colouring + date span. */
let kanban = null;          // last GET /api/kanban
let kanCardDrag = null;     // { col, i } of the card being dragged
let kanCardDragEl = null;   // the card element being dragged (for live reordering)
let kanColDrag = null;      // index of the column being dragged
let kanColDragEl = null;    // the column element being dragged

// Obsidian-style live drag: while a card/column is dragged, the others slide to
// open a gap. FLIP — measure every sibling before the move, do the DOM move, then
// transform each from its old box to (0,0) with an ease. Cards move on Y, columns
// on X, so this captures both axes. `playKanFlip` mirrors the inbox's playRectFlip.
function captureKanRects(selector, except) {
  const m = new Map();
  for (const n of document.querySelectorAll(selector)) {
    if (n === except) continue;
    const r = n.getBoundingClientRect();
    m.set(n, { x: r.left, y: r.top });
  }
  return m;
}
function playKanFlip(map, dur = 180) {
  const moved = [];
  for (const [node, prev] of map) {
    const r = node.getBoundingClientRect();
    const dx = prev.x - r.left, dy = prev.y - r.top;
    if (!dx && !dy) continue;
    node.style.transition = 'transform 0s';
    node.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(node);
  }
  if (!moved.length) return;
  requestAnimationFrame(() => {
    for (const node of moved) {
      node.style.transition = `transform ${dur}ms cubic-bezier(.2,.7,.3,1)`;
      node.style.transform = '';
    }
  });
}
function clearKanTransforms() {
  for (const n of document.querySelectorAll('#kanban-board .kan-card, #kanban-board .kan-col'))
    { n.style.transition = ''; n.style.transform = ''; }
}

// collapsed lists, by name, remembered in this browser (like the theme prefs)
let kanCollapsed = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('gretchen-kanban-collapsed')) || []); }
  catch { return new Set(); }
})();
function toggleKanCollapse(name) {
  if (kanCollapsed.has(name)) kanCollapsed.delete(name);
  else kanCollapsed.add(name);
  try { localStorage.setItem('gretchen-kanban-collapsed', JSON.stringify([...kanCollapsed])); } catch {}
  renderKanban();
}

function kanCardVisible(card) {
  return !tagFilter || (card.tags || []).includes(tagFilter);
}
function kanClearMarkers() {
  document.querySelectorAll('.kan-card.drop-before, .kan-card.drop-after')
    .forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  document.querySelectorAll('.kan-col.drop-into, .kan-col.col-drop-before, .kan-col.col-drop-after')
    .forEach((x) => x.classList.remove('drop-into', 'col-drop-before', 'col-drop-after'));
}
function closeKanMenus() {
  document.querySelectorAll('.kan-menu').forEach((m) => m.remove());
}

async function renderKanban() {
  const board = $('kanban-board');
  if (!board) return;
  kanban = await api('/api/kanban');
  const cols = kanban.columns || [];

  const fc = $('kanban-filter');
  if (fc) {
    fc.classList.toggle('hidden', !tagFilter);
    fc.textContent = tagFilter ? `${tagFilter} — click the tag again to clear` : '';
    fc.style.color = (tagFilter && tagColor(tagFilter)) || '';
  }

  board.replaceChildren(...cols.map((col, ci) => kanColumn(col, ci)));

  // + Add list
  const addCol = el('div', 'kan-addcol');
  const addBtn = el('div', 'kan-addcol-btn', '+ Add list');
  addBtn.onclick = () => {
    const input = el('input');
    input.placeholder = 'list name';
    input.onkeydown = async (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const name = input.value.trim();
        if (name) { const out = await api('/api/kanban', { action: 'add-column', name }); if (out.ok) return refresh(); }
        renderKanban();
      } else if (e.key === 'Escape') renderKanban();
    };
    input.onblur = () => renderKanban();
    addCol.replaceChildren(input);
    input.focus();
  };
  addCol.append(addBtn);
  board.append(addCol);
}

function kanColumn(col, ci) {
  const colEl = el('div', 'kan-col');
  colEl.dataset.col = ci;

  const head = el('div', 'kan-col-head');
  head.draggable = true;
  head.addEventListener('dragstart', (e) => {
    kanColDrag = ci;
    kanColDragEl = colEl;
    requestAnimationFrame(() => colEl.classList.add('col-dragging')); // after the drag image is grabbed
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `col:${ci}`);
  });
  head.addEventListener('dragend', () => {
    colEl.classList.remove('col-dragging');
    clearKanTransforms();
    if (kanColDrag == null) return;
    // commit: drop before whatever column now follows the dragged one
    let next = colEl.nextElementSibling;
    while (next && !next.classList.contains('kan-col')) next = next.nextElementSibling;
    const to = next ? Number(next.dataset.col) : (kanban.columns || []).length;
    const from = kanColDrag;
    kanColDrag = null;
    kanColDragEl = null;
    kanMoveColumn(from, to);
  });
  const collapsed = kanCollapsed.has(col.name);
  if (collapsed) colEl.classList.add('collapsed');
  const handle = el('span', 'kan-handle', '⠿');
  handle.title = 'drag to reorder';
  const chev = el('button', 'kan-chev', collapsed ? '›' : '⌄');
  chev.title = collapsed ? 'expand list' : 'collapse list';
  chev.onclick = (e) => { e.stopPropagation(); toggleKanCollapse(col.name); };
  const name = el('span', 'kan-col-name', col.name);
  name.title = 'double-click to rename';
  name.ondblclick = () => kanRename(colEl, ci, col.name);
  const shown = tagFilter ? col.cards.filter(kanCardVisible).length : col.cards.length;
  const count = el('span', 'kan-col-count', String(shown));
  const menu = el('button', 'kan-col-menu', '⋯');
  menu.title = 'list actions';
  menu.onclick = (e) => { e.stopPropagation(); kanColMenu(ci, col, menu); };
  head.append(handle, chev, name, count, menu);
  colEl.append(head);

  const list = el('div', 'kan-cards');
  for (const card of col.cards) if (kanCardVisible(card)) list.append(kanCard(card, ci));
  colEl.append(list);

  const adder = el('div', 'kan-add', '+ Add a card');
  adder.onclick = () => kanAddCard(colEl, ci);
  colEl.append(adder);

  // Live card drag: hovering anywhere in this column slides the dragged card into
  // place (cards in both the source and target column animate via FLIP). Listening
  // on the whole column — not just the list — keeps near-empty columns droppable.
  colEl.addEventListener('dragover', (e) => {
    if (!kanCardDragEl) return; // column reordering is handled at the board level
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cards = [...list.children].filter((c) => c.classList.contains('kan-card') && c !== kanCardDragEl);
    // insert before the first card whose midpoint sits below the cursor; past the
    // last → null → append to the end of this column
    let ref = null;
    for (const r of cards) {
      const box = r.getBoundingClientRect();
      if (e.clientY < box.top + box.height / 2) { ref = r; break; }
    }
    if (kanCardDragEl.parentElement === list && kanCardDragEl.nextElementSibling === ref) return;
    const first = captureKanRects('#kanban-board .kan-card', kanCardDragEl); // measure before the move
    list.insertBefore(kanCardDragEl, ref);
    playKanFlip(first); // slide the displaced cards from their old spots
  });
  colEl.addEventListener('drop', (e) => { if (kanCardDragEl) e.preventDefault(); });

  return colEl;
}

function kanCard(card, ci) {
  const c = el('div', 'kan-card');
  const title = el('div', 'kan-card-title');
  for (const part of card.title.split(/(#[\w/-]+)/g)) {
    if (part.startsWith('#')) {
      const a = el('span', 'tag', part);
      const col = tagColor(part);
      if (col) a.style.color = col;
      a.onclick = (e) => { e.stopPropagation(); tagFilter = tagFilter === part ? null : part; render(); };
      title.append(a);
    } else if (part) title.append(part);
  }
  if (card.priority) title.append(' ' + (S.priorities.find((p) => p.key === card.priority)?.emoji || ''));
  title.onclick = (e) => { e.stopPropagation(); kanEditCard(ci, card, c); }; // click the words to edit
  c.append(title);
  const d = dateSpan(card);
  if (d) { const meta = el('div', 'kan-card-meta'); meta.append(d); c.append(meta); }

  const menu = el('button', 'kan-card-menu', '⋯');
  menu.onclick = (e) => { e.stopPropagation(); kanCardMenu(ci, card, c); };
  c.append(menu);

  c.dataset.i = card.i; // file index in its column, read back to commit a move
  c.draggable = !tagFilter; // under a tag filter the visible order ≠ file order, so no live reorder
  c.addEventListener('dragstart', (e) => {
    kanCardDrag = { col: ci, i: card.i };
    kanCardDragEl = c;
    requestAnimationFrame(() => c.classList.add('dragging')); // after the drag image is grabbed
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `card:${ci}:${card.i}`);
    e.stopPropagation();
  });
  c.addEventListener('dragend', () => {
    c.classList.remove('dragging');
    clearKanTransforms();
    if (!kanCardDrag) return;
    // commit where the card now sits: drop before the card that follows it, or
    // append (column length) when it's last
    const targetCol = Number(c.closest('.kan-col').dataset.col);
    let next = c.nextElementSibling;
    while (next && !next.classList.contains('kan-card')) next = next.nextElementSibling;
    const toI = next ? Number(next.dataset.i) : (kanban.columns[targetCol]?.cards.length ?? 0);
    const from = kanCardDrag;
    kanCardDrag = null;
    kanCardDragEl = null;
    kanMoveCard(from, targetCol, toI);
  });
  return c;
}

async function kanMoveCard(from, toCol, toI) {
  kanCardDrag = null;
  kanClearMarkers();
  const out = await api('/api/kanban', { action: 'move-card', col: from.col, i: from.i, toCol, toI });
  if (out.ok) refresh();
}
async function kanMoveColumn(from, to) {
  kanColDrag = null;
  kanClearMarkers();
  const out = await api('/api/kanban', { action: 'move-column', from, to });
  if (out.ok) refresh();
}

// ── card inputs: tag/date/priority autocomplete + live date formatting ──
// A self-contained dropdown attached to any card input. Reuses the board
// prompt's contexts (HASH_CTX/DATE_CTX/PRIO_CTX), data (S.tags/S.dates/
// S.priorities) and autoFormatDates ("due friday "→📅). The input must already
// have a parent node; it's wrapped so the menu can float above it.
function attachSmartInput(input, { onSubmit, onCancel } = {}) {
  const wrap = el('span', 'kan-input');
  input.replaceWith(wrap);
  wrap.append(input);
  let items = [];
  let sel = 0;
  let menu = null;

  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } items = []; sel = 0; };
  const insert = (re, text) => { input.value = input.value.replace(re, '') + text; };

  const paint = () => {
    if (menu) { menu.remove(); menu = null; }
    if (!items.length) return;
    menu = el('div', 'kan-suggest');
    items.forEach((it, i) => {
      const row = el('div', `sug${i === sel ? ' sel' : ''}`);
      row.append(el('span', 'lab', it.label), el('span', 'det', it.detail || ''));
      // mousedown (not click) so picking a row doesn't blur+cancel the input first
      row.onmousedown = (e) => { e.preventDefault(); it.apply(); compute(); input.focus(); };
      menu.append(row);
    });
    wrap.append(menu);
    // the board clips overflow, so place the menu on whichever side of the input
    // has more room and cap its height to fit — never spilling past the board edge
    const board = document.getElementById('kanban-board');
    const br = board ? board.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const ir = input.getBoundingClientRect();
    const below = br.bottom - ir.bottom - 8;
    const above = ir.top - br.top - 8;
    const up = menu.offsetHeight > below && above > below;
    menu.classList.toggle('up', up);
    menu.style.maxHeight = `${Math.min(220, Math.max(60, up ? above : below))}px`;
  };

  function compute() {
    const v = input.value;
    items = [];
    if (HASH_CTX.test(v)) {
      const p = v.match(HASH_CTX)[1].toLowerCase();
      items = (S.tags || []).filter((t) => t.tag.slice(1).toLowerCase().startsWith(p))
        .map((t) => ({ label: t.tag, detail: `${t.count}`, apply: () => insert(HASH_CTX, `${t.tag} `) }));
    } else if (PRIO_CTX.test(v)) {
      const p = v.match(PRIO_CTX)[2].toLowerCase();
      items = [{ key: 'none', emoji: '' }, ...(S.priorities || [])].filter((x) => x.key.startsWith(p))
        .map((x) => ({ label: `${x.emoji || '·'} ${x.key}`, detail: x.key === 'none' ? 'no priority' : '',
          apply: () => insert(/([a-z]*)$/i, x.emoji ? `${x.emoji} ` : '') }));
    } else if (DATE_CTX.test(v) || DUE_PREFIX.test(v)) {
      // a partial "du"/"due" pops the date menu too, just like the board's bar
      const m = v.match(DATE_CTX);
      const p = m ? m[2].toLowerCase() : '';
      const replaceRe = m ? DATE_CTX : DUE_PREFIX;
      items = (S.dates || []).filter((d) => d.label.startsWith(p) || d.date.startsWith(p))
        .map((d) => ({ label: d.label, detail: `📅 ${d.date}`, apply: () => insert(replaceRe, `📅 ${d.date} `) }));
    }
    sel = Math.min(sel, Math.max(0, items.length - 1));
    paint();
  }

  input.addEventListener('input', () => { input.value = autoFormatDates(input.value); compute(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep the board's global key handlers out of card inputs
    if (menu && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; return paint(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; return paint(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); items[sel].apply(); return compute(); }
      if (e.key === 'Escape') { e.preventDefault(); return closeMenu(); }
    }
    if (e.key === 'Enter') { e.preventDefault(); const t = input.value.trim(); if (t) onSubmit?.(t); else onCancel?.(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
  });
  return input;
}


function kanAddCard(colEl, ci) {
  const input = el('input', 'kan-add-input');
  input.placeholder = 'card — #tag, due friday';
  input.onblur = () => renderKanban();
  colEl.querySelector('.kan-add').replaceWith(input);
  attachSmartInput(input, {
    onSubmit: async (text) => { const out = await api('/api/kanban', { action: 'add-card', col: ci, text }); if (out.ok) refresh(); else renderKanban(); },
    onCancel: () => renderKanban(),
  });
  input.focus();
}

function kanRename(colEl, ci, current) {
  const input = el('input', 'kan-rename');
  input.value = current;
  input.onkeydown = async (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const name = input.value.trim();
      if (name && name !== current) { const out = await api('/api/kanban', { action: 'rename-column', col: ci, name }); if (out.ok) return refresh(); }
      renderKanban();
    } else if (e.key === 'Escape') renderKanban();
  };
  input.onblur = () => renderKanban();
  colEl.querySelector('.kan-col-head').replaceChildren(input);
  input.focus();
  input.select();
}

function kanColMenu(ci, col, anchor) {
  closeKanMenus();
  const m = el('div', 'kan-menu');
  const rename = el('button', '', 'Rename');
  rename.onclick = () => { closeKanMenus(); kanRename(anchor.closest('.kan-col'), ci, col.name); };
  const del = el('button', 'danger', 'Delete list');
  del.onclick = async () => {
    closeKanMenus();
    if (col.cards.length && !confirm(`Delete "${col.name}" and its ${col.cards.length} card(s)?`)) return;
    const out = await api('/api/kanban', { action: 'delete-column', col: ci, force: true });
    if (out.ok) refresh();
  };
  m.append(rename);
  // archive every card in this list into ~/.gretchen/archive.md (handy for Done)
  if (col.cards.length) {
    const arch = el('button', '', `Archive cards (${col.cards.length})`);
    arch.onclick = async () => {
      closeKanMenus();
      const out = await api('/api/kanban', { action: 'archive-column', col: ci });
      if (out.ok) { toast(`archived ${out.count} card${out.count === 1 ? '' : 's'}`); refresh(); }
    };
    m.append(arch);
  }
  m.append(del);
  anchor.closest('.kan-col-head').append(m);
  setTimeout(() => document.addEventListener('click', closeKanMenus, { once: true }), 0);
}

function kanCardMenu(ci, card, cardEl) {
  closeKanMenus();
  const m = el('div', 'kan-menu');
  const edit = el('button', '', 'Edit');
  edit.onclick = () => { closeKanMenus(); kanEditCard(ci, card, cardEl); };
  const del = el('button', 'danger', 'Delete');
  del.onclick = async () => { closeKanMenus(); const out = await api('/api/kanban', { action: 'delete-card', col: ci, i: card.i }); if (out.ok) refresh(); };
  m.append(edit, del);
  cardEl.append(m);
  setTimeout(() => document.addEventListener('click', closeKanMenus, { once: true }), 0);
}

function kanEditCard(ci, card, cardEl) {
  const input = el('input', 'kan-edit');
  input.value = card.title;
  input.onblur = () => renderKanban();
  cardEl.replaceChildren(input);
  attachSmartInput(input, {
    onSubmit: async (text) => { const out = await api('/api/kanban', { action: 'edit-card', col: ci, i: card.i, text }); if (out.ok) refresh(); else renderKanban(); },
    onCancel: () => renderKanban(),
  });
  input.focus();
  input.select();
}

/* ── views ─────────────────────────────────────────────────────────── */
function setView(v) {
  view = v;
  $('promptwrap').classList.add('hidden'); // never leave the add-bar overlay open across views
  for (const b of document.querySelectorAll('.navbtn'))
    b.classList.toggle('active', b.dataset.view === v && (v !== 'board' || project === 'inbox'));
  for (const s of document.querySelectorAll('.view')) s.classList.add('hidden');
  $(`view-${v}`).classList.remove('hidden');
  if (v === 'archive') renderArchive();
  if (v === 'calendar') renderCalendar();
  if (v === 'kanban') renderKanban();
  if (v === 'home') renderHome();
  if (v === 'time') renderTime();
  if (v === 'settings') renderSettings();
  document.activeElement?.blur(); // no field focused, so board ↑/↓ and view keys work
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
// Live reorder: as the cursor moves, slot the dragged row into place among the
// others and slide the displaced rows to make room. The order commits on the
// row's dragend. Dropping in the empty space below sends the task to the bottom.
$('tasks').addEventListener('dragover', (e) => {
  if (dragEl == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const list = $('tasks');
  const rows = [...list.children].filter((c) => c.classList.contains('task') && c !== dragEl);
  // insert before the first row whose midpoint sits below the cursor; past the
  // last row → null → append to the end
  let ref = null;
  for (const r of rows) {
    const box = r.getBoundingClientRect();
    if (e.clientY < box.top + box.height / 2) { ref = r; break; }
  }
  // already in that slot? nothing to do (avoids re-triggering the slide)
  if (dragEl.nextElementSibling === ref) return;
  const first = captureRects(list, dragEl); // measure others before the move
  list.insertBefore(dragEl, ref);
  playRectFlip(first); // slide the displaced rows from their old spot to the new one
});
$('tasks').addEventListener('drop', (e) => { if (dragEl != null) e.preventDefault(); });

// Live column drag: while a list is dragged the others slide left/right to open a
// gap (FLIP on X). Attached once to the persistent board; commit happens on the
// header's dragend. Mirrors the inbox row reorder, one axis over.
$('kanban-board').addEventListener('dragover', (e) => {
  if (kanColDragEl == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const board = $('kanban-board');
  const cols = [...board.children].filter((c) => c.classList.contains('kan-col') && c !== kanColDragEl);
  // insert before the first column whose horizontal midpoint is right of the cursor
  let ref = null;
  for (const c of cols) {
    const box = c.getBoundingClientRect();
    if (e.clientX < box.left + box.width / 2) { ref = c; break; }
  }
  if (ref == null) ref = board.querySelector('.kan-addcol'); // keep the dragged list left of "+ Add list"
  if (kanColDragEl.nextElementSibling === ref) return;
  const first = captureKanRects('#kanban-board .kan-col', kanColDragEl); // measure before the move
  board.insertBefore(kanColDragEl, ref);
  playKanFlip(first); // slide the displaced lists across
});
$('kanban-board').addEventListener('drop', (e) => { if (kanColDragEl != null) e.preventDefault(); });

$('new-project').onclick = newProjectPrompt;

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

  // tasks first, then read-only Apple events; one shared "+N more" overflow
  const tasks = calByDate()[key] || [];
  const evs = extByDate()[key] || [];
  let shown = 0, hidden = 0;
  for (const t of tasks) {
    if (shown < eventLimit) {
      const row = el('div', `cal-task${t.done ? ' done' : ''}`, `• ${t.title}`);
      row.title = `${t.title} (${t.project})`;
      cell.append(row);
      shown++;
    } else hidden++;
  }
  for (const e of evs) {
    if (shown < eventLimit) { cell.append(calExtRow(e, false)); shown++; } else hidden++;
  }
  if (hidden > 0) cell.append(el('div', 'cal-task dim', `+${hidden} more`));
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

// ── read-only Apple Calendar events ────────────────────────────────────
// Fetched per visible range and cached; granting access or moving the view
// (a new range) refetches. extByDateCache survives task-only re-renders.
let calRangeKey = null;
let extByDateCache = {};
function extByDate() { return extByDateCache; }

function calVisibleRange() {
  const c = cursor();
  const mk = (dt, add) => iso(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + add));
  if (calMode === 'day') return [iso(c), mk(c, 1)];
  if (calMode === 'week') {
    const ws = new Date(c.getFullYear(), c.getMonth(), c.getDate() - c.getDay());
    return [iso(ws), mk(ws, 7)];
  }
  const first = new Date(c.getFullYear(), c.getMonth(), 1);
  const start = new Date(c.getFullYear(), c.getMonth(), 1 - first.getDay());
  return [iso(start), mk(start, 42)];
}

async function ensureCalEvents(startISO, endISO) {
  // fetch events if Calendar access is live (authorized) or the user connected
  // before (connected) — the events endpoint reads the OS grant directly, so
  // they come back after a restart without re-connecting
  const authed = !!(S.appleCal && (S.appleCal.authorized || S.appleCal.connected));
  const key = `${authed}|${startISO}|${endISO}`;
  if (key === calRangeKey) return; // already loaded (or loading) this range
  calRangeKey = key;
  if (!authed) { extByDateCache = {}; return; }
  const out = await api(`/api/calendar-events?start=${startISO}&end=${endISO}`);
  const byDate = {};
  for (const e of out.events || []) (byDate[e.date] ||= []).push(e);
  extByDateCache = byDate;
  if (view === 'calendar') renderCalendar(); // repaint now that events are in
}

function fmtEventTime(isoStr) {
  const m = (isoStr || '').match(/T(\d{2}):(\d{2})/);
  if (!m) return '';
  let h = Number(m[1]);
  const ap = h < 12 ? 'a' : 'p';
  h = h % 12 || 12;
  return m[2] === '00' ? `${h}${ap}` : `${h}:${m[2]}${ap}`;
}

function calExtRow(e, withTime) {
  const row = el('div', 'cal-ext');
  const dot = el('span', 'cal-dot');
  dot.style.background = e.colorHex || 'var(--dim)';
  const label = (!e.allDay && withTime ? `${fmtEventTime(e.start)} ` : '') + e.title;
  row.append(dot, el('span', 'cal-ext-t', label));
  row.title = `${e.title}${e.location ? ` @ ${e.location}` : ''} — ${e.calTitle}`;
  return row;
}

function renderCalendar() {
  _byDate = null;
  const [rangeStart, rangeEnd] = calVisibleRange();
  ensureCalEvents(rangeStart, rangeEnd); // async; repaints when events arrive
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
    const evs = extByDate()[key] || [];
    if (!tasks.length && !evs.length) box.append(el('div', 'dim', 'Nothing on this day.'));
    for (const t of tasks) {
      const cls = t.done ? 'done' : !t.done && t.date < S.today ? 'overdue' : '';
      box.append(el('div', `day-task ${cls}`, `${t.done ? '[x]' : '[ ]'} ${t.title}  (${t.project})`));
    }
    for (const e of evs) box.append(calExtRow(e, true));
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

/* archive — grouped year / month / week, newest first, with unarchive.
   Each heading is a collapsible group: click the heading to fold/unfold it. */
async function renderArchive() {
  const { tasks } = await api('/api/archive');
  const list = $('archive-list');
  list.replaceChildren();
  let prev = {};
  let yBody, mBody, wBody;

  // a collapsible group: clickable heading + a body that holds its children
  const group = (level, label) => {
    const g = el('div', `arch-group arch-lvl${level}`);
    const head = el('div', `arch-h${level} arch-head`, label);
    head.prepend(el('span', 'arch-caret', '▾'));
    const body = el('div', 'arch-body');
    head.onclick = () => g.classList.toggle('collapsed');
    g.append(head, body);
    return { g, body };
  };

  for (const t of tasks) {
    const s = t.sections;
    if (s.year !== prev.year) {
      const grp = group(1, s.year); list.append(grp.g); yBody = grp.body;
    }
    if (s.year !== prev.year || s.month !== prev.month) {
      const grp = group(2, s.month); yBody.append(grp.g); mBody = grp.body;
    }
    if (s.year !== prev.year || s.month !== prev.month || s.week !== prev.week) {
      const grp = group(3, s.week); mBody.append(grp.g); wBody = grp.body;
    }
    prev = s;

    const row = el('div', 'task done');
    const title = el('span', 'title', `✓ ${t.title}`);
    const un = el('button', '', '↩ unarchive');
    un.title = 'restore to the inbox as an open task';
    un.onclick = async () => { await api('/api/unarchive', { index: t.i }); renderArchive(); refresh(); };
    row.append(title);
    if (t.doneDate) row.append(el('span', 'date', `✅ ${t.doneDate}`));
    row.append(un);
    wBody.append(row);
  }
  if (!tasks.length) list.append(el('div', 'dim', 'nothing archived yet'));
}

/* time — summary, the CSV (newest first), Toggl import email */
// inline setup field (location / Oura token). Setup happens inline, no popups
// (so it works in the Mac app's WKWebView, where window.prompt is a no-op).
function inlineField(host, { placeholder, type, onSubmit }) {
  const row = el('div', 'well-input');
  const input = el('input');
  if (type) input.type = type;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { const v = input.value.trim(); if (v) onSubmit(v); }
    else if (e.key === 'Escape') renderHome();
  };
  row.append(input);
  host.append(row);
  input.focus();
}

// the home view: today's wellness at a glance — sunrise/sunset (from /location)
// and last night's Oura sleep. Setup happens inline, no popups (so it works in
// the Mac app's WKWebView, where window.prompt is a no-op). This used to live
// in the sidebar; it now has its own page.
function renderHome() {
  const box = $('home-body');
  if (!box) return;
  box.replaceChildren();
  const sun = S.sun || { located: false };
  const oura = S.oura || { connected: false };

  const grid = el('div', 'home-grid');

  // ── sunrise / sunset ──
  const sunCard = el('div', 'home-card');
  sunCard.append(el('div', 'home-card-head', 'sunrise & sunset'));
  if (sun.located && sun.sunrise) {
    sunCard.append(el('div', 'home-big', `☀ ${sun.sunrise}  →  ☾ ${sun.sunset}`));
    if (sun.place) sunCard.append(el('div', 'well-sub dim', sun.place));
    const tools = el('div', 'well-tools');
    tools.append(mkWellTool('✎', 'change city', () => inlineField(sunCard, { placeholder: 'city name', onSubmit: setLocation })));
    tools.append(mkWellTool('×', 'clear location', () => locationAction({ action: 'clear' }, 'location cleared')));
    sunCard.append(tools);
  } else if (sun.located) {
    sunCard.append(el('div', 'dim', 'polar day/night — no sunrise today'));
  } else {
    const add = el('button', 'well-add', '+ set location for sunrise/sunset');
    add.onclick = () => inlineField(sunCard, { placeholder: 'city name, e.g. Falls Church', onSubmit: setLocation });
    sunCard.append(add);
  }
  grid.append(sunCard);

  // ── Oura sleep ──
  const sleepCard = el('div', 'home-card');
  sleepCard.append(el('div', 'home-card-head', 'last night'));
  if (!oura.connected) {
    const add = el('button', 'well-add', '+ connect Oura sleep');
    add.onclick = () => openOuraConnect(sleepCard, oura);
    sleepCard.append(add);
  } else if (oura.data) {
    const d = oura.data;
    const head = el('div', 'home-big');
    head.append(el('span', 'sleep-score', `😴 ${d.score ?? '–'}`));
    head.append(el('span', 'ready-score', `  ⚡ ${d.readiness ?? '–'}`));
    sleepCard.append(head);
    if (d.duration) sleepCard.append(el('div', 'well-sub dim', `${d.duration} slept`));
    if (d.bedtime) {
      const bed = el('div', 'well-sub');
      bed.append(el('span', 'bedtime', `🛏 bed by ${d.bedtime}`));
      sleepCard.append(bed);
    }
    if (d.day) sleepCard.append(el('div', 'well-sub dim', d.day));
    const tools = el('div', 'well-tools');
    tools.append(mkWellTool('↻', 'refresh from Oura', () => ouraAction({ action: 'refresh' }, 'sleep refreshed')));
    if (!oura.env) tools.append(mkWellTool('×', 'disconnect Oura', () => ouraAction({ action: 'disconnect' }, 'Oura disconnected')));
    sleepCard.append(tools);
  } else {
    sleepCard.append(el('div', 'dim', 'sleep — syncing… '));
    sleepCard.append(mkWellTool('↻', 'refresh from Oura', () => ouraAction({ action: 'refresh' }, 'sleep refreshed')));
  }
  grid.append(sleepCard);

  box.append(grid);
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
    else if (e.key === 'Escape') renderHome();
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

/* ── settings: theme, Oura, location, keyboard + slash commands ─────── */
// theme is a UI preference kept in localStorage (per the existing pattern);
// the no-flash class is applied by a head script before first paint.
function currentTheme() {
  return document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';
}
function applyTheme(theme) {
  document.documentElement.classList.toggle('theme-light', theme === 'light');
  try { localStorage.setItem('gretchen-theme', theme); } catch {}
  notifyNativeTheme(); // recolour the Mac app's title bar to match
  if (view === 'settings') renderSettings(); // reflect the active button
}

// when running inside the Mac app, tell the native shell the current theme so
// it can match the window chrome (no-op in a browser)
function notifyNativeTheme() {
  try { window.webkit?.messageHandlers?.theme?.postMessage(currentTheme()); } catch {}
}

// font and checkbox shape are UI prefs like the theme — a class on <html>
// (applied before paint by the head script) plus localStorage. The defaults,
// terminal font and circle checkboxes, carry no class.
function currentFont() {
  return document.documentElement.classList.contains('font-minimal') ? 'minimal' : 'terminal';
}
function applyFont(font) {
  document.documentElement.classList.toggle('font-minimal', font === 'minimal');
  try { localStorage.setItem('gretchen-font', font); } catch {}
  if (view === 'settings') renderSettings();
}
function currentCheckbox() {
  return document.documentElement.classList.contains('checkbox-square') ? 'square' : 'circle';
}
function applyCheckbox(style) {
  document.documentElement.classList.toggle('checkbox-square', style === 'square');
  try { localStorage.setItem('gretchen-checkbox', style); } catch {}
  if (view === 'settings') renderSettings();
}
// sound pref: read by soundOn() at play time, so no class is needed
function currentSound() {
  return soundOn() ? 'on' : 'off';
}
function applySound(state) {
  try { localStorage.setItem('gretchen-sound', state); } catch {}
  if (state === 'on') playClonk(); // a preview when turning it on
  if (view === 'settings') renderSettings();
}
// collapsed-sidebar style: 'rail' (default — a slim icon rail) or 'hide'
// (deprecated — the panel slides fully away). Class lives on <html>.
function currentCollapseStyle() {
  return document.documentElement.classList.contains('collapse-hide') ? 'hide' : 'rail';
}
function applyCollapseStyle(style) {
  document.documentElement.classList.toggle('collapse-hide', style === 'hide');
  try { localStorage.setItem('gretchen-collapse', style); } catch {}
  if (view === 'settings') renderSettings();
}
// collapse trigger: 'brand' (default — click the Gretchen logo) or 'button'
// (the previous toggle-icon way)
function currentCollapseTrigger() {
  return document.documentElement.classList.contains('collapse-by-button') ? 'button' : 'brand';
}
function applyCollapseTrigger(trigger) {
  document.documentElement.classList.toggle('collapse-by-button', trigger === 'button');
  try { localStorage.setItem('gretchen-collapse-trigger', trigger); } catch {}
  if (view === 'settings') renderSettings();
}

// a segmented control of two-or-more options (theme, font, checkbox shape)
function segToggle(options, current, onPick) {
  const t = el('div', 'theme-toggle');
  for (const o of options) {
    const b = el('button', current === o.value ? 'active' : '', o.label);
    b.onclick = () => onPick(o.value);
    t.append(b);
  }
  return t;
}

// Tag colours are a UI preference like the theme: kept in localStorage, keyed
// by tag (e.g. "#work" → "#7cb87c"). A tag with no entry keeps the default
// yellow. Choosable colours read well on both the light and dark themes.
const TAG_PALETTE = [
  { name: 'red', hex: '#d4766c' },
  { name: 'orange', hex: '#e0935a' },
  { name: 'green', hex: '#7cb87c' },
  { name: 'teal', hex: '#4db6ac' },
  { name: 'blue', hex: '#6c9ed4' },
  { name: 'indigo', hex: '#8186d4' },
  { name: 'purple', hex: '#b48ead' },
  { name: 'pink', hex: '#d782ba' },
];

function loadTagColors() {
  try { return JSON.parse(localStorage.getItem('gretchen-tag-colors')) || {}; }
  catch { return {}; }
}
let tagColors = loadTagColors();
function tagColor(tag) {
  return tagColors[tag] || null; // null = default (the CSS yellow)
}
function setTagColor(tag, hex) {
  if (hex) tagColors[tag] = hex; else delete tagColors[tag];
  try { localStorage.setItem('gretchen-tag-colors', JSON.stringify(tagColors)); } catch {}
  render(); // recolour tags everywhere and refresh the settings swatches
}

const KEY_HELP = [
  { group: 'Inbox & project boards', rows: [
    { keys: ['↑', '↓'], desc: 'select a task' },
    { keys: ['⇧↑', '⇧↓'], desc: 'move the task (with its sub-tasks)' },
    { keys: ['⇧→', '⇧←'], desc: 'nest / un-nest as a sub-task' },
    { keys: ['Enter', 'Space'], desc: 'toggle done' },
    { keys: ['⌫', 'Del'], desc: 'delete the selected task' },
    { keys: ['⇧N'], desc: 'jump to the add-task bar' },
    { keys: ['click'], desc: 'select · double-click edits in place' },
    { keys: ['drag'], desc: 'reorder a task and its sub-tasks' },
  ] },
  { group: 'Add-task bar', rows: [
    { keys: ['Enter'], desc: 'add the typed task' },
    { keys: ['↑', '↓'], desc: 'move through the suggestion menu' },
    { keys: ['Tab'], desc: 'insert the highlighted suggestion' },
    { keys: ['Esc'], desc: 'clear and leave the bar' },
    { keys: ['/'], desc: 'run a command (/cal, /sort, …)' },
  ] },
  { group: 'Calendar', rows: [
    { keys: ['m', 'w', 'd'], desc: 'month / week / day view' },
    { keys: ['Tab', 'v'], desc: 'cycle through the views' },
    { keys: ['Enter'], desc: 'zoom in (month → week → day)' },
    { keys: ['←', '→'], desc: 'previous / next day' },
    { keys: ['↑', '↓'], desc: 'previous / next week' },
    { keys: ['⇧←', '⇧→'], desc: 'previous / next period' },
    { keys: ['t'], desc: 'jump to today' },
    { keys: ['Esc'], desc: 'back to the inbox' },
  ] },
  { group: 'Mac app', rows: [
    { keys: ['⌘R'], desc: 'reload (picks up web app edits)' },
    { keys: ['⌘W'], desc: 'close the window' },
    { keys: ['⌘Q'], desc: 'quit' },
  ] },
];

function settingsSection(title, contentEl) {
  const s = el('div', 'set-section');
  s.append(el('h2', '', title), contentEl);
  return s;
}

function renderSettings() {
  const body = $('settings-body');
  if (!body || !S) return;
  body.replaceChildren();

  // ── appearance / theme ──
  const themeCard = el('div', 'set-card');
  const themeRow = el('div', 'set-row');
  themeRow.append(el('span', '', 'Theme'));
  const toggle = el('div', 'theme-toggle');
  for (const t of ['dark', 'light']) {
    const b = el('button', currentTheme() === t ? 'active' : '', t);
    b.onclick = () => applyTheme(t);
    toggle.append(b);
  }
  themeRow.append(toggle);
  themeCard.append(themeRow);
  body.append(settingsSection('Appearance', themeCard));

  // ── fonts ──
  const fontCard = el('div', 'set-card');
  const fontRow = el('div', 'set-row');
  fontRow.append(el('span', '', 'Font'));
  fontRow.append(segToggle(
    [{ value: 'terminal', label: 'terminal' }, { value: 'minimal', label: 'minimal' }],
    currentFont(), applyFont,
  ));
  fontCard.append(fontRow);
  fontCard.append(el('div', 'dim', 'Terminal is the monospace default. Minimal is the clean sans-serif from Obsidian’s Minimal theme.'));
  body.append(settingsSection('Fonts', fontCard));

  // ── checkbox style ──
  const cbCard = el('div', 'set-card');
  const cbRow = el('div', 'set-row');
  cbRow.append(el('span', '', 'Checkboxes'));
  cbRow.append(segToggle(
    [{ value: 'circle', label: 'circles' }, { value: 'square', label: 'squares' }],
    currentCheckbox(), applyCheckbox,
  ));
  cbCard.append(cbRow);
  cbCard.append(el('div', 'dim', 'Round checkboxes (default) or the classic squares used before.'));
  body.append(settingsSection('Checkboxes', cbCard));

  // ── sound ──
  const sndCard = el('div', 'set-card');
  const sndRow = el('div', 'set-row');
  sndRow.append(el('span', '', 'Check sound'));
  sndRow.append(segToggle(
    [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }],
    currentSound(), applySound,
  ));
  sndCard.append(sndRow);
  sndCard.append(el('div', 'dim', 'A bamboo “clonk” when you check off a task.'));
  body.append(settingsSection('Sound', sndCard));

  // ── sidebar collapse style ──
  const sbCard = el('div', 'set-card');
  const sbRow = el('div', 'set-row');
  sbRow.append(el('span', '', 'When collapsed'));
  sbRow.append(segToggle(
    [{ value: 'rail', label: 'default' }, { value: 'hide', label: 'deprecated' }],
    currentCollapseStyle(), applyCollapseStyle,
  ));
  sbCard.append(sbRow);
  sbCard.append(el('div', 'dim', 'Default keeps a slim icon rail (📥 📅 🗄 🕐 ⚙) when you collapse the sidebar. Deprecated hides it completely, the way it was before.'));

  const trigRow = el('div', 'set-row');
  trigRow.append(el('span', '', 'Collapse by'));
  trigRow.append(segToggle(
    [{ value: 'brand', label: 'Gretchen logo' }, { value: 'button', label: 'toggle button' }],
    currentCollapseTrigger(), applyCollapseTrigger,
  ));
  sbCard.append(trigRow);
  sbCard.append(el('div', 'dim', 'Default collapses when you click the ✻ Gretchen logo. Toggle button shows the separate panel icon instead, the way it was before.'));
  body.append(settingsSection('Sidebar', sbCard));

  // ── tag colours ──
  body.append(settingsSection('Tag colours', renderTagColorSettings()));

  // ── calendars, Oura, location ──
  body.append(settingsSection('Calendars', renderCalendarSettings()));
  body.append(settingsSection('Oura Ring', renderOuraSettings()));
  body.append(settingsSection('Sunrise & sunset', renderLocationSettings()));

  // ── keyboard shortcuts ──
  const keysCard = el('div', 'set-card');
  for (const g of KEY_HELP) {
    keysCard.append(el('div', 'side-head', g.group));
    const grp = el('div', 'kbd-group');
    for (const r of g.rows) {
      const row = el('div', 'kbd-row');
      const keys = el('span', 'kbd-keys');
      r.keys.forEach((k, i) => {
        if (i) keys.append(el('span', 'kbd-sep', '/'));
        keys.append(el('span', 'kbd', k));
      });
      row.append(keys, el('span', 'kbd-desc', r.desc));
      grp.append(row);
    }
    keysCard.append(grp);
  }
  body.append(settingsSection('Keyboard shortcuts', keysCard));

  // ── slash commands (reuse the prompt's command list) ──
  const cmdCard = el('div', 'set-card');
  const cmdGrp = el('div', 'kbd-group');
  for (const c of COMMANDS) {
    const row = el('div', 'kbd-row');
    row.append(
      el('span', 'cmd-name', `/${c.cmd}${c.arg ? ` ${c.arg}` : ''}`),
      el('span', 'kbd-desc', c.desc),
    );
    cmdGrp.append(row);
  }
  cmdCard.append(cmdGrp);
  body.append(settingsSection('Slash commands (type in the prompt)', cmdCard));
}

function renderTagColorSettings() {
  const card = el('div', 'set-card');
  card.append(el('div', 'dim', 'Give any tag its own colour, or leave it default. Colours apply everywhere a #tag shows — in tasks, the sidebar, and the filter — and are saved in this browser.'));
  if (!S.tags.length) {
    card.append(el('div', 'dim', 'No tags yet — add a task with a #tag first.'));
    return card;
  }
  for (const { tag, count } of S.tags) {
    const row = el('div', 'tagcolor-row');
    const name = el('span', 'tagcolor-name', tag);
    const cur = tagColor(tag);
    name.style.color = cur || 'var(--yellow)'; // preview in the chosen (or default) colour
    row.append(name, el('span', 'count', String(count)));

    const swatches = el('div', 'swatches');
    const def = el('button', `swatch swatch-default${cur ? '' : ' sel'}`);
    def.title = 'default';
    def.onclick = () => setTagColor(tag, null);
    swatches.append(def);
    for (const p of TAG_PALETTE) {
      const sw = el('button', `swatch${cur === p.hex ? ' sel' : ''}`);
      sw.style.background = p.hex;
      sw.title = p.name;
      sw.onclick = () => setTagColor(tag, p.hex);
      swatches.append(sw);
    }
    row.append(swatches);
    card.append(row);
  }
  return card;
}

function renderOuraSettings() {
  const card = el('div', 'set-card');
  const oura = S.oura || { connected: false };
  const status = el('div', 'set-status');
  status.append(el('span', 'set-dot' + (oura.connected ? ' on' : ''), oura.connected ? '●' : '○'));
  status.append(el('span', '', oura.connected ? 'Connected' : 'Not connected'));
  card.append(status);
  card.append(el('div', 'dim', 'Reads last night’s sleep & readiness from the Oura API v2 and shows it in the sidebar. The token stays local in ~/.gretchen/oura-token.'));

  if (!oura.connected) {
    const row = el('div', 'set-row');
    const input = el('input');
    input.type = 'password';
    input.placeholder = 'paste your Oura personal access token';
    input.autocomplete = 'off';
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') connectOura(input.value); };
    const connect = el('button', '', 'connect');
    connect.onclick = () => connectOura(input.value);
    const link = el('a', 'set-link', 'get a token ↗');
    link.href = oura.tokenUrl || 'https://cloud.ouraring.com/personal-access-tokens';
    link.target = '_blank';
    link.rel = 'noreferrer';
    row.append(input, connect, link);
    card.append(row);
  } else {
    if (oura.data) {
      const d = oura.data;
      const parts = [];
      if (d.score != null) parts.push(`😴 sleep ${d.score}`);
      if (d.readiness != null) parts.push(`⚡ readiness ${d.readiness}`);
      if (d.duration) parts.push(`${d.duration} slept`);
      if (parts.length) card.append(el('div', '', parts.join('     ')));
    }
    const row = el('div', 'set-row');
    const refresh = el('button', '', '↻ refresh');
    refresh.onclick = () => ouraAction({ action: 'refresh' }, 'sleep refreshed');
    row.append(refresh);
    const dis = el('button', '', 'disconnect');
    dis.disabled = !!oura.env;
    dis.title = oura.env ? 'token comes from $OURA_API_TOKEN — unset it to disconnect' : 'remove the saved token';
    dis.onclick = () => ouraAction({ action: 'disconnect' }, 'Oura disconnected');
    row.append(dis);
    if (oura.env) row.append(el('span', 'dim', 'token from $OURA_API_TOKEN'));
    card.append(row);
  }
  return card;
}

function renderLocationSettings() {
  const card = el('div', 'set-card');
  const sun = S.sun || { located: false };
  const status = el('div', 'set-status');
  status.append(el('span', 'set-dot' + (sun.located ? ' on' : ''), sun.located ? '●' : '○'));
  status.append(el('span', '', sun.located ? (sun.name || 'location set') : 'No location set'));
  card.append(status);
  if (sun.located && sun.sunrise) card.append(el('div', '', `☀ sunrise ${sun.sunrise}     ☾ sunset ${sun.sunset}`));
  card.append(el('div', 'dim', 'Geocoded once via Open-Meteo (no key); times then compute locally. Stored in ~/.gretchen/location.json.'));

  const row = el('div', 'set-row');
  const input = el('input');
  input.placeholder = sun.located ? 'change city' : 'city name, e.g. Falls Church';
  input.autocomplete = 'off';
  const submit = () => { const v = input.value.trim(); if (v) setLocation(v); };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') submit(); };
  const save = el('button', '', 'set');
  save.onclick = submit;
  row.append(input, save);
  if (sun.located) {
    const clear = el('button', '', 'clear');
    clear.onclick = () => locationAction({ action: 'clear' }, 'location cleared');
    row.append(clear);
  }
  card.append(row);
  return card;
}

// Apple Calendar (read-only) + the tasks subscription feed
function renderCalendarSettings() {
  const card = el('div', 'set-card');
  const ac = S.appleCal || { available: false, authorized: false, calendars: [] };

  const connected = ac.available && (ac.authorized || ac.connected);
  const status = el('div', 'set-status');
  status.append(el('span', 'set-dot' + (connected ? ' on' : ''), connected ? '●' : '○'));
  status.append(el('span', '', !ac.available
    ? 'Apple Calendar — not available here'
    : connected ? 'Apple Calendar — connected (read-only)' : 'Apple Calendar — not connected'));
  card.append(status);

  if (!ac.available) {
    card.append(el('div', 'dim', 'Reading your calendar needs the Mac app (or the built helper). Run macos/build.sh once, then reopen — events show here, never edited.'));
  } else if (!connected) {
    card.append(el('div', 'dim', 'Show your Apple Calendar events in the calendar view — read-only, never edited. Click connect, then allow Calendar access when macOS asks.'));
    const row = el('div', 'set-row');
    const connect = el('button', '', 'connect');
    connect.onclick = () => calendarAction({ action: 'refresh' }, 'calendar connected');
    row.append(connect);
    card.append(row);
  } else {
    card.append(el('div', 'dim', 'Toggle which calendars appear in the calendar view.'));
    const list = el('div', 'cal-list');
    for (const c of ac.calendars) {
      const r = el('label', 'cal-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = c.enabled;
      cb.onchange = () => calendarAction({ action: 'toggle', id: c.id }, `${c.title} ${cb.checked ? 'shown' : 'hidden'}`);
      const sw = el('span', 'cal-sw');
      sw.style.background = c.colorHex || 'var(--dim)';
      r.append(cb, sw, el('span', 'cal-name', c.title));
      if (c.source) r.append(el('span', 'dim cal-src', c.source));
      list.append(r);
    }
    if (!ac.calendars.length) list.append(el('div', 'dim', 'no calendars found'));
    card.append(list);
    const row = el('div', 'set-row');
    const refreshBtn = el('button', '', '↻ refresh');
    refreshBtn.onclick = () => calendarAction({ action: 'refresh' }, 'calendars refreshed');
    row.append(refreshBtn);
    card.append(row);
  }

  // tasks → calendar feed (always available; the server serves it live)
  const port = ac.port || location.port || 5277;
  const url = `webcal://localhost:${port}/tasks.ics`;
  const sub = el('div', 'set-subsection');
  sub.append(el('div', 'set-subhead', 'Publish your tasks'));
  sub.append(el('div', 'dim', 'Subscribe in Apple Calendar (File → New Calendar Subscription) to see every dated task on your calendar. It updates as you edit — Calendar re-checks every few minutes, and the server has to be running.'));
  const urlRow = el('div', 'set-row');
  const field = el('input');
  field.className = 'cal-url';
  field.value = url;
  field.readOnly = true;
  field.onclick = () => field.select();
  const copy = el('button', '', 'copy');
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast('subscription URL copied'); }
    catch { field.select(); toast('select + ⌘C to copy'); }
  };
  const open = el('a', 'set-link', 'open in Calendar ↗');
  open.href = url;
  urlRow.append(field, copy, open);
  sub.append(urlRow);

  // one-time download (for importing into another calendar, e.g. Google)
  const dlRow = el('div', 'set-row');
  const dl = el('button', '', '↓ download .ics');
  dl.onclick = async () => {
    const out = await api('/api/export-ics');
    if (out.ok) toast('saved to Downloads/gretchen-tasks.ics — revealed in Finder');
  };
  dlRow.append(dl, el('span', 'dim', 'a one-time file to import elsewhere (e.g. Google Calendar) — not live'));
  sub.append(dlRow);
  card.append(sub);

  return card;
}

async function calendarAction(body, okMsg) {
  const out = await api('/api/calendars', body);
  if (out.ok) { toast(okMsg); refresh(); }
}

refresh();

/* ── collapsible sidebar ───────────────────────────────────────────── */
function setSidebarCollapsed(collapsed) {
  $('app').classList.toggle('sidebar-collapsed', collapsed);
  try { localStorage.setItem('gretchen-sidebar-collapsed', collapsed ? '1' : '0'); } catch {}
}
for (const b of document.querySelectorAll('.sidebar-toggle'))
  b.onclick = () => setSidebarCollapsed(!$('app').classList.contains('sidebar-collapsed'));
// default trigger: clicking the Gretchen brand (logo or words) collapses/expands
document.querySelector('.brand')?.addEventListener('click', (e) => {
  if (currentCollapseTrigger() !== 'brand') return; // 'button' mode uses the toggle icon
  if (e.target.closest('.sidebar-toggle')) return;  // let the icon button handle its own click
  setSidebarCollapsed(!$('app').classList.contains('sidebar-collapsed'));
});
try { if (localStorage.getItem('gretchen-sidebar-collapsed') === '1') setSidebarCollapsed(true); } catch {}
// the Mac app's title-bar button calls this (the in-page toggle is hidden there)
window.gretchenToggleSidebar = () => setSidebarCollapsed(!$('app').classList.contains('sidebar-collapsed'));
notifyNativeTheme(); // match the app chrome to the theme the head script applied

/* ── board keyboard control (no modes) ─────────────────────────────────
   The inbox / project board is navigable whenever the add-bar isn't focused:
   ↑/↓ move the selection, ⇧↑/↓ reorder the selected task, ⇧→/⇧← nest/un-nest
   it, backspace deletes it, enter/space toggles done, ⇧N jumps to the bar. */
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return; // typing in a field
  const k = e.key;
  // ⇧N opens the add-task bar from ANY view (it's a top-level overlay now)
  if (e.shiftKey && (k === 'N' || k === 'n')) { e.preventDefault(); return openPrompt(); }
  if (view !== 'board') return; // the rest of these only steer the board
  const cur = () => visibleTasks[sel];

  if (e.shiftKey && k === 'ArrowUp') { e.preventDefault(); return moveSelected(-1); }
  if (e.shiftKey && k === 'ArrowDown') { e.preventDefault(); return moveSelected(1); }
  if (e.shiftKey && k === 'ArrowRight') { e.preventDefault(); return indentSelected(1); }
  if (e.shiftKey && k === 'ArrowLeft') { e.preventDefault(); return indentSelected(-1); }
  if (k === 'ArrowDown') { e.preventDefault(); sel = Math.min(visibleTasks.length - 1, sel + 1); return renderBoard(); }
  if (k === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); return renderBoard(); }
  if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); const t = cur(); if (t) op('delete', t.i); return; }
  if (k === 'Enter' || k === ' ') { e.preventDefault(); const t = cur(); if (t) { if (!t.done) playClonk(); op('toggle', t.i); } return; }
});

// ⇧→ / ⇧← : nest / un-nest the selected task, keeping the highlight on it
function indentSelected(dir) {
  if (tagFilter || !S || !visibleTasks.length) return;
  const t = visibleTasks[sel];
  if (!t) return;
  const i = S.tasks.indexOf(t);
  if (i < 0) return;
  const cur = t.indent || 0;
  const next = dir > 0
    ? (i === 0 ? cur : Math.min((S.tasks[i - 1].indent || 0) + 1, cur + 1))
    : Math.max(0, cur - 1);
  if (next === cur) return;
  t.indent = next; // optimistic — the bubble shifts immediately
  renderBoard();
  movePending++;
  moveChain = moveChain
    .then(() => api('/api/op', { op: dir > 0 ? 'indent' : 'outdent', index: i, project }))
    .then(() => { if (--movePending === 0) refresh(); }, () => { movePending = 0; refresh(); });
}

/* ── collapsible sidebar sections: click a heading to fold its list ──── */
function setupSectionCollapse(headId, key) {
  const head = $(headId);
  if (!head) return;
  const section = head.closest('.side-section');
  try { if (localStorage.getItem(key) === '1') section.classList.add('collapsed'); } catch {}
  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) { // the + (new project) needs the list open
      section.classList.remove('collapsed');
      try { localStorage.setItem(key, '0'); } catch {}
      return;
    }
    const collapsed = section.classList.toggle('collapsed');
    try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch {}
  });
}
setupSectionCollapse('projects-head', 'gretchen-collapse-projects');
setupSectionCollapse('tags-head', 'gretchen-collapse-tags');

/* ── shift+↑/↓ reorder: keep the highlight on the moved task ──────────────
   Reorder S.tasks locally and re-render immediately so the selection follows
   the task without waiting on the server (no lag, no desync on rapid presses).
   The move is then persisted; server writes are chained so they can't race,
   and we re-sync once the burst is idle. */
function blockSwapMove(tasks, from, dir) {
  const blocks = [];
  for (let i = 0; i < tasks.length; ) {
    let j = i + 1;
    while (j < tasks.length && (tasks[j].indent || 0) > (tasks[i].indent || 0)) j++;
    blocks.push(tasks.slice(i, j));
    i = j;
  }
  const moved = tasks[from];
  const bi = blocks.findIndex((b) => b.includes(moved));
  const swap = bi + dir;
  if (bi < 0 || swap < 0 || swap >= blocks.length) return null; // already at the edge
  [blocks[bi], blocks[swap]] = [blocks[swap], blocks[bi]];
  const next = blocks.flat();
  return { tasks: next, index: next.indexOf(moved) };
}

let moveChain = Promise.resolve();
let movePending = 0;
function moveSelected(dir) {
  if (tagFilter || !S || !visibleTasks.length) return; // reorder is off under a filter
  const t = visibleTasks[sel];
  if (!t) return;
  const from = S.tasks.indexOf(t);
  if (from < 0) return;
  const res = blockSwapMove(S.tasks, from, dir);
  if (!res) return;            // at the top/bottom already
  S.tasks = res.tasks;         // optimistic local reorder
  sel = res.index;             // the selection rides along with the task
  renderBoard();               // instant: FLIP slides and the highlight follows
  movePending++;
  moveChain = moveChain
    .then(() => api('/api/op', { op: dir < 0 ? 'up' : 'down', index: from, project }))
    .then(() => { if (--movePending === 0) refresh(); },
          () => { movePending = 0; refresh(); });
}

/* ── live re-sync ──────────────────────────────────────────────────────
   The app only re-fetched on explicit actions, so changes made elsewhere
   (the CLI, another tab) stayed stale until you navigated — e.g. a #tag that
   lived only in a project wouldn't appear in the sidebar until you opened
   that project. Poll while idle + visible (and on tab focus); re-render only
   when something actually changed, so an unchanged board never churns. */
let stateSig = null;
function appBusy() {
  const ae = document.activeElement;
  if (ae && ['INPUT', 'SELECT', 'TEXTAREA'].includes(ae.tagName)) return true;
  return editing != null || dragFrom != null || movePending > 0;
}
async function pollSync() {
  if (document.hidden || appBusy()) return;
  let next;
  try {
    const res = await fetch(`/api/state?project=${encodeURIComponent(project)}`);
    next = await res.json();
  } catch { return; }
  if (!next || next.error) return;
  const sig = JSON.stringify([
    next.tags, next.projects, next.stats, next.dashboard, next.tracking,
    (next.tasks || []).map((t) => `${t.title}|${t.done}|${t.date || ''}|${t.indent || 0}`),
  ]);
  if (sig === stateSig || appBusy()) return; // unchanged, or the user started interacting
  S = next;
  stateSig = sig;
  render();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollSync(); });
window.addEventListener('focus', pollSync);
setInterval(pollSync, 4000);
