import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * Server-side CORS proxy for Aperture data providers.
 *
 * The browser-side WASM shell never reaches finance APIs directly:
 *   - Some providers (Yahoo, Binance, FRED) refuse cross-origin requests.
 *   - API keys (FRED_API_KEY, ALPHAVANTAGE_KEY, ...) must stay server-side
 *     and are read from `.env` here, never bundled into the WASM artifact.
 *
 * Hardened against SSRF: HTTPS-only, hostname-allowlisted, no userinfo,
 * standard ports only, request timeout, response body size cap.
 */

const ALLOWED_HOSTS = new Set<string>([
	"query1.finance.yahoo.com",
	"query2.finance.yahoo.com",
	"api.coingecko.com",
	"api.binance.com",
	"api.stlouisfed.org",
	"data.sec.gov",
	"www.alphavantage.co",
]);

// Stop runaway upstreams from pinning the Node process. Yahoo/FRED
// responses are tiny — 5 MiB is generous. 15 s covers slow-but-real APIs.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export const GET: RequestHandler = async ({ url, fetch }) => {
	const upstream = url.searchParams.get("u");
	if (!upstream) throw error(400, "missing ?u=<upstream-url>");

	let target: URL;
	try {
		target = new URL(upstream);
	} catch {
		throw error(400, "invalid upstream url");
	}
	// HTTPS only — `http:`, `file:`, `data:`, `javascript:`, `ftp:`, `ws:`
	// all fail. Closes SSRF / scheme-confusion paths.
	if (target.protocol !== "https:") {
		throw error(400, `protocol not allowed: ${target.protocol}`);
	}
	// Reject embedded credentials (`https://attacker:pw@host/...`) which
	// some upstreams trust for auth bypass.
	if (target.username || target.password) {
		throw error(400, "userinfo not allowed");
	}
	// Pin to the default HTTPS port to prevent host:port abuse against
	// internal services (e.g. `:22`, `:6379`).
	if (target.port !== "" && target.port !== "443") {
		throw error(400, `port not allowed: ${target.port}`);
	}
	if (!ALLOWED_HOSTS.has(target.hostname)) {
		throw error(403, `host not allowed: ${target.hostname}`);
	}

	let res: Response;
	try {
		res = await fetch(target.toString(), {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			redirect: "manual", // don't follow into non-allowlisted hosts
		});
	} catch (e) {
		throw error(504, `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	const reader = res.body?.getReader();
	if (!reader) {
		return new Response(null, { status: res.status });
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) {
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				try { await reader.cancel(); } catch { /* ignore */ }
				throw error(502, `upstream body exceeds ${MAX_RESPONSE_BYTES} bytes`);
			}
			chunks.push(value);
		}
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		merged.set(c, offset);
		offset += c.byteLength;
	}

	const contentType = res.headers.get("content-type") ?? "application/json";
	return new Response(merged, {
		status: res.status,
		headers: {
			"content-type": contentType,
			"cache-control": "no-store",
		},
	});
};

export const POST: RequestHandler = async () => {
	return json({ error: "POST not yet supported by aperture proxy" }, { status: 405 });
};
