// Read-only Apple Calendar access for the calendar view. The native EventKit
// reader is `calbridge` (macos/calbridge.swift); this module locates it,
// shells out to it, and tracks which calendars the user has toggled off.
// Everything is display-only — nothing here ever writes to Calendar.
//
// The helper binary and the per-calendar prefs live under ~/.gretchen so the
// web app, the Mac app, and the CLI all share them.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_HOME = path.join(os.homedir(), '.gretchen', 'bin', 'calbridge');
const PREFS_FILE = path.join(os.homedir(), '.gretchen', 'calendars.json');

// ── locating / building the helper ──────────────────────────────────────
let helperChecked = false;
let helperBin = null;

function findHelper() {
  if (process.platform !== 'darwin') return null;
  const candidates = [
    HELPER_HOME,
    // inside the .app: Resources/app/lib/applecal.js → Resources/calbridge
    path.join(HERE, '..', '..', 'calbridge'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return null;
}

// dev convenience: if the binary isn't there yet but swiftc and the source are,
// build it once into ~/.gretchen/bin (best effort; silent on failure)
function tryCompile() {
  if (process.platform !== 'darwin') return null;
  const src = path.join(HERE, '..', 'macos', 'calbridge.swift');
  if (!fs.existsSync(src)) return null;
  try {
    fs.mkdirSync(path.dirname(HELPER_HOME), { recursive: true });
    execFileSync('swiftc', ['-O', src, '-o', HELPER_HOME, '-framework', 'EventKit', '-framework', 'Foundation'], { stdio: 'ignore' });
    try { execFileSync('codesign', ['--force', '-s', '-', HELPER_HOME], { stdio: 'ignore' }); } catch {}
    return HELPER_HOME;
  } catch {
    return null;
  }
}

function helper() {
  if (!helperChecked) {
    helperChecked = true;
    helperBin = findHelper() || tryCompile();
  }
  return helperBin;
}

export function appleCalAvailable() {
  return !!helper();
}

// run calbridge with a hard timeout; resolves { code, out } (out is raw stdout)
function run(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const bin = helper();
    if (!bin) return resolve({ code: -1, out: '' });
    let out = '';
    const p = spawn(bin, args);
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve({ code: -1, out }); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

function parse(out) {
  try { return JSON.parse(out || 'null'); } catch { return null; }
}

// ── per-calendar visibility (id → false means hidden; absent = shown) ────
export function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; }
}

function savePrefs(prefs) {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  fs.writeFileSync(PREFS_FILE, `${JSON.stringify(prefs, null, 2)}\n`);
}

export function setCalendarEnabled(id, on) {
  const prefs = loadPrefs();
  if (on) delete prefs[id];
  else prefs[id] = false;
  savePrefs(prefs);
  return prefs;
}

const isEnabled = (prefs, id) => prefs[id] !== false;

// ── queries ──────────────────────────────────────────────────────────────
// { available, authorized, calendars:[{id,title,colorHex,type,source,enabled}] }
export async function listCalendars() {
  if (!helper()) return { available: false, authorized: false, calendars: [] };
  const { code, out } = await run(['list']);
  const data = parse(out);
  if (data && data.error === 'unauthorized') return { available: true, authorized: false, calendars: [] };
  if (!Array.isArray(data)) return { available: true, authorized: false, calendars: [], error: code === -1 ? 'helper timed out' : 'helper error' };
  const prefs = loadPrefs();
  return {
    available: true,
    authorized: true,
    calendars: data.map((c) => ({
      id: c.id, title: c.title, colorHex: c.colorHex, type: c.type, source: c.source,
      enabled: isEnabled(prefs, c.id),
    })),
  };
}

// events for [start, end) (YYYY-MM-DD), filtered to enabled calendars. Each
// event gets a `date` (local YYYY-MM-DD of its start) for the day-grid.
export async function fetchEvents(start, end) {
  if (!helper()) return { available: false, authorized: false, events: [] };
  const { out } = await run(['events', start, end]);
  const data = parse(out);
  if (data && data.error === 'unauthorized') return { available: true, authorized: false, events: [] };
  if (!Array.isArray(data)) return { available: true, authorized: false, events: [] };
  const prefs = loadPrefs();
  return {
    available: true,
    authorized: true,
    events: data
      .filter((e) => isEnabled(prefs, e.calId))
      .map((e) => ({
        calId: e.calId, calTitle: e.calTitle, colorHex: e.colorHex,
        title: e.title, start: e.start, end: e.end, allDay: e.allDay,
        location: e.location, date: (e.start || '').slice(0, 10),
      })),
  };
}
