import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createWorkspaceSnapshot } from "./snapshot";
import {
	createBoundedTransport,
	WORKSPACE_RESPONSE_BYTES,
	WORKSPACE_TIMEOUT_MS,
} from "./transport";

const RUFLO_URL = "https://runtime.example.test/mcp";
const RUOS_URL = "https://desktop.example.test";
const system = { status: "healthy", uptime: 42_000, components: { memory: { status: "unknown" } } };
const policy = { mode: "enforce", counts: { rules: 4, receipts: 9 }, ledger: { valid: true } };
const flywheel = {
	success: true,
	degraded: false,
	data: {
		state: { servingEpoch: 2, receiptStates: { receipt1: "evaluated" } },
		ledger: { valid: true, commits: 2 },
	},
};

function envelope(value: unknown, metadata: Record<string, unknown> = {}) {
	return { content: [{ type: "text", text: JSON.stringify(value) }], ...metadata };
}

function mcpFixture(
	names: string[] = ["system_status", "policy_status", "metaharness_flywheel"],
	options: {
		status?: Record<string, unknown>;
		list?: unknown;
		sse?: boolean;
		toolResult?: unknown;
		additionalEnvelopes?: number;
	} = {}
) {
	const messages: Record<string, unknown>[] = [];
	const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
		const message = JSON.parse(String(init?.body));
		messages.push(message);
		if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
		let result: unknown;
		if (message.method === "initialize") {
			result = {
				protocolVersion: message.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1.0.0" },
			};
		} else if (message.method === "tools/list") {
			result = options.list ?? {
				tools: names.map((name) => ({ name, inputSchema: { type: "object" } })),
			};
		} else if (message.method === "tools/call") {
			const name: string = message.params.name;
			const value =
				options.status ??
				(name.includes("flywheel") ? flywheel : name.includes("policy") ? policy : system);
			result = options.toolResult ?? { content: [{ type: "text", text: JSON.stringify(value) }] };
			for (let layer = 0; layer < (options.additionalEnvelopes ?? 0); layer += 1)
				result = envelope(result);
		} else {
			throw new Error("Unexpected method");
		}
		const data = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
		return options.sse
			? new Response(`event: message\ndata: ${data}\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				})
			: new Response(data, { headers: { "Content-Type": "application/json" } });
	});
	return { fetcher, messages };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("workspace runtime observations", () => {
	it("returns four honest unconfigured states without opening any connection", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const snapshot = await createWorkspaceSnapshot({}, fetcher);
		expect(snapshot.integrations.map((item) => item.state)).toEqual(
			Array(4).fill("not_configured")
		);
		expect(
			snapshot.integrations.every((item) => item.checkedAt === null && item.metrics.length === 0)
		).toBe(true);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("uses real MCP initialization, discovery and exact read calls with service credentials", async () => {
		const { fetcher, messages } = mcpFixture();
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_RUFLO_MCP_URL: RUFLO_URL, WORKSPACE_RUFLO_TOKEN: "private-fixture-token" },
			fetcher
		);
		const [ruflo, metaharness, autogenous] = snapshot.integrations;
		expect(ruflo).toMatchObject({
			state: "available",
			toolCount: 3,
			source: { discoveryOnly: false },
		});
		expect(ruflo.metrics).toContainEqual({ label: "Process uptime seconds", value: 42 });
		expect(ruflo.metrics).toContainEqual({ label: "Policy mode", value: "enforce" });
		expect(metaharness).toMatchObject({
			state: "available",
			source: { configuredBy: "WORKSPACE_RUFLO_MCP_URL", discoveryOnly: false },
		});
		expect(metaharness.metrics).toContainEqual({ label: "Promotion commits", value: 2 });
		expect(autogenous.state).toBe("not_configured");
		const calls = messages
			.filter((message) => message.method === "tools/call")
			.map((message) => message.params);
		expect(calls).toEqual(
			expect.arrayContaining([
				{ name: "system_status", arguments: { verbose: false } },
				{ name: "policy_status", arguments: {} },
				{ name: "metaharness_flywheel", arguments: { operation: "status" } },
			])
		);
		expect(calls).toHaveLength(3);
		for (const [url, init] of fetcher.mock.calls) {
			expect(String(url)).toBe(RUFLO_URL);
			expect(init).toMatchObject({ redirect: "manual", credentials: "omit", method: "POST" });
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-fixture-token");
		}
		expect(JSON.stringify(snapshot)).not.toContain("private-fixture-token");
		expect(JSON.stringify(snapshot)).not.toContain(RUFLO_URL);
	});

	it("accepts actual SSE MCP response envelopes and the fixed bridge status wrappers", async () => {
		const { fetcher, messages } = mcpFixture(
			["ruflo__system_status", "ruflo__policy_status", "ruflo__metaharness_flywheel_status"],
			{ sse: true }
		);
		const snapshot = await createWorkspaceSnapshot({ WORKSPACE_RUFLO_MCP_URL: RUFLO_URL }, fetcher);
		expect(snapshot.integrations.slice(0, 2).map((item) => item.state)).toEqual([
			"available",
			"available",
		]);
		expect(messages).toContainEqual(
			expect.objectContaining({
				method: "tools/call",
				params: { name: "ruflo__metaharness_flywheel_status", arguments: {} },
			})
		);
	});

	it("labels discovery-only results and does not execute similarly named or arbitrary tools", async () => {
		const { fetcher, messages } = mcpFixture([
			"system_status_attack",
			"metaharness_flywheel_promote",
			"shell_execute",
		]);
		const snapshot = await createWorkspaceSnapshot({ WORKSPACE_RUFLO_MCP_URL: RUFLO_URL }, fetcher);
		expect(snapshot.integrations[0]).toMatchObject({
			state: "available",
			toolCount: 3,
			source: { discoveryOnly: true },
		});
		expect(snapshot.integrations[1].state).toBe("degraded");
		expect(messages.some((message) => message.method === "tools/call")).toBe(false);
	});

	it.each([1, 2])(
		"unwraps the real HTTP bridge plus stdio envelope shape with %s extra layers",
		async (additionalEnvelopes) => {
			const { fetcher } = mcpFixture(
				["ruflo__system_status", "ruflo__policy_status", "ruflo__metaharness_flywheel_status"],
				{ additionalEnvelopes }
			);
			const snapshot = await createWorkspaceSnapshot(
				{ WORKSPACE_RUFLO_MCP_URL: RUFLO_URL },
				fetcher
			);
			expect(snapshot.integrations[0].state).toBe("available");
			expect(snapshot.integrations[0].metrics).toContainEqual({
				label: "Policy mode",
				value: "enforce",
			});
			expect(snapshot.integrations[1].state).toBe("available");
			expect(snapshot.integrations[1].metrics).toContainEqual({
				label: "Promotion commits",
				value: 2,
			});
		}
	);

	it("rejects more than three MCP envelopes", async () => {
		const { fetcher } = mcpFixture(["ruflo__metaharness_flywheel_status"], {
			additionalEnvelopes: 3,
		});
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL },
			fetcher
		);
		expect(snapshot.integrations[1]).toMatchObject({ state: "degraded", metrics: [] });
	});

	it.each([
		envelope(envelope(flywheel), { success: false }),
		envelope(envelope(flywheel), { degraded: true }),
		envelope(envelope(flywheel), { exitCode: 1 }),
		envelope(envelope(flywheel, { isError: true })),
		envelope(envelope(flywheel, { success: false })),
		envelope(envelope(flywheel, { degraded: true })),
		envelope(envelope(flywheel, { exitCode: 1 })),
		envelope(envelope({ ...flywheel, exitCode: 1 })),
		envelope(envelope(flywheel, { isError: true }), { structuredContent: flywheel }),
		envelope(envelope(flywheel), { structuredContent: { ...flywheel, isError: true } }),
	])(
		"does not mask an outer or nested failure with an apparently successful payload",
		async (toolResult) => {
			const { fetcher } = mcpFixture(["ruflo__metaharness_flywheel_status"], { toolResult });
			const snapshot = await createWorkspaceSnapshot(
				{ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL },
				fetcher
			);
			expect(snapshot.integrations[1]).toMatchObject({ state: "degraded", metrics: [] });
			expect(snapshot.integrations[1].summary).toContain("reported an error");
		}
	);

	it("accepts matching structured and nested text status without losing explicit zero exit codes", async () => {
		const result = { ...flywheel, exitCode: 0 };
		const { fetcher } = mcpFixture(["ruflo__metaharness_flywheel_status"], {
			toolResult: envelope(envelope(result, { success: true, degraded: false, exitCode: 0 }), {
				structuredContent: result,
				success: true,
				degraded: false,
				exitCode: 0,
			}),
		});
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL },
			fetcher
		);
		expect(snapshot.integrations[1].state).toBe("available");
	});

	it("rejects contradictory status representations instead of preferring the healthy one", async () => {
		const invalidLedger = {
			...flywheel,
			data: { ...flywheel.data, ledger: { valid: false, commits: 2 } },
		};
		const { fetcher } = mcpFixture(["ruflo__metaharness_flywheel_status"], {
			toolResult: envelope(envelope(invalidLedger), { structuredContent: flywheel }),
		});
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL },
			fetcher
		);
		expect(snapshot.integrations[1]).toMatchObject({ state: "degraded", metrics: [] });
	});

	it.each([
		{ success: false, degraded: false, error: "secret upstream failure" },
		{ success: true, degraded: true, error: "secret upstream failure" },
		{ ...flywheel, data: { ...flywheel.data, ledger: { valid: false, commits: 2 } } },
	])("preserves failed or degraded MetaHarness status as degraded", async (status) => {
		const { fetcher } = mcpFixture(["metaharness_flywheel"], { status });
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL },
			fetcher
		);
		expect(snapshot.integrations[1].state).toBe("degraded");
		expect(JSON.stringify(snapshot)).not.toContain("secret upstream failure");
	});

	it.each([
		{ status: "unhealthy", uptime: 1000 },
		{ status: "healthy", uptime: 1000, degraded: true },
		{ status: "healthy", uptime: 1000, success: false },
	])("does not label explicitly unhealthy system reports available", async (status) => {
		const { fetcher } = mcpFixture(["system_status"], { status });
		const snapshot = await createWorkspaceSnapshot({ WORKSPACE_RUFLO_MCP_URL: RUFLO_URL }, fetcher);
		expect(snapshot.integrations[0].state).toBe("degraded");
	});

	it.each([
		{ tools: "not an array" },
		{
			tools: [
				{ name: "system_status", inputSchema: { type: "object" } },
				{ name: "system_status", inputSchema: { type: "object" } },
			],
		},
		{ tools: [{ name: "system_status" }] },
		{ tools: [], nextCursor: "repeated-cursor" },
	])("rejects malformed, duplicate and cyclic tool inventories", async (list) => {
		const { fetcher } = mcpFixture([], { list });
		const snapshot = await createWorkspaceSnapshot({ WORKSPACE_RUFLO_MCP_URL: RUFLO_URL }, fetcher);
		expect(snapshot.integrations[0].state).toBe("degraded");
		expect(snapshot.integrations[0].toolCount).toBeUndefined();
	});

	it("rejects an inventory over the total tool limit", async () => {
		const { fetcher } = mcpFixture(Array.from({ length: 1025 }, (_, index) => `tool_${index}`));
		const snapshot = await createWorkspaceSnapshot({ WORKSPACE_RUFLO_MCP_URL: RUFLO_URL }, fetcher);
		expect(snapshot.integrations[0]).toMatchObject({
			state: "degraded",
			metrics: [],
		});
		expect(snapshot.integrations[0].toolCount).toBeUndefined();
	});

	it.each([
		{ content: [{ type: "text", text: "a password rather than JSON" }] },
		{ content: [{ type: "text", text: "[]" }] },
		{ content: [{ type: "text", text: JSON.stringify(system) }], isError: true },
		{ content: [{ type: "text", text: JSON.stringify({ ...system, uptime: -1 }) }] },
	])("rejects malformed or error status payloads without emitting raw text", async (toolResult) => {
		const { fetcher } = mcpFixture(["system_status"], { toolResult });
		const snapshot = await createWorkspaceSnapshot({ WORKSPACE_RUFLO_MCP_URL: RUFLO_URL }, fetcher);
		expect(snapshot.integrations[0]).toMatchObject({ state: "degraded", metrics: [] });
		expect(JSON.stringify(snapshot)).not.toContain("password");
	});

	it("redacts nested credentials, upstream errors, prompts and machine identifiers by allowlisting", async () => {
		const secret = "untrusted-secret-canary";
		const { fetcher } = mcpFixture(["system_status"], {
			status: {
				...system,
				token: secret,
				prompt: secret,
				endpoint: secret,
				metrics: { authorization: secret },
			},
		});
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_RUFLO_MCP_URL: RUFLO_URL, WORKSPACE_RUFLO_TOKEN: secret },
			fetcher
		);
		expect(snapshot.integrations[0].state).toBe("available");
		expect(JSON.stringify(snapshot)).not.toContain(secret);
		expect(JSON.stringify(snapshot)).not.toContain("components");
	});

	it.each([401, 403, 500])(
		"maps upstream HTTP %s to degraded without exposing its error body",
		async (status) => {
			const fetcher = vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response("secret error body", { status }));
			const snapshot = await createWorkspaceSnapshot(
				{ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL },
				fetcher
			);
			expect(snapshot.integrations[1].state).toBe("degraded");
			expect(JSON.stringify(snapshot)).not.toContain("secret error body");
		}
	);

	it("rejects redirects before a credential can be sent to their target", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(null, { status: 302, headers: { Location: "https://attacker.example.test" } })
			);
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL, WORKSPACE_METAHARNESS_TOKEN: "secret" },
			fetcher
		);
		expect(snapshot.integrations[1].state).toBe("degraded");
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(snapshot)).not.toContain("attacker");
	});

	it("classifies a connection failure as unreachable", async () => {
		const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret endpoint refused"));
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL },
			fetcher
		);
		expect(snapshot.integrations[1].state).toBe("unreachable");
		expect(JSON.stringify(snapshot)).not.toContain("secret endpoint");
	});

	it("enforces one 5 second deadline and aborts pending I/O", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | null | undefined;
		const fetcher = vi.fn<typeof fetch>((_input, init) => {
			signal = init?.signal;
			return new Promise(() => {});
		});
		const result = createWorkspaceSnapshot({ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL }, fetcher);
		await vi.advanceTimersByTimeAsync(WORKSPACE_TIMEOUT_MS);
		const snapshot = await result;
		expect(snapshot.integrations[1]).toMatchObject({
			state: "unreachable",
			latencyMs: WORKSPACE_TIMEOUT_MS,
		});
		expect(signal?.aborted).toBe(true);
	});

	it("bounds decoded streaming bodies even when no content length was provided", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(new Uint8Array(WORKSPACE_RESPONSE_BYTES + 1), {
				headers: { "Content-Type": "application/json" },
			})
		);
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL },
			fetcher
		);
		expect(snapshot.integrations[1]).toMatchObject({ state: "degraded", metrics: [] });
		expect(snapshot.integrations[1].summary).toContain("size");
	});

	it("keeps a returned timeout snapshot immutable when an uncooperative reader settles late", async () => {
		vi.useFakeTimers();
		let completeRead: (value: unknown) => void = () => {};
		const lateRead = new Promise((resolve) => {
			completeRead = resolve;
		});
		const response = new Response(null, { headers: { "Content-Type": "application/json" } });
		response.json = () => lateRead;
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
		const pending = createWorkspaceSnapshot({ WORKSPACE_RUOS_BASE_URL: RUOS_URL }, fetcher);
		await vi.advanceTimersByTimeAsync(WORKSPACE_TIMEOUT_MS);
		const snapshot = await pending;
		const frozen = JSON.stringify(snapshot);
		completeRead({ ok: true, services: { "rustdesk-hbbs": "active", "rustdesk-hbbr": "active" } });
		await vi.advanceTimersByTimeAsync(1);
		expect(snapshot.integrations[3]).toMatchObject({ state: "unreachable", metrics: [] });
		expect(JSON.stringify(snapshot)).toBe(frozen);
	});

	it("cancels late fetch responses without parsing them after timeout", async () => {
		vi.useFakeTimers();
		let completeFetch: (response: Response) => void = () => {};
		const fetcher = vi.fn<typeof fetch>(
			() =>
				new Promise((resolve) => {
					completeFetch = resolve;
				})
		);
		const pending = createWorkspaceSnapshot({ WORKSPACE_RUOS_BASE_URL: RUOS_URL }, fetcher);
		await vi.advanceTimersByTimeAsync(WORKSPACE_TIMEOUT_MS);
		const snapshot = await pending;
		let cancelled = false;
		const body = new ReadableStream({
			cancel() {
				cancelled = true;
			},
		});
		completeFetch(new Response(body, { headers: { "Content-Type": "application/json" } }));
		await vi.advanceTimersByTimeAsync(1);
		expect(cancelled).toBe(true);
		expect(snapshot.integrations[3].state).toBe("unreachable");
	});

	it("does not wait for asynchronous SDK cleanup beyond the observation deadline", async () => {
		vi.spyOn(Client.prototype, "close").mockImplementation(() => new Promise(() => {}));
		const { fetcher } = mcpFixture(["metaharness_flywheel"]);
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_METAHARNESS_MCP_URL: RUFLO_URL },
			fetcher
		);
		expect(snapshot.integrations[1].state).toBe("available");
	});

	it.each([
		"file:///etc/passwd",
		"https://user:secret@example.test/mcp",
		"https://example.test/mcp?token=secret",
		"https://example.test/mcp#secret",
	])("rejects unsafe deployment URLs before network access", async (url) => {
		const fetcher = vi.fn<typeof fetch>();
		const snapshot = await createWorkspaceSnapshot({ WORKSPACE_METAHARNESS_MCP_URL: url }, fetcher);
		expect(snapshot.integrations[1]).toMatchObject({ state: "degraded", checkedAt: null });
		expect(fetcher).not.toHaveBeenCalled();
		expect(JSON.stringify(snapshot)).not.toContain("secret");
	});

	it("restricts SDK transport tools/call to fixed status arguments", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const url = new URL(RUFLO_URL);
		const transport = createBoundedTransport(url, new AbortController().signal, fetcher, true);
		await expect(
			transport.fetch(url, {
				method: "POST",
				body: JSON.stringify({
					method: "tools/call",
					params: { name: "metaharness_flywheel", arguments: { operation: "promote" } },
				}),
			})
		).rejects.toThrow("malformed");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("observes the concrete ruOS endpoint and keeps service failures private", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				ok: true,
				services: { "rustdesk-hbbs": "active", "rustdesk-hbbr": "active" },
			})
		);
		const snapshot = await createWorkspaceSnapshot(
			{ WORKSPACE_RUOS_BASE_URL: RUOS_URL, WORKSPACE_RUOS_TOKEN: "ruos-private" },
			fetcher
		);
		expect(snapshot.integrations[3]).toMatchObject({
			state: "available",
			metrics: [{ label: "Active rendezvous services", value: 2 }],
			source: { discoveryOnly: false },
		});
		expect(String(fetcher.mock.calls[0][0])).toBe(`${RUOS_URL}/api/v1/server/health`);
		expect(JSON.stringify(snapshot)).not.toContain("ruos-private");
	});

	it("does not trust ok:true when a ruOS service is failed", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				ok: true,
				services: { "rustdesk-hbbs": "active", "rustdesk-hbbr": "error: private path and token" },
			})
		);
		const snapshot = await createWorkspaceSnapshot({ WORKSPACE_RUOS_BASE_URL: RUOS_URL }, fetcher);
		expect(snapshot.integrations[3].state).toBe("degraded");
		expect(JSON.stringify(snapshot)).not.toContain("private path");
	});
});
