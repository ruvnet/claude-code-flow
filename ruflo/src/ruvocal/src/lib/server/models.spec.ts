import { describe, it, expect, beforeAll } from "vitest";
import type {
	listSchema as ListSchema,
	deriveSupportsTools as DeriveSupportsTools,
} from "./models";

// models.ts performs a top-level `await rebuildModels()` on import (it fetches
// `${OPENAI_BASE_URL}/models` eagerly so the model registry is warm at
// startup). We stub `fetch` with an empty-but-valid response before importing
// so the module loads without hitting the network, then grab the two pure
// exports under test.
let listSchema: typeof ListSchema;
let deriveSupportsTools: typeof DeriveSupportsTools;

beforeAll(async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ data: [{ id: "startup-placeholder-model" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
	try {
		const mod = await import("./models");
		listSchema = mod.listSchema;
		deriveSupportsTools = mod.deriveSupportsTools;
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// Regression coverage for #2900: "MCP silently disabled for every model when
// OPENAI_BASE_URL is not HuggingFace's router".
//
// Root cause was two-layered:
//   1. `supportsTools` was derived only from `providers[].supports_tools`,
//      which is an HF-router-specific shape. Any other OpenAI-compatible
//      provider (e.g. one that reports `capabilities.tool_calling`) always
//      resolved to `supportsTools = false`.
//   2. Even after widening the derivation, the per-model zod schema stripped
//      any field it didn't know about (no `.passthrough()`), so a generic
//      provider's `capabilities` field never reached the derivation logic in
//      the first place.
describe("models.ts — supportsTools derivation (#2900)", () => {
	describe("deriveSupportsTools", () => {
		it("returns true for the HF-router shape (providers[].supports_tools) — unchanged behavior", () => {
			expect(
				deriveSupportsTools({
					providers: [{ supports_tools: false }, { supports_tools: true }],
				})
			).toBe(true);
		});

		it("returns false for the HF-router shape when no provider supports tools", () => {
			expect(
				deriveSupportsTools({
					providers: [{ supports_tools: false }, { supports_tools: undefined }],
				})
			).toBe(false);
		});

		it("returns true for a generic OpenAI-compatible capabilities.tool_calling signal", () => {
			expect(
				deriveSupportsTools({
					providers: undefined,
					capabilities: { tool_calling: true },
				})
			).toBe(true);
		});

		it("fails closed when neither providers nor capabilities advertise tool support", () => {
			expect(
				deriveSupportsTools({
					providers: undefined,
					capabilities: { tool_calling: false },
				})
			).toBe(false);
			expect(deriveSupportsTools({})).toBe(false);
		});
	});

	describe("listSchema parsing", () => {
		it("preserves providers[].supports_tools for the HF-router shape", () => {
			const parsed = listSchema.parse({
				data: [
					{
						id: "hf-model",
						providers: [{ provider: "together", supports_tools: true }],
					},
				],
			});
			expect(deriveSupportsTools(parsed.data[0])).toBe(true);
		});

		it("preserves a generic capabilities.tool_calling field instead of stripping it", () => {
			// This is the exact shape from the issue report: an OpenAI-compatible
			// provider with no `providers` array at all.
			const parsed = listSchema.parse({
				data: [
					{
						id: "generic-model",
						capabilities: { tool_calling: true },
					},
				],
			});
			expect(parsed.data[0].capabilities?.tool_calling).toBe(true);
			expect(deriveSupportsTools(parsed.data[0])).toBe(true);
		});

		it("end-to-end: a full generic OpenAI-compatible /models response resolves supportsTools per model", () => {
			const parsed = listSchema.parse({
				data: [
					{ id: "tool-model", capabilities: { tool_calling: true } },
					{ id: "no-tool-model", capabilities: { tool_calling: false } },
					{ id: "no-capabilities-model" },
				],
			});
			const results = Object.fromEntries(parsed.data.map((m) => [m.id, deriveSupportsTools(m)]));
			expect(results).toEqual({
				"tool-model": true,
				"no-tool-model": false,
				"no-capabilities-model": false,
			});
		});
	});
});
