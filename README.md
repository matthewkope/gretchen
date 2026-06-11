# ✻ Gretchen

The [Gretchen CLI](https://github.com/matthewkope/gretchen-cli) todo app as a
UI. Same features, same files: tasks are plain markdown in the
[Obsidian Tasks](https://publish.obsidian.md/tasks/) format under
`~/.gretchen/`, so the browser app and the terminal app are two views of the
same data — add a task here, see it in `gre`, and vice versa.

Zero dependencies, no build step: a small `node:http` server, three static
files, and the CLI's own data layer (`lib/store.js`, `lib/timer.js`).
See [PLAN.md](PLAN.md) for how it stays minimal.

## Run

```sh
git clone https://github.com/matthewkope/gretchen.git
cd gretchen
node server.js        # ✻ Gretchen — http://localhost:5277
```

`PORT=8080 node server.js` to pick another port.

## What's in the UI

- **Prompt** — type and press enter, same parser as the CLI:
  `ship report due friday #work` → `- [ ] ship report #work 📅 2026-06-12`.
  Date words (`due friday`, `@today`) convert to 📅 live as you type.
- **Pickers** — a suggestion strip above the prompt: `/` commands, dates
  after `@`/`due`, priorities (🔺⏫🔼🔽⏬) after a date lands, existing
  `#tags` with counts. ↑/↓ select, tab or click inserts.
- **Tasks** — checkbox toggles done (✅ date recorded); hover for tools:
  reorder ↑↓, nest ⇥/⇤ (sub-task blocks stay together), edit ✎,
  archive ⌫, delete ✕, and a move-to-project dropdown.
- **Sidebar** — inbox + projects (click to switch, + creates), tags with
  counts (click to filter), live stats.
- **Calendar** — month/week/day views of every project's due dates, with the
  CLI's keys: `m`/`w`/`d` pick a view (`tab` or `v` cycles, `enter` zooms in),
  `←`/`→` move a day, `↑`/`↓` a week, `shift+←/→` a whole period, `t` jumps
  to today, `esc` returns to tasks. Click a day to select it, double-click
  to open it.
- **Archive** — grouped year / month / week, newest first, one-click
  unarchive.
- **Time** — ▶ on any task starts a timer (⏹ in the top bar stops it; starting
  another task logs the first). Sessions append to `~/.gretchen/time.csv` in
  Toggl Track's import format; the time view shows the log and sets the
  import email.

Slash commands from the CLI still work in the prompt: `/cal`,
`/project <name>`, `/inbox`, `/move <name>`, `/file`, `/tag <name>`, `/all`,
`/sort <key>`, `/archive`, `/archived`, `/stats`, `/time`.

## Storage

Identical to the CLI — everything is editable by hand or in Obsidian:

- `~/.gretchen/tasks.md` — the inbox
- `~/.gretchen/projects/<name>.md` — one file per project
- `~/.gretchen/archive.md` — archive, grouped by year/month/week
- `~/.gretchen/time.csv` — time entries, Toggl-import-ready
