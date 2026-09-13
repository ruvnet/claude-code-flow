---
name: ace-task
description: Pull and display tasks from Notion with optional filters — today, overdue, project name, or all
argument-hint: "[today|overdue|project:<name>|all]"
allowed-tools: mcp__d6758f4e-3bb9-4fb8-b1cd-c32625540f6d__notion-query-database-view mcp__d6758f4e-3bb9-4fb8-b1cd-c32625540f6d__notion-fetch
---

Query Notion Tasks (notion-27) and return a clean, filtered task list.

## Step 1 — Parse Filter

Read the argument provided:

- `today` → tasks with due date = today
- `overdue` → tasks with due date < today and status ≠ Done
- `project:<name>` → tasks linked to a project matching that name
- `all` → all open tasks (status ≠ Done), sorted by due date
- *(no argument)* → default to `today`

## Step 2 — Query Notion

Use `notion-query-database-view` on **notion-27** (Tasks) with the appropriate filter.

If `project:<name>` is specified, also fetch from **notion-28** (Projects) to resolve the project link.

## Step 3 — Output

```
TASKS — [filter applied] — [count] items

OVERDUE  (only if filter is 'all' or 'overdue')
  • [task title] | Due: [date] | Project: [project] | Status: [status]

TODAY
  • [task title] | Due: [date] | Project: [project] | Status: [status]

UPCOMING  (only if filter is 'all')
  • [task title] | Due: [date] | Project: [project] | Status: [status]
```

## Rules

- Never show Done tasks.
- Flag overdue items at the top regardless of filter.
- If no tasks match the filter, output: `No tasks found for filter: [filter]`
- Keep rows scannable — no prose.
