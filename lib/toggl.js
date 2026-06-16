import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Toggl Track API v9. Auth token comes from $TOGGL_API_TOKEN or
// ~/.gretchen/toggl-token (the token is on https://track.toggl.com/profile).
const TOKEN_FILE = path.join(os.homedir(), '.gretchen', 'toggl-token');
const MAP_FILE = path.join(os.homedir(), '.gretchen', 'toggl-map.json');
const BASE = 'https://api.track.toggl.com/api/v9';

// manual routing overrides: gretchen project/tag name → Toggl project name.
// Keys are stored normalized (no leading #, lowercase).
export function mapKey(s) {
  return s?.replace(/^#/, '').toLowerCase();
}

export function loadMap() {
  try {
    return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveMap(map) {
  fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
  fs.writeFileSync(MAP_FILE, `${JSON.stringify(map, null, 2)}\n`);
}

export function togglToken() {
  if (process.env.TOGGL_API_TOKEN) return process.env.TOGGL_API_TOKEN.trim();
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// the profile page where the API token lives, at the bottom
export const TOKEN_URL = 'https://track.toggl.com/profile';

export function openTokenPage() {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', TOKEN_URL] : [TOKEN_URL];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

// /toggl setup: check a token against the API before saving it
export async function verifyToken(token) {
  const res = await fetch(`${BASE}/me`, {
    headers: { Authorization: `Basic ${Buffer.from(`${token}:api_token`).toString('base64')}` },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export function saveToken(token) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  cache = null;
}

export function clearToken() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {}
  cache = null;
}

async function api(method, route, body) {
  const token = togglToken();
  if (!token) throw new Error('no token — set TOGGL_API_TOKEN or write it to ~/.gretchen/toggl-token');
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${token}:api_token`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status}${detail ? ` ${detail.slice(0, 80)}` : ''}`);
  }
  return res.status === 204 ? null : res.json();
}

// workspace id + project list, fetched once per session
let cache = null;
async function context() {
  if (!cache) {
    const me = await api('GET', '/me');
    const projects = (await api('GET', '/me/projects')) || [];
    cache = { workspaceId: me.default_workspace_id, projects };
  }
  return cache;
}

// Match a #tag to an existing Toggl project by name (case-insensitive).
// Tags never create their own projects — unmatched entries fall back to "Untitled".
async function findProject(tag) {
  if (!tag) return null;
  const name = tag.replace(/^#/, '').toLowerCase();
  const { projects } = await context();
  return projects.find((p) => p.name.toLowerCase() === name) || null;
}

// look up an existing Toggl project by exact name (for validating /toggl map)
export async function togglProjectByName(name) {
  const { projects } = await context();
  return projects.find((p) => p.name.toLowerCase() === name.toLowerCase()) || null;
}

// find a Toggl project by name, creating it when it doesn't exist yet
async function findOrCreateProject(name) {
  const ctx = await context();
  let p = ctx.projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!p) {
    p = await api('POST', `/workspaces/${ctx.workspaceId}/projects`, { name, active: true });
    ctx.projects.push(p);
  }
  return p;
}

// Routing, in priority order: a /toggl map override for the gretchen project
// or tag wins; then the gretchen project name (its Toggl counterpart is
// created if missing); then the #tag (match-only); then "Untitled".
export async function startEntry({ description, project: projectName, tag }) {
  const { workspaceId } = await context();
  const map = loadMap();
  const mapped = map[mapKey(projectName)] ?? map[mapKey(tag)];
  const project = mapped
    ? await findOrCreateProject(mapped)
    : projectName
    ? await findOrCreateProject(projectName)
    : (await findProject(tag)) || (await findOrCreateProject('Untitled'));
  const entry = await api('POST', `/workspaces/${workspaceId}/time_entries`, {
    description,
    project_id: project.id,
    start: new Date().toISOString(),
    duration: -1, // running entry; Toggl stops any previously running one
    created_with: 'gretchen',
    workspace_id: workspaceId,
  });
  return { entry, project };
}

export async function stopEntry(entryId) {
  const { workspaceId } = await context();
  return api('PATCH', `/workspaces/${workspaceId}/time_entries/${entryId}/stop`);
}
