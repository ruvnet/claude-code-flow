export const WORKSPACE_TIMEOUT_MS = 5_000;
export const WORKSPACE_RESPONSE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_REQUESTS = 12;

/** Exact arguments are owned by this adapter, never by the caller or tool descriptions. */
export const READ_CALLS: Record<string, Record<string, unknown>> = {
	system_status: { verbose: false },
	ruflo__system_status: { verbose: false },
	policy_status: {},
	ruflo__policy_status: {},
	metaharness_flywheel: { operation: "status" },
	ruflo__metaharness_flywheel_status: {},
};

export type ProbeFailure =
	| "timeout"
	| "oversize"
	| "redirect"
	| "credentials"
	| "http"
	| "malformed"
	| "runtime";

export class ProbeError extends Error {
	constructor(public readonly reason: ProbeFailure) {
		super(reason);
	}
}

/** No upstream text, endpoint, credentials or errors are returned to the browser. */
export function failureSummary(reason: ProbeFailure | "network"): string {
	return {
		timeout: "No complete response within the 5 second observation limit.",
		oversize: "The response exceeded the bounded observation size.",
		redirect: "The configured endpoint redirected. Set its final URL in deployment settings.",
		credentials: "The runtime rejected the configured service credentials.",
		http: "The runtime returned an unsuccessful HTTP response.",
		malformed: "The runtime response did not match the supported status contract.",
		runtime: "The runtime status tool reported an error, failure or degraded operation.",
		network: "The configured runtime could not be reached.",
	}[reason];
}

/**
 * Fetch only one fixed endpoint. Bound decompressed body bytes, total requests and
 * wall time; prevent credentials following redirects or arbitrary SDK requests.
 */
export function createBoundedTransport(
	url: URL,
	signal: AbortSignal,
	fetcher: typeof fetch,
	mcp: boolean
) {
	let totalBytes = 0;
	let requests = 0;
	let failure: ProbeFailure | undefined;
	let responded = false;
	const fail = (reason: ProbeFailure): never => {
		failure = reason;
		throw new ProbeError(reason);
	};
	const boundedFetch: typeof fetch = async (input, init) => {
		const target = input instanceof Request ? input.url : input.toString();
		if (target !== url.href || requests >= MAX_REQUESTS) fail("malformed");
		if (signal.aborted) fail("timeout");
		const method = init?.method ?? "GET";
		// A snapshot does not subscribe to optional MCP background SSE events.
		// The SDK accepts 405 here and still supports SSE responses to POST.
		if (mcp && method === "GET") return new Response(null, { status: 405 });
		if (method !== (mcp ? "POST" : "GET")) fail("malformed");
		if (mcp) {
			let message;
			try {
				message = JSON.parse(String(init?.body));
			} catch {
				fail("malformed");
			}
			if (
				!["initialize", "notifications/initialized", "tools/list", "tools/call"].includes(
					message?.method
				)
			) {
				fail("malformed");
			}
			if (message.method === "tools/call") {
				const name = message.params?.name;
				if (
					typeof name !== "string" ||
					!Object.hasOwn(READ_CALLS, name) ||
					JSON.stringify(message.params.arguments) !== JSON.stringify(READ_CALLS[name])
				)
					fail("malformed");
			}
		}
		requests += 1;
		const response = await fetcher(url, {
			...init,
			redirect: "manual",
			credentials: "omit",
			signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
		});
		// A fetch implementation must not turn a late completion into current evidence.
		if (signal.aborted) {
			void response.body?.cancel().catch(() => {});
			fail("timeout");
		}
		responded = true;
		if (response.status >= 300 && response.status < 400) {
			void response.body?.cancel().catch(() => {});
			fail("redirect");
		}
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			fail(response.status === 401 || response.status === 403 ? "credentials" : "http");
		}
		if (Number(response.headers.get("content-length")) > WORKSPACE_RESPONSE_BYTES) {
			void response.body?.cancel().catch(() => {});
			fail("oversize");
		}
		if (!response.body) return response;
		let bytes = 0;
		const stream = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					bytes += chunk.byteLength;
					totalBytes += chunk.byteLength;
					if (bytes > WORKSPACE_RESPONSE_BYTES || totalBytes > MAX_TOTAL_BYTES) fail("oversize");
					controller.enqueue(chunk);
				},
			}),
			{ signal }
		);
		return new Response(stream, { status: response.status, headers: response.headers });
	};
	return {
		fetch: boundedFetch,
		get failure() {
			return failure;
		},
		get responded() {
			return responded;
		},
	};
}
