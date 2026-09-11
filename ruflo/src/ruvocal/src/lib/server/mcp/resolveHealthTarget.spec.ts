import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHealthTarget } from "./resolveHealthTarget";

const privateServers = JSON.stringify([
	{
		name: "Ruflo",
		url: "http://192.168.1.20:3001/mcp/operations",
		headers: { Authorization: "Bearer deployment-test-secret" },
	},
]);

describe("health target authority", () => {
	it("resolves exact deployment identity and private credentials without browser copies", () => {
		expect(resolveHealthTarget({ serverId: "base-Ruflo" }, privateServers)).toEqual({
			url: "http://192.168.1.20:3001/mcp/operations",
			headers: [{ key: "Authorization", value: "Bearer deployment-test-secret" }],
			configured: true,
		});
	});
	it.each([
		{ serverId: "base-missing" },
		{ serverId: "Ruflo" },
		{ serverId: 1 },
		{ serverId: "base-Ruflo", url: "https://attacker.example/mcp" },
		{ serverId: "base-Ruflo", url: "http://192.168.1.20:3001/mcp/operations" },
		{ serverId: "base-Ruflo", headers: [] },
		{ serverId: "base-Ruflo", headers: [{ key: "Authorization", value: "Bearer replacement" }] },
	])("rejects unknown identities and every configured target override: %j", (body) => {
		expect(() => resolveHealthTarget(body, privateServers)).toThrow();
	});
	it("rejects duplicate configured identities", () => {
		const duplicate = JSON.stringify([
			...JSON.parse(privateServers),
			...JSON.parse(privateServers),
		]);
		expect(() => resolveHealthTarget({ serverId: "base-Ruflo" }, duplicate)).toThrow(/ambiguous/);
	});
	it.each([
		"file:///etc/passwd",
		"https://user:password@example.test/mcp",
		"http://host/mcp#fragment",
	])("rejects invalid configured targets: %s", (url) => {
		expect(() =>
			resolveHealthTarget({ serverId: "base-Ruflo" }, JSON.stringify([{ name: "Ruflo", url }]))
		).toThrow(/configuration/);
	});
	it("preserves HTTPS custom credentials without borrowing deployment headers", () => {
		const headers = [{ key: "X-Personal-Key", value: "personal-key" }];
		expect(
			resolveHealthTarget({ url: "https://example.test/mcp", headers }, privateServers)
		).toEqual({
			url: "https://example.test/mcp",
			headers,
			configured: false,
		});
	});
	it.each(["http://example.test/mcp", "https://169.254.169.254/mcp", "file:///etc/passwd"])(
		"preserves custom URL validation: %s",
		(url) => {
			expect(() => resolveHealthTarget({ url }, privateServers)).toThrow(/unsafe/);
		}
	);
	it("preserves the existing custom loopback exception", () => {
		expect(
			resolveHealthTarget({ url: "http://localhost:3001/mcp" }, privateServers).configured
		).toBe(false);
	});
});

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	listTools: vi.fn(),
	close: vi.fn(),
	transports: vi.fn(),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		connect = mocks.connect;
		listTools = mocks.listTools;
		close = mocks.close;
	},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		constructor(url: URL, options: unknown) {
			mocks.transports(url, options);
		}
	},
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: class {
		constructor(url: URL, options: unknown) {
			mocks.transports(url, options);
		}
	},
}));
vi.mock("$lib/server/config", () => ({
	config: {
		MCP_SERVERS: JSON.stringify([
			{
				name: "Ruflo",
				url: "http://192.168.1.20:3001/mcp/operations",
				headers: { Authorization: "Bearer deployment-test-secret" },
			},
		]),
		EXA_API_KEY: "",
		MCP_FORWARD_HF_USER_TOKEN: "false",
	},
}));
vi.mock("$lib/server/logger", () => ({ logger: mocks.logger }));
import { POST } from "../../../routes/api/mcp/health/+server";

async function probe(body: unknown) {
	return POST({
		request: new Request("https://ui.test/api/mcp/health", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: {},
	} as Parameters<typeof POST>[0]);
}

describe("configured health route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.connect.mockResolvedValue(undefined);
		mocks.close.mockResolvedValue(undefined);
		mocks.listTools.mockResolvedValue({
			tools: [{ name: "ruflo__policy_status", inputSchema: { type: "object" } }],
		});
	});
	it("uses the deployment credential on the server and never returns it", async () => {
		const response = await probe({ serverId: "base-Ruflo" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ready: true,
			authRequired: false,
			tools: [{ name: "ruflo__policy_status", inputSchema: { type: "object" } }],
		});
		const [url, options] = mocks.transports.mock.calls[0];
		expect(url.toString()).toBe("http://192.168.1.20:3001/mcp/operations");
		expect(options.requestInit.headers.Authorization).toBe("Bearer deployment-test-secret");
		expect(options.requestInit.redirect).toBe("error");
	});
	it.each([
		{ serverId: "base-missing" },
		{ serverId: "base-Ruflo", url: "https://attacker.test/mcp" },
		{ serverId: "base-Ruflo", headers: [{ key: "Host", value: "attacker.test" }] },
		{ url: "http://example.test/mcp" },
	])("rejects invalid targets before any connection: %j", async (body) => {
		const response = await probe(body);
		expect(response.status).toBe(400);
		expect(mocks.connect).not.toHaveBeenCalled();
		expect(mocks.transports).not.toHaveBeenCalled();
	});
	it("uses only personal headers for a custom HTTPS endpoint", async () => {
		const response = await probe({
			url: "https://example.test/mcp",
			headers: [{ key: "X-Personal-Key", value: "mine" }],
		});
		expect(response.status).toBe(200);
		const [, options] = mocks.transports.mock.calls[0];
		expect(options.requestInit.headers["X-Personal-Key"]).toBe("mine");
		expect(options.requestInit.headers.Authorization).toBeUndefined();
	});
	it("pins HTTP and SSE fetches to the configured origin without redirects", async () => {
		mocks.connect.mockRejectedValueOnce(new Error("Try legacy SSE"));
		const response = await probe({ serverId: "base-Ruflo" });
		expect(response.status).toBe(200);
		expect(mocks.transports).toHaveBeenCalledTimes(2);
		const outbound = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
		try {
			for (const [, options] of mocks.transports.mock.calls) {
				await expect(options.fetch("https://attacker.test/mcp", {})).rejects.toThrow(/origin/);
				expect(outbound).not.toHaveBeenCalled();
				await options.fetch("http://192.168.1.20:3001/messages", { redirect: "follow" });
				expect(outbound.mock.calls[0][1]?.redirect).toBe("error");
				outbound.mockClear();
			}
		} finally {
			outbound.mockRestore();
		}
	});
	it("redacts credential-bearing upstream failures from responses and logs", async () => {
		mocks.connect.mockRejectedValue(new Error("401 deployment-test-secret"));
		const response = await probe({ serverId: "base-Ruflo" });
		expect(response.status).toBe(503);
		const text = await response.text();
		expect(text).not.toContain("deployment-test-secret");
		expect(JSON.parse(text).authRequired).toBe(true);
		for (const logger of Object.values(mocks.logger))
			expect(JSON.stringify(logger.mock.calls)).not.toContain("deployment-test-secret");
	});
});
