import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WorkspaceIntegration, WorkspaceSnapshot } from "$lib/types/Workspace";
import { readWorkspaceConfig, type IntegrationConfig, type WorkspaceEnvironment } from "./config";
import {
	normalizeFlywheel,
	normalizePolicy,
	normalizeRuos,
	normalizeSystem,
	toolData,
} from "./normalize";
import {
	createBoundedTransport,
	failureSummary,
	ProbeError,
	READ_CALLS,
	WORKSPACE_TIMEOUT_MS,
} from "./transport";

const MAX_PAGES = 4;
const MAX_TOOLS = 1024;

function summarizeRuflo(integration: WorkspaceIntegration): string {
	return integration.state === "degraded"
		? "The runtime reported a degraded system state or invalid policy ledger."
		: "Runtime status observed. Individual component health and action authority are not established.";
}

async function observeMcp(client: Client, integration: WorkspaceIntegration, signal: AbortSignal) {
	const names = new Set<string>();
	const cursors = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const result = await client.listTools(cursor ? { cursor } : {}, { signal });
		for (const tool of result.tools) {
			if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(tool.name) || names.has(tool.name))
				throw new ProbeError("malformed");
			names.add(tool.name);
			if (names.size > MAX_TOOLS) throw new ProbeError("oversize");
		}
		cursor = result.nextCursor;
		if (!cursor) break;
		if (cursor.length > 2048 || cursors.has(cursor)) throw new ProbeError("malformed");
		cursors.add(cursor);
		if (page === MAX_PAGES - 1) throw new ProbeError("oversize");
	}
	integration.toolCount = names.size;
	integration.state = "available";
	integration.summary =
		"MCP discovery completed. Tool execution and operational health are not verified.";
	const call = async (name: string) =>
		toolData(await client.callTool({ name, arguments: READ_CALLS[name] }, undefined, { signal }));
	if (integration.id === "ruflo") {
		const system = ["ruflo__system_status", "system_status"].find((name) => names.has(name));
		const policy = ["ruflo__policy_status", "policy_status"].find((name) => names.has(name));
		if (system) normalizeSystem(await call(system), integration);
		if (policy) normalizePolicy(await call(policy), integration);
		if (system || policy) {
			integration.source.discoveryOnly = false;
			integration.source.label = [system ? "system_status" : "", policy ? "policy_status" : ""]
				.filter(Boolean)
				.join(" + ");
			integration.summary = summarizeRuflo(integration);
		}
	} else if (integration.id === "metaharness") {
		const flywheel = ["ruflo__metaharness_flywheel_status", "metaharness_flywheel"].find((name) =>
			names.has(name)
		);
		if (flywheel) {
			integration.source.discoveryOnly = false;
			integration.source.label = "Ruflo MetaHarness flywheel status";
			normalizeFlywheel(await call(flywheel), integration);
		} else {
			integration.state = "degraded";
			integration.summary =
				"MCP discovery completed, but the fixed MetaHarness status tool is not exposed.";
		}
	}
}

async function observeIntegration(
	config: IntegrationConfig,
	fetcher: typeof fetch
): Promise<WorkspaceIntegration> {
	const integration = config.base;
	if (!config.url) return integration;
	// Only a completed observation is committed to the returned object. A timed
	// out task may settle later, but it can mutate only this private draft.
	const draft = structuredClone(integration);
	const started = Date.now();
	const controller = new AbortController();
	const bounded = createBoundedTransport(
		config.url,
		controller.signal,
		fetcher,
		integration.source.kind === "mcp"
	);
	const headers: Record<string, string> = config.token
		? { Authorization: `Bearer ${config.token}` }
		: {};
	let client: Client | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new ProbeError("timeout"));
			}, WORKSPACE_TIMEOUT_MS);
		});
		const observe = async () => {
			if (integration.source.kind === "http") {
				const response = await bounded.fetch(config.url as URL, {
					headers: { ...headers, Accept: "application/json" },
				});
				if (!response.headers.get("content-type")?.includes("application/json"))
					throw new ProbeError("malformed");
				normalizeRuos(await response.json(), draft);
				return;
			}
			client = new Client({ name: "ruflo-workspace-observer", version: "1.0.0" });
			const transport = new StreamableHTTPClientTransport(config.url as URL, {
				fetch: bounded.fetch,
				requestInit: { headers },
				reconnectionOptions: {
					maxRetries: 0,
					initialReconnectionDelay: 0,
					maxReconnectionDelay: 0,
					reconnectionDelayGrowFactor: 1,
				},
			});
			await client.connect(transport, { signal: controller.signal, timeout: WORKSPACE_TIMEOUT_MS });
			await observeMcp(client, draft, controller.signal);
		};
		await Promise.race([observe(), deadline]);
		if (controller.signal.aborted) throw new ProbeError("timeout");
		Object.assign(integration, draft);
	} catch (error) {
		const reason = controller.signal.aborted
			? "timeout"
			: (bounded.failure ??
				(error instanceof ProbeError ? error.reason : bounded.responded ? "malformed" : "network"));
		integration.state = reason === "timeout" || reason === "network" ? "unreachable" : "degraded";
		integration.summary = failureSummary(reason);
		// A failed observation never retains partial metrics as current operational evidence.
		integration.metrics = [];
	} finally {
		clearTimeout(timer);
		controller.abort();
		// The installed SDK closes by aborting its transport synchronously. Do
		// not let a future asynchronous cleanup extend the observation deadline.
		void client?.close().catch(() => {});
		integration.checkedAt = new Date().toISOString();
		integration.latencyMs = Math.max(0, Date.now() - started);
	}
	return integration;
}

export async function createWorkspaceSnapshot(
	env: WorkspaceEnvironment,
	fetcher: typeof fetch = globalThis.fetch
): Promise<WorkspaceSnapshot> {
	const configs = readWorkspaceConfig(env);
	// One failed source must not blank the remaining integrations.
	const integrations = await Promise.all(
		configs.map((config) => observeIntegration(config, fetcher))
	);
	return { schemaVersion: 1, checkedAt: new Date().toISOString(), integrations };
}
