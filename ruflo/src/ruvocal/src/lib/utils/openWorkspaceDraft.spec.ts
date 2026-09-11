import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
vi.mock("$app/paths", () => ({ base: "/flo" }));
vi.mock("$app/navigation", () => ({ goto: vi.fn().mockResolvedValue(undefined) }));
import { goto } from "$app/navigation";
import { pendingChatInput } from "$lib/stores/pendingChatInput";
import { openWorkspaceDraft } from "./openWorkspaceDraft";
import { buildMissionDraft } from "./workspace";

beforeEach(() => {
	vi.mocked(goto).mockReset().mockResolvedValue(undefined);
	pendingChatInput.set(undefined);
});
describe("local draft handoff", () => {
	it("preserves 4,000 Unicode characters without putting them in a URL", async () => {
		const draft = buildMissionDraft("語".repeat(4000), "build", 3);
		await openWorkspaceDraft(draft);
		expect(goto).toHaveBeenCalledWith("/flo/");
		expect(get(pendingChatInput)).toEqual(draft);
	});
	it("clears an unconsumed handoff on failed navigation", async () => {
		vi.mocked(goto).mockRejectedValueOnce(new Error("Navigation failed"));
		await expect(openWorkspaceDraft("local draft")).rejects.toThrow("Navigation failed");
		expect(get(pendingChatInput)).toBeUndefined();
	});
});
