import { describe, it, expect } from "vitest";
import { buildMissionDraft, discoveredTools, toolFamily } from "./workspace";
import type { MCPServer } from "$lib/types/Tool";

describe("mission drafts", () => {
	it("preserves the objective and explicitly separates instructions from authority", () => {
		const draft = buildMissionDraft("  Fix the mobile navigation  ", "build", 3);
		expect(draft).toMatch(/^Fix the mobile navigation\n/);
		expect(draft).toContain("Requested iteration limit: 3");
		expect(draft).toContain("do not grant permission or enforce runtime budgets");
		expect(draft).toContain("Do not expand authority, promote, publish or deploy");
	});
	it.each(["", "  ", "x".repeat(4001)])("rejects invalid objectives", (input) => {
		expect(() => buildMissionDraft(input, "review", 1)).toThrow();
	});
	it.each([0, 6, 1.5, NaN, Infinity])("rejects invalid iteration limits", (input) => {
		expect(() => buildMissionDraft("Inspect the source", "review", input)).toThrow();
	});
	it("keeps adversarial text as draft content without evaluating it", () => {
		const draft = buildMissionDraft('<script>alert("x")</script>', "review", 1);
		expect(decodeURIComponent(encodeURIComponent(draft))).toEqual(draft);
	});
});

describe("observed capabilities", () => {
	const server: MCPServer = {
		id: "base-ruflo",
		name: "Ruflo",
		url: "https://example.test/mcp",
		type: "base",
		status: "connected",
		tools: [{ name: "ruflo__policy_status" }, { name: "memory_stats" }],
	};
	it("does not invent schemas for a selected but undiscovered server", () => {
		expect(discoveredTools([{ ...server, tools: undefined }], new Set([server.id]))).toEqual([]);
	});
	it("distinguishes selection and connection", () => {
		const tools = discoveredTools([{ ...server, status: "error" }], new Set([server.id]));
		expect(tools.every((tool) => tool.selected && !tool.connected)).toBe(true);
	});
	it("deduplicates schemas and rejects malformed names before rendering keyed rows", () => {
		const tools = discoveredTools(
			[
				{
					...server,
					tools: [
						{ name: "memory_stats" },
						{ name: "memory_stats" },
						{ name: "" },
						{ name: 42 } as never,
						null as never,
					],
				},
			],
			new Set()
		);
		expect(tools.map((tool) => tool.name)).toEqual(["memory_stats"]);
	});

	it("keeps same-named tools on separate servers distinct", () => {
		const tools = discoveredTools([server, { ...server, id: "other" }], new Set());
		expect(new Set(tools.map((tool) => tool.id)).size).toBe(4);
	});
	it.each([
		["ruflo__metaharness_flywheel_status", "Governance"],
		["policy_status", "Governance"],
		["ruvector__memory_stats", "Memory"],
		["managed_agent_list", "Agents"],
		["hooks_intelligence_stats", "Learning"],
	])("classifies %s by original tool name", (tool, family) => {
		expect(toolFamily(tool)).toBe(family);
	});
});
