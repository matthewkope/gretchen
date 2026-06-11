#!/usr/bin/env node
// Gretchen app server — static UI + JSON API over the same ~/.gretchen
// markdown files the Gretchen CLI uses. Zero dependencies: node:http only.
// Every mutation re-reads, mutates, and re-writes through lib/store.js, so
// running the CLI and the app at the same time is safe.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTasks, saveTasks, loadAllTasks, loadArchive, saveArchive, archiveTask,
  archiveSections, parseInput, sortTasks, taskBlocks, getTags, today,
  dateSuggestions, listProjects, projectExists, slugifyProject, PRIORITIES,
  SORT_KEYS,
} from './lib/store.js';
import { logEntry, timeStats, timeCsvPath, getEmail, setEmail, fmtDuration } from './lib/timer.js';

const PORT = Number(process.env.PORT || 5277);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

// the one running timer, like the CLI's: in memory, logged to time.csv on stop
let tracking = null; // { title, project, tags, startedAt }

// [start, end) of the block (task + its sub-tasks) that contains index i
function blockRange(tasks, i) {
  let start = i;
  while (start > 0 && (tasks[start].indent || 0) > 0) start--;
  let end = start + 1;
  while (end < tasks.length && (tasks[end].indent || 0) > (tasks[start].indent || 0)) end++;
  return [start, end];
}

function projectOrNull(q) {
  const p = (q || '').trim();
  return p && p !== 'inbox' ? p : null;
}

function stateFor(project) {
  const tasks = loadTasks(project);
  const tagCounts = {};
  for (const t of loadAllTasks()) for (const g of getTags(t)) tagCounts[g] = (tagCounts[g] || 0) + 1;
  const archive = loadArchive();
  const all = [];
  for (const name of [null, ...listProjects()]) {
    for (const t of loadTasks(name)) all.push({ ...t, tags: getTags(t), project: name || 'inbox' });
  }
  const open = all.filter((t) => !t.done);
  return {
    project: project || 'inbox',
    tasks: tasks.map((t, i) => ({ ...t, i, tags: getTags(t) })),
    projects: [
      { name: 'inbox', count: loadTasks(null).filter((t) => !t.done).length },
      ...listProjects().map((name) => ({ name, count: loadTasks(name).filter((t) => !t.done).length })),
    ],
    tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })),
    all, // every task across files, for the calendar
    dates: dateSuggestions(),
    priorities: PRIORITIES,
    sortKeys: SORT_KEYS,
    stats: {
      open: open.length,
      done: all.length - open.length,
      archived: archive.length,
      due: open.filter((t) => t.date === today()).length,
      overdue: open.filter((t) => t.date && t.date < today()).length,
      projects: listProjects().length,
    },
    tracking: tracking && { ...tracking, elapsed: fmtDuration(Date.now() - tracking.startedAt) },
    time: timeStats(),
    email: getEmail(),
    today: today(),
  };
}

function stopTimer() {
  if (!tracking) return null;
  const t = tracking;
  tracking = null;
  logEntry({ description: t.title.replace(/#[\w/-]+/g, '').replace(/\s{2,}/g, ' ').trim() || t.title,
    project: t.project === 'inbox' ? '' : t.project, tags: t.tags, startedAt: t.startedAt, stoppedAt: Date.now() });
  return t;
}

const routes = {
  // add a task from raw prompt text (same parser as the CLI)
  'POST /api/input'({ text, project }) {
    const task = parseInput(text || '');
    if (!task.title) return { error: 'empty task' };
    const p = projectOrNull(project);
    saveTasks(sortTasks([...loadTasks(p), task]), p);
    return { ok: true };
  },

  // block-aware operations on one task, addressed by index in its file
  'POST /api/op'({ op, index, project, arg }) {
    const p = projectOrNull(project);
    const tasks = loadTasks(p);
    const i = Number(index);
    if (!(i >= 0 && i < tasks.length)) return { error: 'stale index — refresh' };
    const [s, e] = blockRange(tasks, i);
    const block = tasks.slice(s, e);

    if (op === 'toggle') {
      const t = tasks[i];
      t.done = !t.done;
      t.doneDate = t.done ? today() : null;
    } else if (op === 'edit') {
      const parsed = parseInput(arg || '');
      if (!parsed.title) return { error: 'empty task' };
      tasks[i] = { ...parsed, done: tasks[i].done, doneDate: tasks[i].doneDate, indent: tasks[i].indent };
    } else if (op === 'delete') {
      tasks.splice(s, e - s);
    } else if (op === 'archive') {
      for (const t of block) archiveTask(t);
      tasks.splice(s, e - s);
    } else if (op === 'move') {
      const destSlug = arg === 'inbox' ? null : slugifyProject(arg || '');
      if (arg !== 'inbox' && !destSlug) return { error: 'bad project name' };
      tasks.splice(s, e - s);
      saveTasks(sortTasks([...loadTasks(destSlug), ...block.map((t, k) => ({ ...t, indent: k === 0 ? 0 : t.indent }))]), destSlug);
    } else if (op === 'indent') {
      if (i > 0) tasks[i].indent = Math.min((tasks[i - 1].indent || 0) + 1, (tasks[i].indent || 0) + 1);
    } else if (op === 'outdent') {
      tasks[i].indent = Math.max(0, (tasks[i].indent || 0) - 1);
    } else if (op === 'up' || op === 'down') {
      const blocks = taskBlocks(tasks);
      const bi = blocks.findIndex((b) => b.includes(tasks[i]));
      const swap = op === 'up' ? bi - 1 : bi + 1;
      if (bi < 0 || swap < 0 || swap >= blocks.length) return { ok: true };
      [blocks[bi], blocks[swap]] = [blocks[swap], blocks[bi]];
      saveTasks(blocks.flat(), p);
      return { ok: true };
    } else if (op === 'sort') {
      saveTasks(sortTasks(tasks, arg || 'priority'), p);
      return { ok: true };
    } else {
      return { error: `unknown op ${op}` };
    }
    saveTasks(tasks, p);
    return { ok: true };
  },

  // archive every completed task in the current list (the CLI's /archive)
  'POST /api/archive-done'({ project }) {
    const p = projectOrNull(project);
    const tasks = loadTasks(p);
    const done = tasks.filter((t) => t.done);
    for (const t of done) archiveTask(t);
    saveTasks(tasks.filter((t) => !t.done), p);
    return { ok: true, count: done.length };
  },

  // the CLI's /file: move inbox tasks whose #tag matches an existing project
  'POST /api/file'() {
    const tasks = loadTasks(null);
    const keep = [];
    let count = 0;
    for (const block of taskBlocks(tasks)) {
      const dest = getTags(block[0]).map((g) => slugifyProject(g.slice(1))).find((s) => s && projectExists(s));
      if (dest) {
        saveTasks(sortTasks([...loadTasks(dest), ...block]), dest);
        count += block.length;
      } else keep.push(...block);
    }
    saveTasks(keep, null);
    return { ok: true, count };
  },

  'POST /api/project'({ name }) {
    const slug = slugifyProject(name || '');
    if (!slug) return { error: 'bad project name' };
    if (!projectExists(slug)) saveTasks([], slug);
    return { ok: true, name: slug };
  },

  'GET /api/archive'() {
    return {
      tasks: loadArchive().map((t, i) => ({ ...t, i, tags: getTags(t), sections: archiveSections(t) })),
    };
  },

  'POST /api/unarchive'({ index }) {
    const archive = loadArchive();
    const i = Number(index);
    if (!(i >= 0 && i < archive.length)) return { error: 'stale index — refresh' };
    const [t] = archive.splice(i, 1);
    saveArchive(archive);
    saveTasks(sortTasks([...loadTasks(null), { ...t, done: false, doneDate: null }]), null);
    return { ok: true };
  },

  'POST /api/time'({ action, title, project, tags, value }) {
    if (action === 'email') {
      setEmail(value || '');
      return { ok: true };
    }
    if (action === 'stop') return { ok: true, stopped: stopTimer() };
    if (action === 'start') {
      stopTimer(); // switching tasks logs the old session first, like the CLI
      tracking = { title, project: project || 'inbox', tags: tags || [], startedAt: Date.now() };
      return { ok: true };
    }
    return { error: `unknown action ${action}` };
  },

  'GET /api/time-log'() {
    let rows = [];
    try {
      rows = fs.readFileSync(timeCsvPath(), 'utf8').trim().split('\n');
    } catch {}
    return { header: rows[0] || '', rows: rows.slice(1).reverse(), path: timeCsvPath() };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (req.method === 'GET' && url.pathname === '/api/state')
      return json(200, stateFor(projectOrNull(url.searchParams.get('project'))));

    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      }
      const out = route(body);
      return json(out.error ? 400 : 200, out);
    }

    if (req.method === 'GET') {
      const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
      if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        return res.end(fs.readFileSync(file));
      }
    }
    json(404, { error: 'not found' });
  } catch (e) {
    json(500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`✻ Gretchen — http://localhost:${PORT}`);
});
