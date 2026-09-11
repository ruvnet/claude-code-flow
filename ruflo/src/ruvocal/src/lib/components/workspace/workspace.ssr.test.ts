import { afterEach, describe, it, expect, vi } from "vitest";
import { render } from "svelte/server";
import { writable, type Writable } from "svelte/store";
import type { MCPServer } from "$lib/types/Tool";
import { allMcpServers } from "$lib/stores/mcpServers";
vi.mock("$app/paths", () => ({ base: "/flo" }));
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/state", () => ({ page: { url: new URL("http://example.test/flo/workspace") } }));
vi.mock("$lib/stores/mcpServers", () => ({
	allMcpServers: writable([]),
	selectedServerIds: writable(new Set()),
	enabledServersCount: writable(0),
	toggleServer: vi.fn(),
	healthCheckServer: vi.fn(),
	addCustomServer: vi.fn(),
	refreshMcpServers: vi.fn(),
}));
import Workspace from "../../../routes/workspace/+page.svelte";
import RuntimePanel from "./RuntimePanel.svelte";
import ToolExplorer from "./ToolExplorer.svelte";

const mockServers = allMcpServers as Writable<MCPServer[]>;
afterEach(() => mockServers.set([]));

describe("workspace server rendering", () => {
	it("works with no models, tools, or conversations and offers no fake runtime counts", () => {
		const { body } = render(Workspace, {
			props: { data: { models: [], conversations: [] } } as never,
		});
		expect(body).toContain("Intent into action.");
		expect(body).toContain("Configure a model before drafting");
		expect(body).toContain("No mission is running.");
		expect(body).toContain('href="/flo/models"');
		expect(body).not.toContain("NaN");
	});
	it("renders integrations as unchecked until observed", () => {
		const { body } = render(RuntimePanel);
		expect(body.match(/Not checked/g) || []).toHaveLength(4);
		expect(body).toContain("Requires an operator supplied MCP adapter");
		expect(body).toContain("Not evaluated");
		expect(body).not.toContain("ws-good");
	});
	it("distinguishes an unknown inventory from a successfully discovered empty inventory", () => {
		mockServers.set(
			(["disconnected", "connecting", "error", "connected"] as const).map((status) => ({
				id: status,
				name: status,
				url: "https://example.test/mcp",
				type: "custom",
				status,
				isLocked: false,
				tools: [],
			}))
		);
		const { body } = render(ToolExplorer);
		expect(body.match(/Inventory unavailable/g) || []).toHaveLength(3);
		expect(body.match(/0 discovered tools/g) || []).toHaveLength(1);
	});
});
