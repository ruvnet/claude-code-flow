// Mirrors the wire format defined in
// `aperture/crates/aperture-swarm/src/envelope.rs` (which itself mirrors
// `v3/@claude-flow/swarm/src/types.ts:Message`).

export type Pane =
  | "quote" | "chart" | "watch" | "oracle"
  | "news" | "macro" | "yields" | "fx"
  | "options" | "insider" | "financials" | "crypto"
  | "risk" | "corpact" | "inbox" | "export"
  | "earnings" | "movers" | "screen" | "members"
  | "ivol" | "tech" | "corr" | "filings"
  | "order" | "sentiment"
  | "system";

export interface ViewLine {
  pane: Pane;
  text: string;
}

export interface Envelope {
  id: string;
  type: string;
  from: string;
  to: string;
  payload: unknown;
  timestamp: string;
  priority: string;
  requiresAck: boolean;
  ttlMs: number;
  correlationId?: string;
}

export type ExecuteResult =
  | { ok: { ast: unknown; outbound: Envelope | null; views: ViewLine[] } }
  | { err: string };

/// Surface published by the wasm-pack `aperture_wasm` artifact. The host
/// imports this lazily so a missing build doesn't break the SPA.
export interface ApertureModule {
  default: (input?: unknown) => Promise<unknown> | unknown;
  start: (mountId: string) => void;
  parse_line: (line: string) => unknown;
  App: new () => ApertureApp;
}

export interface ApertureApp {
  execute: (line: string) => unknown;
  handle_inbound: (envelopeJson: string) => unknown;
}

/// Display order across the grid. Mirrors the order in the SvelteKit page so
/// users moving between hosts get the same layout.
export interface PaneSpec {
  id: Exclude<Pane, "system">;
  title: string;
  hint: string;
}

export const PANE_ORDER: PaneSpec[] = [
  { id: "quote",      title: "Quote",        hint: "AAPL DESC GO" },
  { id: "chart",      title: "Chart",        hint: "AAPL CHART 6M GO" },
  { id: "news",       title: "News",         hint: "AAPL NEWS GO" },
  { id: "macro",      title: "Macro",        hint: "MACRO GO" },
  { id: "yields",     title: "Yields",       hint: "YIELDS GO" },
  { id: "fx",         title: "FX",           hint: "FX EUR GO" },
  { id: "crypto",     title: "Crypto",       hint: "BTC CRYPTO GO" },
  { id: "earnings",   title: "Earnings",     hint: "EARNINGS GO" },
  { id: "movers",     title: "Movers",       hint: "MOVERS losers GO" },
  { id: "screen",     title: "Screener",     hint: "SCREEN PE<15 GO" },
  { id: "members",    title: "Members",      hint: "SPX MEMBERS GO" },
  { id: "options",    title: "Options",      hint: "AAPL OPTIONS GO" },
  { id: "insider",    title: "Insider",      hint: "AAPL INSIDER GO" },
  { id: "financials", title: "Financials",   hint: "AAPL FINANCIALS GO" },
  { id: "corpact",    title: "Corp Actions", hint: "AAPL CORPACT GO" },
  { id: "ivol",       title: "IVol",         hint: "AAPL IVOL GO" },
  { id: "tech",       title: "Technicals",   hint: "AAPL TECH RSI GO" },
  { id: "filings",    title: "Filings",      hint: "AAPL FILINGS GO" },
  { id: "sentiment",  title: "Sentiment",    hint: "AAPL SENTIMENT GO" },
  { id: "watch",      title: "Watchlist",    hint: "AAPL WATCH GO" },
  { id: "risk",       title: "Risk",         hint: "RISK GO" },
  { id: "corr",       title: "Correlation",  hint: "CORR AAPL MSFT GO" },
  { id: "order",      title: "Order",        hint: "ORDER (BUY 100) GO" },
  { id: "oracle",     title: "Oracle",       hint: 'ASK "trend?" GO' },
  { id: "inbox",      title: "Inbox",        hint: "INBOX GO" },
  { id: "export",     title: "Export",       hint: "EXPORT csv GO" },
];
