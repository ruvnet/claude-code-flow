/**
 * MCP Servers Store
 * Manages base (env-configured), custom (user-added), and WASM (browser-local) MCP servers
 * Stores custom servers and selection state in browser localStorage
 * WASM servers run entirely in-browser via rvagent-wasm with IndexedDB persistence
 */

import { writable, derived, get } from "svelte/store";
import { base } from "$app/paths";
import { env as publicEnv } from "$env/dynamic/public";
import { browser } from "$app/environment";
import type { MCPServer, ServerStatus, MCPTool } from "$lib/types/Tool";
import {
	initWasmMcp,
	callMcp as callWasmMcp,
	listGalleryTemplates,
	loadGalleryTemplate,
	activeTemplate,
} from "./wasmMcp";

// Namespace storage by app identity to avoid collisions across apps
function toKeyPart(s: string | undefined): string {
	return (s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

const appLabel = toKeyPart(publicEnv.PUBLIC_APP_ASSETS || publicEnv.PUBLIC_APP_NAME);
const baseLabel = toKeyPart(typeof base === "string" ? base : "");
// Final prefix format requested: "huggingchat:key" (no mcp:/chat)
const KEY_PREFIX = appLabel || baseLabel || "app";

const STORAGE_KEYS = {
	CUSTOM_SERVERS: `${KEY_PREFIX}:mcp:custom-servers`,
	SELECTED_IDS: `${KEY_PREFIX}:mcp:selected-ids`,
	DISABLED_BASE_IDS: `${KEY_PREFIX}:mcp:disabled-base-ids`,
} as const;

// WASM MCP Server ID (constant, always available)
export const WASM_SERVER_ID = "wasm-rvagent";

// Create the WASM MCP server entry
function createWasmServer(): MCPServer {
	return {
		id: WASM_SERVER_ID,
		name: "RVAgent Local (WASM)",
		url: "wasm://local",
		type: "wasm",
		status: "disconnected",
		isLocked: false,
		tools: [],
	};
}

// No migration needed per request — read/write only namespaced keys

// Load custom servers from localStorage
function loadCustomServers(): MCPServer[] {
	if (!browser) return [];

	try {
		const json = localStorage.getItem(STORAGE_KEYS.CUSTOM_SERVERS);
		return json ? JSON.parse(json) : [];
	} catch (error) {
		console.error("Failed to load custom MCP servers from localStorage:", error);
		return [];
	}
}

// Load selected server IDs from localStorage
function loadSelectedIds(): Set<string> {
	if (!browser) return new Set();

	try {
		const json = localStorage.getItem(STORAGE_KEYS.SELECTED_IDS);
		const ids: string[] = json ? JSON.parse(json) : [];
		return new Set(ids);
	} catch (error) {
		console.error("Failed to load selected MCP server IDs from localStorage:", error);
		return new Set();
	}
}

// Save custom servers to localStorage
function saveCustomServers(servers: MCPServer[]) {
	if (!browser) return;

	try {
		localStorage.setItem(STORAGE_KEYS.CUSTOM_SERVERS, JSON.stringify(servers));
	} catch (error) {
		console.error("Failed to save custom MCP servers to localStorage:", error);
	}
}

// Save selected IDs to localStorage
function saveSelectedIds(ids: Set<string>) {
	if (!browser) return;

	try {
		localStorage.setItem(STORAGE_KEYS.SELECTED_IDS, JSON.stringify([...ids]));
	} catch (error) {
		console.error("Failed to save selected MCP server IDs to localStorage:", error);
	}
}

// Load disabled base server IDs from localStorage (empty set if missing or on error)
function loadDisabledBaseIds(): Set<string> {
	if (!browser) return new Set();

	try {
		const json = localStorage.getItem(STORAGE_KEYS.DISABLED_BASE_IDS);
		return new Set(json ? JSON.parse(json) : []);
	} catch (error) {
		console.error("Failed to load disabled base MCP server IDs from localStorage:", error);
		return new Set();
	}
}

// Save disabled base server IDs to localStorage
function saveDisabledBaseIds(ids: Set<string>) {
	if (!browser) return;

	try {
		localStorage.setItem(STORAGE_KEYS.DISABLED_BASE_IDS, JSON.stringify([...ids]));
	} catch (error) {
		console.error("Failed to save disabled base MCP server IDs to localStorage:", error);
	}
}

// Store for all servers (base + custom)
export const allMcpServers = writable<MCPServer[]>([]);

// Track if initial server load has completed
export const mcpServersLoaded = writable<boolean>(false);

// Store for selected server IDs
export const selectedServerIds = writable<Set<string>>(loadSelectedIds());

// Auto-persist selected IDs when they change
if (browser) {
	selectedServerIds.subscribe((ids) => {
		saveSelectedIds(ids);
	});
}

// Derived store: only enabled servers
export const enabledServers = derived([allMcpServers, selectedServerIds], ([$all, $selected]) =>
	$all.filter((s) => $selected.has(s.id))
);

// Derived store: count of enabled servers
export const enabledServersCount = derived(enabledServers, ($enabled) => $enabled.length);

// Derived store: true if all base servers are enabled
export const allBaseServersEnabled = derived(
	[allMcpServers, selectedServerIds],
	([$all, $selected]) => {
		const baseServers = $all.filter((s) => s.type === "base");
		return baseServers.length > 0 && baseServers.every((s) => $selected.has(s.id));
	}
);

// Note: Authorization overlay (with user's HF token) for the Hugging Face MCP host
// is applied server-side when enabled via MCP_FORWARD_HF_USER_TOKEN.

/**
 * Refresh base servers from API and merge with custom servers + WASM server
 */
export async function refreshMcpServers() {
	try {
		const response = await fetch(`${base}/api/mcp/servers`);
		if (!response.ok) {
			throw new Error(`Failed to fetch base servers: ${response.statusText}`);
		}

		const baseServers: MCPServer[] = await response.json();
		const customServers = loadCustomServers();

		// Create WASM server and add to the list
		const wasmServer = createWasmServer();

		// Merge base, custom, and WASM servers
		const merged = [wasmServer, ...baseServers, ...customServers];
		allMcpServers.set(merged);

		// Load disabled base servers
		const disabledBaseIds = loadDisabledBaseIds();

		// Auto-enable all base servers that aren't explicitly disabled
		// Plus keep any custom servers that were previously selected
		// WASM server is auto-enabled by default
		const validIds = new Set(merged.map((s) => s.id));
		selectedServerIds.update(($currentIds) => {
			const newSelection = new Set<string>();

			// Auto-enable WASM server
			newSelection.add(WASM_SERVER_ID);

			// Add all base servers that aren't disabled
			for (const server of baseServers) {
				if (!disabledBaseIds.has(server.id)) {
					newSelection.add(server.id);
				}
			}

			// Keep custom servers that were selected and still exist
			for (const id of $currentIds) {
				if (validIds.has(id) && !id.startsWith("base-")) {
					newSelection.add(id);
				}
			}

			return newSelection;
		});
		mcpServersLoaded.set(true);

		// Initialize WASM MCP server in background
		initWasmServer();
	} catch (error) {
		console.error("Failed to refresh MCP servers:", error);
		// On error, use custom servers + WASM server
		const wasmServer = createWasmServer();
		allMcpServers.set([wasmServer, ...loadCustomServers()]);
		mcpServersLoaded.set(true);

		// Still try to init WASM
		initWasmServer();
	}
}

/**
 * Initialize the WASM MCP server
 */
async function initWasmServer() {
	if (!browser) return;

	updateServerStatus(WASM_SERVER_ID, "connecting");

	try {
		const success = await initWasmMcp();

		if (success) {
			// Get tools from WASM server
			const toolsResponse = await callWasmMcp("tools/list");
			const tools: MCPTool[] = [];

			if (!toolsResponse.error && toolsResponse.result) {
				const result = toolsResponse.result as { tools: MCPTool[] };
				if (result.tools) {
					tools.push(...result.tools);
				}
			}

			// Get active template info
			const template = get(activeTemplate);

			updateServerStatus(WASM_SERVER_ID, "connected", undefined, tools);

			// Update template info
			allMcpServers.update(($servers) =>
				$servers.map((s) =>
					s.id === WASM_SERVER_ID
						? {
								...s,
								wasmTemplateId: template.id || undefined,
								wasmTemplateName: template.name || undefined,
							}
						: s
				)
			);

			console.log(`[MCP] WASM server initialized with ${tools.length} tools`);
		} else {
			updateServerStatus(WASM_SERVER_ID, "error", "Failed to load WASM module");
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		updateServerStatus(WASM_SERVER_ID, "error", errorMessage);
		console.error("[MCP] WASM server initialization failed:", error);
	}
}

/**
 * Toggle a server on/off
 */
export function toggleServer(id: string) {
	selectedServerIds.update(($ids) => {
		const newSet = new Set($ids);
		if (newSet.has(id)) {
			newSet.delete(id);
			// Track if this is a base server being disabled
			if (id.startsWith("base-")) {
				const disabled = loadDisabledBaseIds();
				disabled.add(id);
				saveDisabledBaseIds(disabled);
			}
		} else {
			newSet.add(id);
			// Remove from disabled if re-enabling a base server
			if (id.startsWith("base-")) {
				const disabled = loadDisabledBaseIds();
				disabled.delete(id);
				saveDisabledBaseIds(disabled);
			}
		}
		return newSet;
	});
}

/**
 * Disable all MCP servers (marks all base servers as disabled)
 */
export function disableAllServers() {
	// Get current base server IDs and mark them all as disabled
	const servers = get(allMcpServers);
	const baseServerIds = servers.filter((s) => s.type === "base").map((s) => s.id);

	// Save all base servers as disabled
	saveDisabledBaseIds(new Set(baseServerIds));

	// Clear the selection
	selectedServerIds.set(new Set());
}

/**
 * Add a custom MCP server
 */
export function addCustomServer(server: Omit<MCPServer, "id" | "type" | "status">): string {
	const newServer: MCPServer = {
		...server,
		id: crypto.randomUUID(),
		type: "custom",
		status: "disconnected",
	};

	const customServers = loadCustomServers();
	customServers.push(newServer);
	saveCustomServers(customServers);

	// Refresh all servers to include the new one
	refreshMcpServers();

	return newServer.id;
}

/**
 * Update an existing custom server
 */
export function updateCustomServer(id: string, updates: Partial<MCPServer>) {
	const customServers = loadCustomServers();
	const index = customServers.findIndex((s) => s.id === id);

	if (index !== -1) {
		customServers[index] = { ...customServers[index], ...updates };
		saveCustomServers(customServers);
		refreshMcpServers();
	}
}

/**
 * Delete a custom server
 */
export function deleteCustomServer(id: string) {
	const customServers = loadCustomServers();
	const filtered = customServers.filter((s) => s.id !== id);
	saveCustomServers(filtered);

	// Also remove from selected IDs
	selectedServerIds.update(($ids) => {
		const newSet = new Set($ids);
		newSet.delete(id);
		return newSet;
	});

	refreshMcpServers();
}

/**
 * Update server status (from health check)
 */
export function updateServerStatus(
	id: string,
	status: ServerStatus,
	errorMessage?: string,
	tools?: MCPTool[],
	authRequired?: boolean
) {
	allMcpServers.update(($servers) =>
		$servers.map((s) =>
			s.id === id
				? {
						...s,
						status,
						errorMessage,
						tools,
						authRequired,
					}
				: s
		)
	);
}

/**
 * Run health check on a server
 */
export async function healthCheckServer(
	server: MCPServer
): Promise<{ ready: boolean; tools?: MCPTool[]; error?: string }> {
	// Handle WASM servers locally
	if (server.type === "wasm") {
		return healthCheckWasmServer();
	}

	try {
		updateServerStatus(server.id, "connecting");

		const response = await fetch(`${base}/api/mcp/health`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				server.type === "base"
					? { serverId: server.id }
					: { url: server.url, headers: server.headers }
			),
		});

		const result = await response.json();

		if (result.ready && result.tools) {
			updateServerStatus(server.id, "connected", undefined, result.tools, false);
			return { ready: true, tools: result.tools };
		} else {
			updateServerStatus(server.id, "error", result.error, undefined, Boolean(result.authRequired));
			return { ready: false, error: result.error };
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		updateServerStatus(server.id, "error", errorMessage);
		return { ready: false, error: errorMessage };
	}
}

/**
 * Health check for WASM MCP server (runs locally)
 */
async function healthCheckWasmServer(): Promise<{ ready: boolean; tools?: MCPTool[]; error?: string }> {
	try {
		updateServerStatus(WASM_SERVER_ID, "connecting");

		const success = await initWasmMcp();

		if (!success) {
			updateServerStatus(WASM_SERVER_ID, "error", "Failed to load WASM module");
			return { ready: false, error: "Failed to load WASM module" };
		}

		// Get tools from WASM server
		const toolsResponse = await callWasmMcp("tools/list");
		const tools: MCPTool[] = [];

		if (!toolsResponse.error && toolsResponse.result) {
			const result = toolsResponse.result as { tools: MCPTool[] };
			if (result.tools) {
				tools.push(...result.tools);
			}
		}

		// Get active template info
		const template = get(activeTemplate);

		updateServerStatus(WASM_SERVER_ID, "connected", undefined, tools);

		// Update template info
		allMcpServers.update(($servers) =>
			$servers.map((s) =>
				s.id === WASM_SERVER_ID
					? {
							...s,
							wasmTemplateId: template.id || undefined,
							wasmTemplateName: template.name || undefined,
						}
					: s
			)
		);

		return { ready: true, tools };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		updateServerStatus(WASM_SERVER_ID, "error", errorMessage);
		return { ready: false, error: errorMessage };
	}
}

/**
 * Load a gallery template for the WASM MCP server
 */
export async function loadWasmTemplate(templateId: string): Promise<boolean> {
	try {
		const success = await loadGalleryTemplate(templateId);

		if (success) {
			// Refresh tools after loading template
			await healthCheckWasmServer();
			return true;
		}

		return false;
	} catch (error) {
		console.error("[MCP] Failed to load WASM template:", error);
		return false;
	}
}

/**
 * Get available gallery templates for WASM server
 */
export function getWasmGalleryTemplates() {
	return listGalleryTemplates();
}

/**
 * Execute a tool on the WASM MCP server
 */
export async function executeWasmTool(
	name: string,
	args: Record<string, unknown>
): Promise<{ success: boolean; result?: unknown; error?: string }> {
	const response = await callWasmMcp("tools/call", { name, arguments: args });

	if (response.error) {
		return { success: false, error: response.error.message };
	}

	return { success: true, result: response.result };
}

// Initialize on module load
if (browser) {
	refreshMcpServers();
}
