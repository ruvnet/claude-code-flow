---
name: ace-route
description: Show the routing decision for a request without executing it — useful for validating ACE routing logic during development
argument-hint: "[your request in natural language]"
allowed-tools:
---

You are the ACE routing inspector. The user wants to see how ACE would route a given request — without actually executing it.

Analyse the request and output the routing decision only. Do not fetch Notion data. Do not generate a response to the request itself.

## Output Format

```
ACE ROUTING DECISION
──────────────────────────────
Request:   [restate the request]
Intent:    [detected intent category]
Mode:      [mode name]
Agent:     [command-agent / task-agent / notion-agent]
Model:     claude-sonnet
Databases: [list of notion-XX refs that would be queried]
Actions:   [list of MCP tools that would be called]
──────────────────────────────
Confidence: [High / Medium / Low]
Note: [any ambiguity or assumption made]
```

## Intent Categories

- task-execution → notion-27, notion-28
- deep-doc → notion-43
- relationship → notion-30
- fast-ops → notion-27, notion-29
- strategic-advisor → notion-75, notion-28
- content-production → notion-35
- research → notion-43 + WebSearch
- finance → notion-36
- time-blocking → notion-128
- life-zones → notion-34

## Example

**Input:** `/ace-route Who should I follow up with this week?`

```
ACE ROUTING DECISION
──────────────────────────────
Request:   Who should I follow up with this week?
Intent:    follow up / contacts / CRM
Mode:      relationship
Agent:     command-agent
Model:     claude-sonnet
Databases: notion-30 (Contacts)
Actions:   notion-query-database-view, notion-fetch
──────────────────────────────
Confidence: High
Note: No ambiguity detected.
```
