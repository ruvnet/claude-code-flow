# aperture-ui

React + Vite + Tailwind + shadcn-ui frontend for **Aperture**, the
polymorphic, vendor-neutral market workspace at
[`/aperture`](../aperture/). Forked from `v3/goal_ui` (kept the
component library and theme, dropped the Supabase + research-specific
plumbing).

## Run

```bash
# from the repo root
cd aperture-ui
pnpm install            # or: npm install
pnpm dev                # http://localhost:8080/aperture
```

## Wire up the WASM artifact

The page mounts a wasm-bindgen artifact built from
[`aperture/crates/aperture-wasm`](../aperture/crates/aperture-wasm). The
SPA expects it at `public/aperture/aperture_wasm.js`:

```bash
# from the repo root
plugins/ruflo-aperture/scripts/build-wasm.sh
cp -r aperture/crates/aperture-wasm/pkg aperture-ui/public/aperture
```

If the artifact is missing the page renders a friendly notice with the
build command, so the SPA is usable for development without it.

## Layout

| Path | Role |
|---|---|
| `src/App.tsx` | router; redirects `/` → `/aperture` |
| `src/pages/Aperture.tsx` | the workspace page (mount + envelope wiring + grid) |
| `src/components/aperture/ApertureGrid.tsx` | 4-column responsive grid over `PANE_ORDER` |
| `src/components/aperture/Pane.tsx` | single pane (shadcn `Card` + `ScrollArea`) |
| `src/components/aperture/CommandBar.tsx` | `SYMBOL VERB GO` input + history |
| `src/lib/aperture/types.ts` | `Pane`, `Envelope`, `ViewLine`, `PANE_ORDER` |
| `src/lib/aperture/wasm.ts` | lazy artifact loader |
| `src/components/ui/*` | inherited shadcn-ui component library |

## Differences from `v3/goal_ui`

| Removed | Reason |
|---|---|
| `supabase/`, `src/integrations/supabase/` | Aperture has no Supabase backend |
| Widget build mode (`widget.tsx`, widget scripts in `package.json`, widget mode in `vite.config.ts`) | embeddable widget out of scope |
| Research components (`AgentStep`, `GoalInput`, `Research*`, `agents/*`) | not market-workspace concepts |
| `src/lib/goapPlanner.ts` | GOAP planner is research-specific |
| `src/pages/{Demo,Agents,Index}.tsx` | replaced by a single `Aperture` page |
| `@supabase/supabase-js`, `reactflow` | dropped along with their consumers |

The shadcn-ui component set, Tailwind config, theming, and TanStack
Query are all kept verbatim.

## Wire format

The page communicates with the swarm bus through `window.postMessage`
using the `Envelope` shape from
[`aperture/crates/aperture-swarm/src/envelope.rs`](../aperture/crates/aperture-swarm/src/envelope.rs),
which is field-identical to
`v3/@claude-flow/swarm/src/types.ts:Message`.
