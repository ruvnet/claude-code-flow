---
name: ace-route
description: Preview the ACE routing decision for a request without executing it
argument-hint: "[natural language request]"
---

Shows how ACE would route a given request — which intent category, mode, agent, model, and Notion databases would be used — without actually fetching data or generating a response.

## Usage

```
/ace-route Plan my day
/ace-route Who should I follow up with this week?
/ace-route Write an SOP for the CroNix onboarding process
```

## Output

Returns a routing decision block:

```
ACE ROUTING DECISION
──────────────────────────────
Request:   [request]
Intent:    [intent category]
Mode:      [mode]
Agent:     command-agent
Model:     claude-sonnet
Databases: [notion-XX list]
Actions:   [MCP tools]
──────────────────────────────
Confidence: High / Medium / Low
Note: [any ambiguity]
```

Useful during development and when debugging unexpected ACE behaviour.
