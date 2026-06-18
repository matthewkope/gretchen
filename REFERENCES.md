# References & Inspiration

This is the running list of projects Gretchen draws on for design and behavior.

**Naming convention:** when a request or comment says **"Obsidian _X_"** (e.g.
"Obsidian Kanban", "Obsidian Minimal", "Obsidian Tasks"), it refers to the
matching project below — that repo, plugin, theme, or docs site, not Obsidian
in general. Same idea for the apps in the Inspiration section: "like Notion
Calendar" / "like Morgen" / "like Super Productivity" point at these specific
products.

This file is reference context only. Listing something here does **not** mean
we've adopted it — it's the source we look at when we do.

---

## Obsidian (plugins, themes, docs)

### Obsidian Kanban
- **What:** A markdown-backed Kanban board plugin for Obsidian (boards are plain
  `.md` files; lists are headings, cards are list items).
- **Link:** https://github.com/obsidian-community/obsidian-kanban
- **We reference it for:** the kanban board — board/column/card model, card
  layout, drag-and-drop, and keeping the board as readable markdown.

### Obsidian Minimal
- **What:** Steph Ango's (kepano) Minimal theme — a clean, restrained,
  highly-customizable Obsidian theme.
- **Link:** https://github.com/kepano/obsidian-minimal
- **We reference it for:** overall visual style — typography (the "minimal"
  sans-serif font option already uses its stack), spacing, color restraint, and
  light/dark treatment.

### Obsidian Tasks
- **What:** The Obsidian Tasks plugin and its documentation — task syntax,
  emoji metadata (📅 due, ✅ done, 🔺/⏫/🔼 priority), querying, and recurrence.
- **Link:** https://publish.obsidian.md/tasks/Introduction
- **We reference it for:** the task data format itself. Gretchen's tasks are
  stored in this exact emoji format under `~/.gretchen/`, so this is the source
  of truth for how a task line is written and parsed.

---

## App inspiration

### Calendars

#### Notion Calendar
- **What:** Notion's calendar app (formerly Cron) — fast keyboard-driven
  calendar with scheduling and time-zone handling.
- **Link:** https://www.notion.com/product/calendar
- **We reference it for:** calendar view interactions, event rendering, and
  quick scheduling feel.

#### Morgen
- **What:** A cross-platform calendar + task/scheduling app that unifies
  multiple calendars and to-do sources with planning/time-blocking.
- **Link:** https://www.morgen.so/
- **We reference it for:** merging calendar events with tasks, time-blocking,
  and planning-oriented calendar UX.

### Productivity

#### Super Productivity
- **What:** Open-source productivity app with task management, built-in time
  tracking, and project organization.
- **Links:**
  - App: https://app.super-productivity.com/
  - Download: https://super-productivity.com/download/
- **We reference it for:** time tracking and the project/task workflow — how
  tracked time, tasks, and projects tie together (relevant to the Toggl/time
  features and the home "This week" widget).
