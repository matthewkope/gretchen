# Gretchen — plan

A todo app with the same functions as [Gretchen CLI](https://github.com/matthewkope/gretchen-cli),
as a UI. The plan below is how it stays **minimal** without giving up
**functionality**.

## The one big idea: share the CLI's data layer

The CLI already has a complete, tested engine — `store.js` parses and writes
Obsidian-Tasks markdown, resolves date words, handles priorities, sub-task
blocks, projects, tags, sorting, and the archive; `timer.js` writes the
Toggl-importable time CSV. Both are pure Node with zero UI code, so this app
copies them verbatim into `lib/` and builds nothing twice.

It also means **both apps are views over the same files**: `~/.gretchen/*.md`
and `time.csv`. Add a task in the browser, see it in `gre`; archive in the
terminal, the web list updates. The UI app introduces no second database, no
sync, no migration.

## Minimal stack — what we deliberately don't add

| Could add            | Instead                                            |
| -------------------- | -------------------------------------------------- |
| React/Vue + bundler  | one vanilla JS file, `<template>`-free DOM building |
| Express/Fastify      | `node:http`, ~15 routes in one `server.js`         |
| CSS framework        | one `style.css`, Claude-Code dark palette          |
| A database           | the markdown files the CLI already uses            |
| Electron/Tauri       | a localhost server + the browser you have          |
| npm dependencies     | **zero** — `npm install` is a no-op                |

No build step: `gretchen-app` runs `node server.js` and opens
`http://localhost:5277`. The whole app is four files (`server.js`,
`public/index.html`, `public/style.css`, `public/app.js`) plus the two
borrowed `lib/` modules.

## Functional parity map

Every CLI function, translated to UI affordances instead of key chords:

| CLI                        | UI                                                |
| -------------------------- | ------------------------------------------------- |
| type + enter (parseInput)  | same prompt box, same parser, server-side         |
| `@`/`due` date picker      | inline suggestion strip under the prompt          |
| priority picker            | same strip after a date lands                     |
| `#` tag picker             | same strip; sidebar tag list with counts          |
| enter toggles done         | checkbox click                                    |
| ctrl+e edit                | ✎ button loads task into the prompt               |
| ctrl+d delete              | ✕ button (with its sub-task block)                |
| ctrl+space archive         | ⌫ archive button (block-aware)                    |
| shift+↑/↓ reorder          | ↑/↓ buttons (block-aware)                         |
| tab nest / un-nest         | ⇥ indent / outdent buttons                        |
| /project, /inbox, ctrl+p   | sidebar: inbox + projects, click to switch        |
| /move                      | per-task project dropdown                         |
| /file sweep                | "file tagged" button                              |
| /tag filter, /all          | click a tag chip; "all" clears                    |
| /sort key                  | sort dropdown (priority/due/tag/description/status) |
| /archive, /archived, ctrl+u| archive view tab + unarchive buttons              |
| /cal (month/week/day)      | calendar tab, month grid with due tasks           |
| /stats                     | stats line in the footer                          |
| ctrl+t timer, /time        | ▶/⏹ per task, live elapsed, time view of the CSV  |
| /exit                      | close the tab; ctrl+c stops the server            |

Slash commands still work in the prompt (`/project x`, `/archive`, …) for
muscle-memory parity, but every one has a clickable equivalent.

Deferred (CLI-only for now): live Toggl push — the CSV import path covers the
need; a settings page for tokens is the first thing to add later if wanted.

## Server shape

`server.js`: static files + JSON API. All state lives on disk; every mutation
re-reads, mutates, and re-writes via `lib/store.js`, so concurrent CLI use is
safe (same semantics as two CLI instances).

- `GET  /api/state?project=&tag=` — tasks (+ all-projects inbox view), projects, tags, stats
- `POST /api/tasks` — parse input text, add (or run a slash command)
- `POST /api/tasks/:i/toggle|archive|delete|move|indent|reorder|edit`
- `GET  /api/archive`, `POST /api/archive/restore`
- `GET  /api/calendar?month=`
- `GET  /api/time`, `POST /api/time/start|stop`, `/api/time/email`
- `GET  /api/suggest?input=` — date/tag/priority/command suggestions for the strip

## Order of work

1. Scaffold + repo (this commit)
2. `server.js` + API, verified with curl
3. UI: board → sidebar/projects → pickers → archive/calendar/time views
4. Browser test pass, README, push
