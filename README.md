# ✻ Gretchen

The [Gretchen CLI](https://github.com/matthewkope/gretchen-cli) todo app as a
UI. Same features, same files: tasks are plain markdown in the
[Obsidian Tasks](https://publish.obsidian.md/tasks/) format under
`~/.gretchen/`, so the browser app and the terminal app are two views of the
same data — add a task here, see it in `gre`, and vice versa.

Zero dependencies, no build step: a small `node:http` server, three static
files, and the CLI's own data layer (`lib/store.js`, `lib/timer.js`,
`lib/toggl.js`, `lib/oura.js`, `lib/sun.js`). See [PLAN.md](PLAN.md) for how it
stays minimal.

## Run

```sh
git clone https://github.com/matthewkope/gretchen.git
cd gretchen
node server.js        # ✻ Gretchen — http://localhost:5277
```

`PORT=8080 node server.js` to pick another port.

### Always-on local server

To keep the web app permanently available at http://localhost:5277 — running
in the background, started at login, restarted if it ever crashes:

```sh
macos/install-server.sh              # install + start (PORT=8080 to override)
macos/install-server.sh --uninstall  # stop and remove it
```

This installs a launchd LaunchAgent
(`~/Library/LaunchAgents/com.matthewkope.gretchen-web.plist`); logs go to
`~/.gretchen/server.log`. It's independent of the Mac app (which uses its own
port, 52770), so you can run either or both.

### As a Mac app (dock icon)

```sh
macos/build.sh --install   # builds Gretchen.app and copies it to /Applications
```

Launch **Gretchen** from Spotlight or /Applications, then right-click its dock
icon → Options → *Keep in Dock*. The app is a thin native shell: a window
holding the exact same web UI, with the server started and stopped for you
(on port 52770, so it never clashes with a dev server).

The bundle **symlinks** to the repo rather than copying it, so the app always
runs the live web app — edit `public/` and press **⌘R** to see it, or edit
`server.js`/`lib/` and relaunch; no rebuild needed. Rebuild only when you
change the Swift shell (`macos/main.swift`) or move/rename the repo (which
breaks the links). Requires Xcode's command line tools (`swiftc`) to build,
and node at runtime.

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
- **Toggl Track sync** — the time view's Toggl panel connects your account
  (paste the API token from track.toggl.com/profile). Once connected, ▶
  entries are *also* pushed to Toggl live — named after the task, filed under
  the Toggl project matching the current project (or first `#tag`), created if
  missing. Add routing overrides (`project or #tag → Toggl project`) right in
  the panel. The local CSV is still written either way; disconnect removes the
  token. This is the same `lib/toggl.js` the CLI uses, over the shared
  `~/.gretchen/toggl-token`, so connecting in either app connects both.
- **Sleep & sun (sidebar “today”)** — the sidebar shows last night's Oura sleep
  and your sunrise/sunset, mirroring the CLI's inbox header. Connect Oura by
  pasting a personal access token (cloud.ouraring.com) — it shows the sleep
  score, readiness, time slept, and tonight's ideal-bedtime window, refreshed
  on launch (hover for ↻ refresh / × disconnect). Set a city for sunrise/sunset
  (geocoded via Open-Meteo, no key; hover for ✎ change / × clear). Both read
  the same `~/.gretchen` files the CLI uses, so setup carries across.

Slash commands from the CLI still work in the prompt: `/cal`,
`/project <name>`, `/inbox`, `/move <name>`, `/file`, `/tag <name>`, `/all`,
`/sort <key>`, `/archive`, `/archived`, `/stats`, `/time`, `/toggl`, `/oura`,
`/location <city>`.

## Storage

Identical to the CLI — everything is editable by hand or in Obsidian:

- `~/.gretchen/tasks.md` — the inbox
- `~/.gretchen/projects/<name>.md` — one file per project
- `~/.gretchen/archive.md` — archive, grouped by year/month/week
- `~/.gretchen/time.csv` — time entries, Toggl-import-ready
- `~/.gretchen/toggl-token` — Toggl API token, if connected (live sync)
- `~/.gretchen/toggl-map.json` — project/#tag → Toggl project routing
- `~/.gretchen/oura-token` — Oura personal access token, if connected
- `~/.gretchen/location.json` — city + coords for sunrise/sunset
