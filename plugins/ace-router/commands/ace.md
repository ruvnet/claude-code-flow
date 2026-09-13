---
name: ace
description: Ask ACE anything — the main command bar for the Agentic Command Engine
argument-hint: "[natural language request]"
---

The primary ACE entry point. Routes any natural language request through intent detection, selects the right mode and Notion databases, and returns a structured response using the ACDC framework.

## Usage

```
/ace Plan my day
/ace Write a follow-up email to Thomas from CroNix
/ace Compare expanding CroNix to Munich vs staying focused on existing territory
/ace What are my active goals?
/ace Draft a LinkedIn post about our new cleaning service
```

## How it works

1. Detects intent from your request
2. Selects mode (task-execution, relationship, strategic-advisor, content-production, etc.)
3. Loads relevant Notion databases
4. Returns a structured, actionable response
5. Closes with a confidence rating and one next action

See `/ace-route [request]` to preview the routing decision without executing.
