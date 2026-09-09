import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApertureGrid } from "@/components/aperture/ApertureGrid";
import { CommandBar } from "@/components/aperture/CommandBar";
import { ARTIFACT_BUILD_HINT, loadAperture } from "@/lib/aperture/wasm";
import {
  type ApertureApp,
  type Envelope,
  type ExecuteResult,
  type Pane,
  type ViewLine,
  PANE_ORDER,
} from "@/lib/aperture/types";

type Status = "idle" | "loading" | "ready" | "missing";
const PANE_LIMIT = 100;

// Commands run once on load so the workspace opens populated instead of all
// "(no data — try …)" placeholders. Each is just a normal `App.execute`, so
// the data comes from the same path a user-typed command would.
const SEED_COMMANDS = [
  "MACRO GO",
  "YIELDS GO",
  "FX EUR GO",
  "MOVERS GO",
  "SPX MEMBERS GO",
  "AAPL DESC GO",
  "AAPL CHART 6M GO",
  "AAPL NEWS GO",
] as const;

const emptyPanes = (): Record<Pane, string[]> => {
  const out = {} as Record<Pane, string[]>;
  for (const p of PANE_ORDER) out[p.id] = [];
  out.system = [];
  return out;
};

function looksLikeEnvelope(v: unknown): v is Envelope {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.type === "string" &&
    typeof o.from === "string" &&
    typeof o.to === "string" &&
    "payload" in o
  );
}

export default function Aperture() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [panes, setPanes] = useState<Record<Pane, string[]>>(emptyPanes);
  const [log, setLog] = useState<string[]>([
    "Aperture v0.1 — type `HELP GO`",
  ]);
  const [history, setHistory] = useState<string[]>([]);
  const appRef = useRef<ApertureApp | null>(null);

  // Apply a batch of view lines. The `system` pane is a running log
  // (append); every other pane shows the latest result for its verb, so a
  // re-run (or the demo seed) replaces its contents instead of stacking
  // ever-growing lines.
  const pushViews = useCallback((views: ViewLine[]) => {
    if (views.length === 0) return;
    const byPane = new Map<Pane, string[]>();
    for (const v of views) {
      const arr = byPane.get(v.pane);
      if (arr) arr.push(v.text);
      else byPane.set(v.pane, [v.text]);
    }
    setPanes((prev) => {
      const next = { ...prev };
      for (const [pane, lines] of byPane) {
        next[pane] =
          pane === "system"
            ? [...prev.system, ...lines].slice(-PANE_LIMIT)
            : lines.slice(-PANE_LIMIT);
      }
      return next;
    });
    const sysLines = byPane.get("system");
    if (sysLines) setLog((l) => [...l, ...sysLines]);
  }, []);

  // Load the wasm-pack artifact once on mount, then seed the workspace.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    loadAperture()
      .then(({ app }) => {
        if (cancelled) return;
        appRef.current = app;
        setStatus("ready");
        // Populate panes with a demo snapshot so the workspace isn't blank.
        for (const cmd of SEED_COMMANDS) {
          try {
            const result = app.execute(cmd) as ExecuteResult;
            if ("ok" in result && Array.isArray(result.ok.views)) {
              pushViews(result.ok.views);
            }
          } catch {
            /* a bad seed command shouldn't break load */
          }
        }
        setLog((l) => [...l, "(demo snapshot loaded — type your own SYMBOL VERB GO)"]);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus("missing");
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // `pushViews` is stable (useCallback); intentional one-shot effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for inbound envelopes posted on `window` by the swarm-bus relay.
  // Reject anything that isn't from this origin or this window — guards
  // against iframes / popups / extensions trying to drive `handle_inbound`.
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      if (ev.source !== window) return;
      const data = ev.data;
      if (!looksLikeEnvelope(data)) return;
      if ((data as Envelope).from === "aperture:cmdbar") return;
      const app = appRef.current;
      if (!app) return;
      try {
        const out = app.handle_inbound(JSON.stringify(data));
        if (Array.isArray(out)) pushViews(out as ViewLine[]);
      } catch (e) {
        setLog((l) => [
          ...l,
          `inbound error: ${e instanceof Error ? e.message : String(e)}`,
        ]);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [pushViews]);

  const onSubmit = useCallback(
    (line: string) => {
      const app = appRef.current;
      if (!app) return;
      setLog((l) => [...l, `> ${line}`]);
      setHistory((h) => (h[h.length - 1] === line ? h : [...h, line]));
      try {
        const result = app.execute(line) as ExecuteResult;
        if ("err" in result) {
          setLog((l) => [...l, `error: ${result.err}`]);
        } else {
          if (Array.isArray(result.ok.views)) pushViews(result.ok.views);
          if (result.ok.outbound) {
            // Pin the target origin so embedders / popups can't read
            // outbound envelopes (which include ORDER + EXPORT payloads).
            window.postMessage(result.ok.outbound, window.location.origin);
          }
        }
      } catch (e) {
        setLog((l) => [
          ...l,
          `error: ${e instanceof Error ? e.message : String(e)}`,
        ]);
      }
    },
    [pushViews],
  );

  const statusColor = useMemo(
    () =>
      status === "ready"
        ? "text-emerald-400"
        : status === "loading"
          ? "text-amber-400"
          : status === "missing"
            ? "text-red-400"
            : "text-zinc-500",
    [status],
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 flex flex-col">
      <header className="flex items-baseline gap-3 border-b border-zinc-800 px-4 py-2">
        <strong className="text-zinc-50 tracking-wider">APERTURE</strong>
        <span className="text-xs text-zinc-500">
          polymorphic market workspace · pane = swarm agent · 26 panes
        </span>
        <span className={`ml-auto text-xs ${statusColor}`}>{status}</span>
      </header>

      {status === "missing" && (
        <section className="border-b border-amber-700/40 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">
          <p className="font-medium">Aperture WASM artifact not found.</p>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-amber-100/80">
            {ARTIFACT_BUILD_HINT}
          </pre>
          {error && (
            <pre className="mt-1 font-mono text-[11px] text-red-300">
              {error}
            </pre>
          )}
        </section>
      )}

      <main id="aperture-mount" className="flex-1 overflow-y-auto p-2">
        <ApertureGrid panes={panes} />
      </main>

      <section className="max-h-32 overflow-y-auto border-t border-zinc-800 bg-zinc-950/60 px-4 py-2 font-mono text-[11px] text-zinc-400">
        {log.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </section>

      <CommandBar
        onSubmit={onSubmit}
        history={history}
        disabled={status !== "ready"}
      />
    </div>
  );
}
