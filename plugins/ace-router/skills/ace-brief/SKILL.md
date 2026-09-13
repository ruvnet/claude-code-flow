---
name: ace-brief
description: Generate a structured daily briefing — pulls open tasks, time blocks, active goals, and recent notes from Notion
argument-hint: ""
allowed-tools: mcp__d6758f4e-3bb9-4fb8-b1cd-c32625540f6d__notion-query-database-view mcp__d6758f4e-3bb9-4fb8-b1cd-c32625540f6d__notion-fetch
---

Generate ACE's daily briefing. Pull live data from Notion and return a structured morning summary.

## Step 1 — Fetch Data

Run these queries in parallel:

1. `notion-query-database-view` on **notion-27** (Tasks) — filter: status is not Done, due date is today or overdue
2. `notion-query-database-view` on **notion-128** (Time Blocking) — filter: date is today
3. `notion-query-database-view` on **notion-75** (Goals 2.0) — filter: status is active
4. `notion-fetch` on **notion-29** (Notes) — most recent 3 entries

If any database is unavailable, mark that section `[unavailable]` and continue.

## Step 2 — Assemble Brief

Output this exact structure:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ACE DAILY BRIEF — [today's date]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRIORITIES (top 3 from Tasks)
  1. [task] — [due date]
  2. [task] — [due date]
  3. [task] — [due date]

TODAY'S TASKS  ← notion-27
  • [task] | [status] | [project]
  (list all due today + overdue)

TIME BLOCKS TODAY  ← notion-128
  [time] — [block title]
  (or: No blocks scheduled)

ACTIVE GOALS PULSE  ← notion-75
  • [goal] | [progress/status]

RECENT NOTES  ← notion-29
  • [note title] — [date]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Focus: [pick the single most important item from the brief]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Rules

- Maximum 3 priorities — choose by due date and importance.
- Never fabricate tasks, goals, or notes. Only include what Notion returns.
- If Tasks returns nothing due today, show the next 3 upcoming.
- Keep output scannable — no paragraphs.
