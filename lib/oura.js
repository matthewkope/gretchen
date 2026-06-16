import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Oura Ring API v2. Auth token comes from $OURA_API_TOKEN or
// ~/.gretchen/oura-token (a personal access token, created at
// cloud.ouraring.com — read scope on sleep data is enough).
const TOKEN_FILE = path.join(os.homedir(), '.gretchen', 'oura-token');
const BASE = 'https://api.ouraring.com/v2/usercollection';

export const OURA_TOKEN_URL = 'https://cloud.ouraring.com/personal-access-tokens';

export function ouraToken() {
  if (process.env.OURA_API_TOKEN) return process.env.OURA_API_TOKEN.trim();
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function openOuraTokenPage() {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', OURA_TOKEN_URL] : [OURA_TOKEN_URL];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

export function saveOuraToken(token) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
}

export function clearOuraToken() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {}
}

async function api(route, token = ouraToken()) {
  if (!token) throw new Error('no token — /oura connects your ring');
  const res = await fetch(`${BASE}${route}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status}${detail ? ` ${detail.slice(0, 80)}` : ''}`);
  }
  return res.json();
}

// /oura setup: check a token against the API before saving it
export async function verifyOuraToken(token) {
  return api('/personal_info', token);
}

const isoDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Last night at a glance: daily sleep score, readiness score, hours slept,
// and Oura's ideal-bedtime window. Each piece can be null — scores sync late,
// and the bedtime guidance needs enough recent nights to exist at all.
export async function fetchSleepSummary() {
  const q = `?start_date=${isoDate(new Date(Date.now() - 6 * 86400000))}&end_date=${isoDate(new Date())}`;
  const [sleep, readiness, sessions, sleepTime] = await Promise.all([
    api(`/daily_sleep${q}`),
    api(`/daily_readiness${q}`),
    api(`/sleep${q}`),
    api(`/sleep_time${q}`).catch(() => ({ data: [] })), // optional — some accounts lack it
  ]);
  const latest = (rows) => (rows?.length ? rows[rows.length - 1] : null);
  const ds = latest(sleep.data);
  // pair the readiness score with the same morning as the sleep score
  const dr = sleep.data?.length
    ? readiness.data?.find((d) => d.day === ds.day) ?? latest(readiness.data)
    : latest(readiness.data);
  // actual time asleep comes from the long (overnight) sleep session
  const nights = (sessions.data || []).filter((s) => s.type === 'long_sleep');
  const night = latest(nights) || latest(sessions.data);
  // most recent day that carries an optimal_bedtime window
  const st = (sleepTime.data || []).filter((d) => d.optimal_bedtime).pop() || null;
  if (!ds && !dr && !night) throw new Error('no sleep data in the last week — has the ring synced?');
  return {
    day: ds?.day ?? night?.day ?? null,
    score: ds?.score ?? null,
    readiness: dr?.score ?? null,
    duration: night?.total_sleep_duration ?? null, // seconds asleep
    bedtime: st?.optimal_bedtime ?? null, // { start_offset, end_offset } seconds from midnight
  };
}

// seconds asleep → "7h 32m"
export function fmtSleepDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// bedtime offset (seconds relative to midnight, may be negative) → "10:45 PM"
export function fmtClockOffset(sec) {
  const mins = (((Math.round(sec / 60)) % 1440) + 1440) % 1440;
  const h24 = Math.floor(mins / 60);
  const m = String(mins % 60).padStart(2, '0');
  return `${((h24 + 11) % 12) + 1}:${m} ${h24 < 12 ? 'AM' : 'PM'}`;
}
