<script lang="ts">
	import { onMount, onDestroy } from "svelte";

	type Pane =
		| "quote"
		| "chart"
		| "watch"
		| "oracle"
		| "news"
		| "macro"
		| "yields"
		| "fx"
		| "options"
		| "insider"
		| "financials"
		| "crypto"
		| "risk"
		| "corpact"
		| "inbox"
		| "export"
		| "earnings"
		| "movers"
		| "screen"
		| "members"
		| "ivol"
		| "tech"
		| "corr"
		| "filings"
		| "order"
		| "sentiment"
		| "system";
	type ViewLine = { pane: Pane; text: string };
	type Envelope = {
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
	};
	type ExecuteResult =
		| { ok: { ast: unknown; outbound: Envelope | null; views: ViewLine[] } }
		| { err: string };

	type ApertureModule = {
		default: (input?: unknown) => Promise<unknown> | unknown;
		start: (mountId: string) => void;
		parse_line: (line: string) => unknown;
		App: new () => {
			execute: (line: string) => unknown;
			handle_inbound: (envelope_json: string) => unknown;
		};
	};

	let status: "idle" | "loading" | "ready" | "missing" | "error" = "idle";
	let error: string | null = null;
	let input = "";
	let log: string[] = ["Aperture v0.1 — type `HELP GO`"];

	let mod: ApertureModule | null = null;
	let app: InstanceType<ApertureModule["App"]> | null = null;

	// Per-pane render buffer. Keep last 50 lines to avoid unbounded growth.
	const PANE_LIMIT = 50;
	let panes: Record<Pane, string[]> = {
		quote: [],
		chart: [],
		watch: [],
		oracle: [],
		news: [],
		macro: [],
		yields: [],
		fx: [],
		options: [],
		insider: [],
		financials: [],
		crypto: [],
		risk: [],
		corpact: [],
		inbox: [],
		export: [],
		earnings: [],
		movers: [],
		screen: [],
		members: [],
		ivol: [],
		tech: [],
		corr: [],
		filings: [],
		order: [],
		sentiment: [],
		system: [],
	};

	// Display order across the grid. Grouped by purpose:
	//   1. Market-info       : quote, chart
	//   2. Market discovery  : news, macro, yields, fx, crypto, earnings, movers, screen, members
	//   3. Per-symbol        : options, insider, financials, corpact, ivol, tech, filings, sentiment
	//   4. Portfolio + risk  : watch, risk, corr, order
	//   5. Comms / export    : oracle, inbox, export
	const PANE_ORDER: { id: Exclude<Pane, "system">; title: string; hint: string }[] = [
		{ id: "quote", title: "Quote", hint: "AAPL DESC GO" },
		{ id: "chart", title: "Chart", hint: "AAPL CHART 6M GO" },
		{ id: "news", title: "News", hint: "AAPL NEWS GO" },
		{ id: "macro", title: "Macro", hint: "MACRO CPI GO" },
		{ id: "yields", title: "Yields", hint: "YIELDS US10Y GO" },
		{ id: "fx", title: "FX", hint: "FX EURUSD GO" },
		{ id: "crypto", title: "Crypto", hint: "BTC CRYPTO GO" },
		{ id: "earnings", title: "Earnings", hint: "EARNINGS WEEK GO" },
		{ id: "movers", title: "Movers", hint: "MOVERS GAINERS GO" },
		{ id: "screen", title: "Screener", hint: "SCREEN PE<15 GO" },
		{ id: "members", title: "Members", hint: "SPX MEMBERS GO" },
		{ id: "options", title: "Options", hint: "AAPL OPTIONS GO" },
		{ id: "insider", title: "Insider", hint: "AAPL INSIDER GO" },
		{ id: "financials", title: "Financials", hint: "AAPL FINANCIALS GO" },
		{ id: "corpact", title: "Corp Actions", hint: "AAPL CORPACT GO" },
		{ id: "ivol", title: "IVol", hint: "AAPL IVOL GO" },
		{ id: "tech", title: "Technicals", hint: "AAPL TECH RSI GO" },
		{ id: "filings", title: "Filings", hint: "AAPL FILINGS 10-K GO" },
		{ id: "sentiment", title: "Sentiment", hint: "AAPL SENTIMENT GO" },
		{ id: "watch", title: "Watchlist", hint: "AAPL WATCH GO" },
		{ id: "risk", title: "Risk", hint: "PORTFOLIO RISK GO" },
		{ id: "corr", title: "Correlation", hint: "AAPL CORR MSFT GO" },
		{ id: "order", title: "Order", hint: "AAPL BUY 100 GO" },
		{ id: "oracle", title: "Oracle", hint: 'ASK "trend?" GO' },
		{ id: "inbox", title: "Inbox", hint: "INBOX LIST GO" },
		{ id: "export", title: "Export", hint: "EXPORT CSV GO" },
	];

	function pushPane(pane: Pane, text: string) {
		const next = [...panes[pane], text];
		if (next.length > PANE_LIMIT) next.splice(0, next.length - PANE_LIMIT);
		panes = { ...panes, [pane]: next };
	}

	function pushViews(views: ViewLine[]) {
		for (const v of views) {
			pushPane(v.pane, v.text);
			if (v.pane === "system") log = [...log, v.text];
		}
	}

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

	function onWindowMessage(ev: MessageEvent) {
		// Reject cross-origin / cross-window senders before touching
		// `handle_inbound`. Defends against iframes, popups, and browser
		// extensions trying to drive pane state.
		if (ev.origin !== window.location.origin) return;
		if (ev.source !== window) return;
		const data = ev.data;
		if (!looksLikeEnvelope(data)) return;
		// Ignore our own outbound echoes — outbound envelopes have
		// `from === "aperture:cmdbar"`. Inbound replies come from agents.
		if ((data as Envelope).from === "aperture:cmdbar") return;
		if (!app) return;
		try {
			const out = app.handle_inbound(JSON.stringify(data));
			if (Array.isArray(out)) pushViews(out as ViewLine[]);
		} catch (e) {
			log = [...log, `inbound error: ${e instanceof Error ? e.message : String(e)}`];
		}
	}

	onMount(async () => {
		status = "loading";
		try {
			// Built by plugins/ruflo-aperture/scripts/build-wasm.sh
			// @ts-expect-error — artifact may not exist until first build
			const m = (await import("$lib/aperture/aperture_wasm.js")) as ApertureModule;
			await m.default();
			m.start("aperture-mount");
			mod = m;
			app = new m.App();
			window.addEventListener("message", onWindowMessage);
			status = "ready";
		} catch (e) {
			status = "missing";
			error = e instanceof Error ? e.message : String(e);
		}
	});

	onDestroy(() => {
		if (typeof window !== "undefined") {
			window.removeEventListener("message", onWindowMessage);
		}
	});

	function execute() {
		const line = input.trim();
		if (!line || !app) return;
		log = [...log, `> ${line}`];
		try {
			const result = app.execute(line) as ExecuteResult;
			if ("err" in result) {
				log = [...log, `error: ${result.err}`];
			} else {
				if (Array.isArray(result.ok.views)) pushViews(result.ok.views);
				if (result.ok.outbound) {
					// Pin the target origin so embedders / popups can't read
					// outbound envelopes (ORDER + EXPORT payloads especially).
					window.postMessage(result.ok.outbound, window.location.origin);
				}
			}
		} catch (e) {
			log = [...log, `error: ${e instanceof Error ? e.message : String(e)}`];
		}
		input = "";
	}
</script>

<svelte:head>
	<title>Aperture · Market Workspace</title>
</svelte:head>

<main class="aperture-host">
	<header>
		<strong>Aperture</strong>
		<span>multi-pane market workspace · pane = swarm agent</span>
		<span class="status status-{status}">{status}</span>
	</header>

	{#if status === "missing"}
		<section class="missing">
			<p>Aperture WASM artifact not found.</p>
			<pre>plugins/ruflo-aperture/scripts/build-wasm.sh</pre>
			<p>Then reload this page.</p>
			{#if error}<pre class="err">{error}</pre>{/if}
		</section>
	{/if}

	<section class="panes">
		{#each PANE_ORDER as p (p.id)}
			<div class="pane">
				<div class="pane-title">{p.title}</div>
				<div class="pane-body">
					{#if panes[p.id].length === 0}
						<div class="pane-empty">(no data — try {p.hint})</div>
					{:else}
						{#each panes[p.id] as l, i (i)}<div>{l}</div>{/each}
					{/if}
				</div>
			</div>
		{/each}
	</section>

	<section class="log">
		{#each log as line, i (i)}<div>{line}</div>{/each}
	</section>

	<form on:submit|preventDefault={execute}>
		<input
			type="text"
			bind:value={input}
			placeholder="SYMBOL VERB [ARGS] GO   (e.g. AAPL CHART 6M GO)"
			autocomplete="off"
		/>
	</form>
</main>

<style>
	.aperture-host {
		display: grid;
		grid-template-rows: auto 1fr auto auto;
		gap: 0.5rem;
		padding: 0.75rem;
		font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
		font-size: 13px;
		min-height: 100vh;
		background: #0b0d10;
		color: #d6d6d6;
	}
	header {
		display: flex;
		gap: 0.75rem;
		align-items: baseline;
	}
	header strong {
		color: #f0f0f0;
	}
	header .status {
		margin-left: auto;
		opacity: 0.7;
	}
	.panes {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		grid-auto-rows: minmax(8rem, 1fr);
		grid-auto-flow: row;
		gap: 0.5rem;
		/* 26 panes ÷ 4 cols ≈ 7 rows; bump min-height so all rows stay visible. */
		min-height: 62rem;
	}
	@media (max-width: 1100px) {
		.panes {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 600px) {
		.panes {
			grid-template-columns: 1fr;
		}
	}
	.pane {
		border: 1px solid #232830;
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}
	.pane-title {
		padding: 0.25rem 0.5rem;
		background: #11151a;
		border-bottom: 1px solid #232830;
		color: #b8c7d4;
		font-size: 11px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		/* Sticky so the title stays visible when the pane body scrolls. */
		position: sticky;
		top: 0;
		z-index: 1;
	}
	.pane-body {
		padding: 0.5rem;
		overflow-y: auto;
		flex: 1 1 auto;
		min-height: 0;
		font-size: 12px;
	}
	.pane-empty {
		opacity: 0.45;
		font-style: italic;
	}
	.log {
		border: 1px solid #232830;
		padding: 0.5rem;
		max-height: 12rem;
		overflow-y: auto;
	}
	form input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: #11151a;
		border: 1px solid #232830;
		color: #f0f0f0;
		font: inherit;
	}
	.missing {
		border: 1px solid #5b3a00;
		padding: 0.5rem;
		background: #1d1303;
	}
	.err {
		color: #ff8a8a;
		white-space: pre-wrap;
	}
</style>
