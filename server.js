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
import {
  togglToken, verifyToken, saveToken, clearToken, startEntry, stopEntry,
  loadMap, saveMap, mapKey, togglProjectByName, TOKEN_URL,
} from './lib/toggl.js';
import {
  ouraToken, verifyOuraToken, saveOuraToken, clearOuraToken,
  fetchSleepSummary, fmtSleepDuration, fmtClockOffset, OURA_TOKEN_URL,
} from './lib/oura.js';
import {
  loadLocation, saveLocation, clearLocation, geocode, sunTimes, fmtSunTime,
} from './lib/sun.js';
import { tasksToIcs } from './lib/ics.js';
import { appleCalAvailable, listCalendars, fetchEvents, setCalendarEnabled } from './lib/applecal.js';

const PORT = Number(process.env.PORT || 5277);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

// the one running timer, like the CLI's: in memory, logged to time.csv on stop.
// `id` is the live Toggl time-entry id when Toggl is connected (else null).
let tracking = null; // { title, project, tags, startedAt, id }

// Toggl entry description: the task text only — no #tags, 📅/✅ dates, or
// priority/other emojis (mirrors the CLI's togglDescription)
function togglDescription(title) {
  return (
    title
      .replace(/(?:📅|✅)\s*\d{4}-\d{2}-\d{2}/gu, '')
      .replace(/#[\w][\w/-]*/g, '')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{2000}-\u{206F}\u{FE0F}\u{200D}]/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || 'untitled'
  );
}

// Apple Calendar list, cached. We never run the helper on boot (it would pop
// the macOS permission prompt unbidden) — `available` just reflects whether the
// helper binary exists; the calendar list is pulled on user action (the
// settings card's connect/refresh) and whenever events are fetched.
let appleCalState = { available: appleCalAvailable(), authorized: false, calendars: [] };
async function refreshAppleCal() {
  appleCalState = await listCalendars();
  return appleCalState;
}

// last night's Oura summary, fetched once on boot and on demand (never per
// request — the scores sync a few times a day, not per keystroke)
let ouraData = null;
async function refreshOura() {
  if (!ouraToken()) {
    ouraData = null;
    return null;
  }
  try {
    ouraData = await fetchSleepSummary();
    return ouraData;
  } catch (e) {
    return { error: e.message };
  }
}

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
    toggl: {
      connected: !!togglToken(),
      env: !!process.env.TOGGL_API_TOKEN, // token from $TOGGL_API_TOKEN can't be removed from the UI
      tokenUrl: TOKEN_URL,
      map: loadMap(),
    },
    sun: (() => {
      const loc = loadLocation();
      if (!loc) return { located: false };
      const t = sunTimes(loc.lat, loc.lon);
      return {
        located: true,
        name: loc.name,
        place: loc.name.split(',')[0],
        sunrise: t ? fmtSunTime(t.sunrise, loc.tz) : null,
        sunset: t ? fmtSunTime(t.sunset, loc.tz) : null,
      };
    })(),
    oura: {
      connected: !!ouraToken(),
      env: !!process.env.OURA_API_TOKEN,
      tokenUrl: OURA_TOKEN_URL,
      data: ouraData
        ? {
            day: ouraData.day,
            score: ouraData.score,
            readiness: ouraData.readiness,
            duration: ouraData.duration != null ? fmtSleepDuration(ouraData.duration) : null,
            bedtime: ouraData.bedtime
              ? `${fmtClockOffset(ouraData.bedtime.start_offset)}\u2013${fmtClockOffset(ouraData.bedtime.end_offset)}`
              : null,
          }
        : null,
    },
    appleCal: { ...appleCalState, port: PORT }, // port for the tasks.ics subscribe URL
    today: today(),
  };
}

// stop the running session: append the local CSV row and, if the entry is live
// on Toggl, stop it there too. Toggl failures never block the local log.
async function stopTimer() {
  if (!tracking) return null;
  const t = tracking;
  tracking = null;
  logEntry({ description: togglDescription(t.title),
    project: t.project === 'inbox' ? '' : t.project, tags: t.tags, startedAt: t.startedAt, stoppedAt: Date.now() });
  if (t.id) await stopEntry(t.id).catch(() => {});
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
    } else if (op === 'reorder') {
      // drag-and-drop: move the dragged task's whole block so it lands just
      // before the task at `arg` (its block start); arg >= length appends.
      const to = Number(arg);
      const insertAt = !(to >= 0 && to < tasks.length) ? tasks.length : blockRange(tasks, to)[0];
      if (insertAt > s && insertAt < e) return { ok: true }; // dropped onto itself
      const rest = [...tasks.slice(0, s), ...tasks.slice(e)];
      const at = insertAt >= e ? insertAt - (e - s) : insertAt;
      rest.splice(at, 0, ...block);
      saveTasks(rest, p);
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

  async 'POST /api/time'({ action, title, project, tags, value }) {
    if (action === 'email') {
      setEmail(value || '');
      return { ok: true };
    }
    if (action === 'stop') return { ok: true, stopped: await stopTimer() };
    if (action === 'start') {
      await stopTimer(); // switching tasks logs the old session first, like the CLI
      tracking = { title, project: project || 'inbox', tags: tags || [], startedAt: Date.now(), id: null };
      // also start a live Toggl entry when connected — named after the task,
      // filed under the matching Toggl project (or first #tag); see toggl.js
      if (togglToken()) {
        try {
          const { entry, project: proj } = await startEntry({
            description: togglDescription(title),
            project: project && project !== 'inbox' ? project : '',
            tag: tags && tags[0] ? `#${tags[0]}` : null,
          });
          tracking.id = entry.id;
          tracking.startedAt = new Date(entry.start).getTime();
          return { ok: true, toggl: `→ Toggl project ${proj.name}` };
        } catch (e) {
          return { ok: true, toggl: `local only — Toggl start failed: ${e.message}` };
        }
      }
      return { ok: true };
    }
    return { error: `unknown action ${action}` };
  },

  // connect/disconnect Toggl and manage project routing (the CLI's /toggl)
  async 'POST /api/toggl'({ action, token, from, to }) {
    if (action === 'connect') {
      if (process.env.TOGGL_API_TOKEN) {
        try {
          const me = await verifyToken(process.env.TOGGL_API_TOKEN.trim());
          return { ok: true, name: me.fullname || me.email, env: true };
        } catch (e) {
          return { error: `$TOGGL_API_TOKEN rejected (${e.message})` };
        }
      }
      const tok = (token || '').trim();
      if (!tok) return { error: 'paste your Toggl API token first' };
      try {
        const me = await verifyToken(tok);
        saveToken(tok);
        return { ok: true, name: me.fullname || me.email };
      } catch (e) {
        return { error: `token rejected (${e.message}) — check track.toggl.com/profile` };
      }
    }
    if (action === 'disconnect') {
      if (process.env.TOGGL_API_TOKEN)
        return { error: 'token comes from $TOGGL_API_TOKEN — unset it to disconnect' };
      clearToken();
      return { ok: true };
    }
    if (action === 'map') {
      if (!togglToken()) return { error: 'connect Toggl first' };
      if (!from || !to) return { error: 'usage: map <project-or-#tag> <toggl project>' };
      try {
        const p = await togglProjectByName(to);
        if (!p) return { error: `no Toggl project named "${to}" — create it in Toggl first, or check spelling` };
        const map = loadMap();
        map[mapKey(from)] = p.name;
        saveMap(map);
        return { ok: true, map, name: p.name };
      } catch (e) {
        return { error: `Toggl error: ${e.message}` };
      }
    }
    if (action === 'unmap') {
      const map = loadMap();
      const key = mapKey(from || '');
      if (!key || !(key in map)) return { error: `no mapping for "${from || ''}"` };
      const was = map[key];
      delete map[key];
      saveMap(map);
      return { ok: true, map, was };
    }
    return { error: `unknown action ${action}` };
  },

  // connect/disconnect Oura and refresh last night's sleep (the CLI's /oura)
  async 'POST /api/oura'({ action, token }) {
    if (action === 'connect') {
      if (process.env.OURA_API_TOKEN) {
        try {
          const me = await verifyOuraToken(process.env.OURA_API_TOKEN.trim());
          await refreshOura();
          return { ok: true, name: me.email || 'connected', env: true };
        } catch (e) {
          return { error: `$OURA_API_TOKEN rejected (${e.message})` };
        }
      }
      const tok = (token || '').trim();
      if (!tok) return { error: 'paste your Oura personal access token first' };
      try {
        const me = await verifyOuraToken(tok);
        saveOuraToken(tok);
        await refreshOura();
        return { ok: true, name: me.email || 'connected' };
      } catch (e) {
        return { error: `token rejected (${e.message}) — check cloud.ouraring.com` };
      }
    }
    if (action === 'disconnect') {
      if (process.env.OURA_API_TOKEN)
        return { error: 'token comes from $OURA_API_TOKEN — unset it to disconnect' };
      clearOuraToken();
      ouraData = null;
      return { ok: true };
    }
    if (action === 'refresh') {
      if (!ouraToken()) return { error: 'connect Oura first' };
      const r = await refreshOura();
      if (r && r.error) return { error: r.error };
      return { ok: true };
    }
    return { error: `unknown action ${action}` };
  },

  // set or clear the location for sunrise/sunset (the CLI's /location)
  async 'POST /api/location'({ action, city }) {
    if (action === 'clear') {
      clearLocation();
      return { ok: true };
    }
    if (action === 'set') {
      const q = (city || '').trim();
      if (!q) return { error: 'type a city name' };
      try {
        const loc = await geocode(q);
        if (!loc) return { error: `no place found for "${q}" — try a city name` };
        saveLocation(loc);
        return { ok: true, name: loc.name };
      } catch (e) {
        return { error: `lookup failed (${e.message}) — are you online?` };
      }
    }
    return { error: `unknown action ${action}` };
  },

  // Apple Calendar: refresh the list (also the first-time permission prompt,
  // attributed to this app) and toggle individual calendars on/off
  async 'POST /api/calendars'({ action, id }) {
    if (action === 'refresh') {
      await refreshAppleCal();
      if (appleCalState.available && !appleCalState.authorized)
        return { error: 'calendar access not granted — allow it in System Settings → Privacy → Calendars', appleCal: appleCalState };
      return { ok: true, appleCal: appleCalState };
    }
    if (action === 'enable' || action === 'disable' || action === 'toggle') {
      if (!id) return { error: 'missing calendar id' };
      const on = action === 'enable'
        ? true
        : action === 'disable'
        ? false
        : !appleCalState.calendars.find((c) => c.id === id)?.enabled; // toggle
      setCalendarEnabled(id, on);
      await refreshAppleCal();
      return { ok: true, appleCal: appleCalState };
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

    // live task-export calendar: every dated task (inbox + projects), generated
    // fresh each request so subscribers see edits on their next refresh
    if (req.method === 'GET' && (url.pathname === '/tasks.ics' || url.pathname === '/api/tasks.ics')) {
      const all = [];
      for (const name of [null, ...listProjects()])
        for (const t of loadTasks(name)) all.push({ ...t, project: name || 'inbox' });
      res.writeHead(200, {
        'content-type': 'text/calendar; charset=utf-8',
        'cache-control': 'no-cache',
        'content-disposition': 'inline; filename="gretchen-tasks.ics"',
      });
      return res.end(tasksToIcs(all));
    }

    // read-only Apple Calendar events for the visible range (enabled calendars)
    if (req.method === 'GET' && url.pathname === '/api/calendar-events') {
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || ''))
        return json(400, { error: 'start and end must be YYYY-MM-DD' });
      return json(200, await fetchEvents(start, end));
    }

    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      }
      const out = await route(body);
      return json(out.error ? 400 : 200, out);
    }

    if (req.method === 'GET') {
      const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
      if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        // no-cache: files are read fresh from disk, so the browser should always
        // revalidate and never run a stale app.js/style.css after an update
        res.writeHead(200, {
          'content-type': MIME[path.extname(file)] || 'application/octet-stream',
          'cache-control': 'no-cache',
        });
        return res.end(fs.readFileSync(file));
      }
    }
    json(404, { error: 'not found' });
  } catch (e) {
    json(500, { error: e.message });
  }
});

refreshOura(); // warm last night's sleep summary so the first /api/state has it

server.listen(PORT, () => {
  console.log(`✻ Gretchen — http://localhost:${PORT}`);
});
