import { beforeEach, describe, expect, it, vi } from "vitest";

const { createWorkspaceSnapshot } = vi.hoisted(() => ({ createWorkspaceSnapshot: vi.fn() }));
vi.mock("./snapshot", () => ({ createWorkspaceSnapshot }));

import { GET } from "../../../routes/api/workspace/+server";

function event(
	options: { session?: boolean; admin?: boolean; headers?: HeadersInit; query?: string } = {}
) {
	const url = new URL(`https://ruflo.example.test/api/workspace${options.query ?? ""}`);
	return {
		url,
		request: new Request(url, { headers: options.headers }),
		locals: {
			sessionId: options.session === false ? "" : "session",
			isAdmin: options.admin ?? false,
		},
	} as Parameters<typeof GET>[0];
}

beforeEach(() => {
	createWorkspaceSnapshot.mockReset();
	createWorkspaceSnapshot.mockResolvedValue({
		schemaVersion: 1,
		checkedAt: "2026-09-05T12:00:00.000Z",
		integrations: [],
	});
});

describe("GET /api/workspace", () => {
	it("rejects a missing session with 401 before reading runtime state", async () => {
		await expect(GET(event({ session: false }))).rejects.toMatchObject({ status: 401 });
		expect(createWorkspaceSnapshot).not.toHaveBeenCalled();
	});

	it("rejects an ordinary signed-in user with 403 before reading runtime state", async () => {
		await expect(GET(event())).rejects.toMatchObject({ status: 403 });
		expect(createWorkspaceSnapshot).not.toHaveBeenCalled();
	});

	it.each<Record<string, string>>([
		{ origin: "https://attacker.example.test" },
		{ "sec-fetch-site": "cross-site" },
		{ "sec-fetch-site": "same-site" },
	])("rejects cross-origin admin requests", async (headers) => {
		await expect(GET(event({ admin: true, headers }))).rejects.toMatchObject({ status: 403 });
		expect(createWorkspaceSnapshot).not.toHaveBeenCalled();
	});

	it("does not permit user supplied endpoint or tool arguments", async () => {
		await expect(
			GET(event({ admin: true, query: "?url=http://metadata.internal&operation=promote" }))
		).rejects.toMatchObject({ status: 400 });
		expect(createWorkspaceSnapshot).not.toHaveBeenCalled();
	});

	it("returns same-origin admin observations without allowing shared caching", async () => {
		const response = await GET(
			event({
				admin: true,
				headers: { origin: "https://ruflo.example.test", "sec-fetch-site": "same-origin" },
			})
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(await response.json()).toMatchObject({ schemaVersion: 1 });
		expect(createWorkspaceSnapshot).toHaveBeenCalledTimes(1);
	});
});
