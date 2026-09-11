import type { KeyValuePair } from "$lib/types/Tool";
import { isValidUrl } from "$lib/server/urlSafety";

export class HealthTargetError extends Error {}

interface HealthTarget {
	url: string;
	headers?: KeyValuePair[];
	configured: boolean;
}

/** The browser identifies a deployment connection; its credentials never make a round trip. */
export function resolveHealthTarget(body: unknown, configuredServers: string): HealthTarget {
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new HealthTargetError("Invalid health check request");
	const request = body as Record<string, unknown>;
	if (Object.hasOwn(request, "serverId")) {
		if (Object.keys(request).some((key) => key !== "serverId"))
			throw new HealthTargetError("Configured health checks accept only serverId");
		if (typeof request.serverId !== "string" || !request.serverId.startsWith("base-"))
			throw new HealthTargetError("Unknown configured MCP server");
		let entries: unknown;
		try {
			entries = JSON.parse(configuredServers || "[]");
		} catch {
			throw new HealthTargetError("Invalid MCP server configuration");
		}
		if (!Array.isArray(entries)) throw new HealthTargetError("Invalid MCP server configuration");
		const matches = entries.filter(
			(entry): entry is Record<string, unknown> =>
				entry !== null &&
				typeof entry === "object" &&
				!Array.isArray(entry) &&
				typeof entry.name === "string" &&
				`base-${entry.name}` === request.serverId
		);
		if (matches.length !== 1)
			throw new HealthTargetError("Unknown or ambiguous configured MCP server");
		const server = matches[0];
		if (typeof server.url !== "string")
			throw new HealthTargetError("Invalid MCP server configuration");
		try {
			const url = new URL(server.url);
			// Private HTTP is allowed only through this exact, operator-configured target.
			if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
				throw new Error();
		} catch {
			throw new HealthTargetError("Invalid MCP server configuration");
		}
		let headers: KeyValuePair[] | undefined;
		if (server.headers !== undefined) {
			if (!server.headers || typeof server.headers !== "object" || Array.isArray(server.headers))
				throw new HealthTargetError("Invalid MCP server configuration");
			headers = Object.entries(server.headers).map(([key, value]) => {
				if (typeof value !== "string")
					throw new HealthTargetError("Invalid MCP server configuration");
				return { key, value };
			});
		}
		return { url: server.url, headers, configured: true };
	}
	if (typeof request.url !== "string" || !request.url)
		throw new HealthTargetError("URL is required");
	// Preserve the existing custom-server protocol/IP validation, including local exceptions.
	if (!isValidUrl(request.url)) throw new HealthTargetError("Invalid or unsafe MCP URL");
	if (
		request.headers !== undefined &&
		(!Array.isArray(request.headers) ||
			request.headers.some(
				(header) =>
					!header ||
					typeof header !== "object" ||
					typeof header.key !== "string" ||
					typeof header.value !== "string"
			))
	)
		throw new HealthTargetError("Invalid custom MCP headers");
	return {
		url: request.url,
		headers: request.headers as KeyValuePair[] | undefined,
		configured: false,
	};
}
