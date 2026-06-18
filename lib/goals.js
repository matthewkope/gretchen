import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The home page's "goals" widget: up to 5 short bullet points, stored as a
// JSON array of strings in ~/.gretchen/goals.json. App-only (the CLI has no
// counterpart) — a tiny, self-contained store like time-email.
const GOALS_FILE = path.join(os.homedir(), '.gretchen', 'goals.json');
const MAX_GOALS = 5;

export function loadGoals() {
  try {
    const data = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.map((g) => String(g)).filter(Boolean).slice(0, MAX_GOALS);
  } catch {
    return [];
  }
}

// Persist the list, normalised: strings only, trimmed, blanks dropped, max 5.
export function saveGoals(goals) {
  const clean = (Array.isArray(goals) ? goals : [])
    .map((g) => String(g ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_GOALS);
  fs.mkdirSync(path.dirname(GOALS_FILE), { recursive: true });
  fs.writeFileSync(GOALS_FILE, `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}
