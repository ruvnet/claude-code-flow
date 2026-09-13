# ace-router — ACE Command Core

The central routing brain of the **Agentic Command Engine (ACE)**. Detects intent, selects the right mode and Notion databases, and returns structured, actionable responses — all from a single `/ace` command.

---

## Install

```
claude plugin install ace-router
```

---

## Skills

| Skill | Invoke | Purpose |
|---|---|---|
| `/ace` | `/ace [your request]` | Main command bar — routes anything |
| `/ace-route` | `/ace-route [request]` | Preview routing decision (no execution) |
| `/ace-brief` | `/ace-brief` | Daily briefing — tasks, blocks, goals, notes |
| `/ace-task` | `/ace-task [filter]` | Task list from Notion |

### `/ace` examples

```
/ace Plan my day
/ace Who should I follow up with this week?
/ace Write a follow-up email to Thomas
/ace Compare expanding CroNix to Munich vs staying focused
/ace What does my cash flow look like?
/ace Draft a LinkedIn post about our KKSG certification
/ace Research competitors offering industrial cleaning in Munich
```

### `/ace-task` filters

```
/ace-task today
/ace-task overdue
/ace-task project:CroNix
/ace-task all
```

---

## Routing Table

| Intent | Mode | Notion Databases |
|---|---|---|
| Plan day / priorities | task-execution | Tasks (27), Projects (28) |
| SOP / CroNix process | deep-doc | Knowledge (43) |
| Follow up / contacts | relationship | Contacts (30) |
| Summarize / brief | fast-ops | Tasks (27), Notes (29) |
| Strategy / decisions | strategic-advisor | Goals 2.0 (75), Projects (28) |
| Write / content / draft | content-production | Content (35) |
| Research / investigate | research | Knowledge (43) + WebSearch |
| Finance / budget | finance | Financials (36) |
| Schedule / time block | time-blocking | Time Blocking (128) |
| Life areas / personal | life-zones | Life Zones (34) |

---

## Notion Setup

This plugin requires the following Notion databases to be connected via the Notion MCP:

| Ref | Database |
|---|---|
| notion-27 | ⚡ Tasks |
| notion-28 | 🛠️ Projects |
| notion-75 | 🎯 Goals 2.0 |
| notion-34 | 💠 Life Zones |
| notion-128 | ⏭️ Time Blocking |
| notion-36 | 💶 Financials |
| notion-43 | 📚 Knowledge |
| notion-35 | 📢 Content |
| notion-29 | 🧻 Notes |
| notion-30 | 👤 Contacts |

Skills degrade gracefully if a database is unavailable — ACE will note the data gap and continue with available context.

---

## ACDC Framework

Every ACE response follows this pattern:

1. **Assess** — restate the request, identify intent
2. **Collaborate** — ask one question if ambiguous
3. **Draft** — load Notion context, generate output
4. **Certify** — close with confidence rating + one next action

---

## Version

v0.1.0 — MVP scope. Multi-model delegation (GPT, Gemini) planned for v0.2 via `ruflo-ruvllm`.

---

## Verification

```bash
bash plugins/ace-router/scripts/smoke.sh
```

Expected: 10 passed, 0 failed.
