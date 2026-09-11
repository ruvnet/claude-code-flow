import { env } from "$env/dynamic/private";
import { error, json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/api/utils/requireAuth";
import { createWorkspaceSnapshot } from "$lib/server/workspace/snapshot";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, request, url }) => {
	// Reject before reading deployment configuration or opening any outbound connection.
	requireAdmin(locals);
	const origin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	if ((origin && origin !== url.origin) || (site && !["same-origin", "none"].includes(site))) {
		error(403, "Same origin access required");
	}
	if (url.search) error(400, "Workspace observation does not accept query parameters");
	const snapshot = await createWorkspaceSnapshot(env);
	return json(snapshot, {
		headers: {
			"Cache-Control": "private, no-store",
			Vary: "Cookie, Origin, Sec-Fetch-Site",
			"X-Content-Type-Options": "nosniff",
		},
	});
};
