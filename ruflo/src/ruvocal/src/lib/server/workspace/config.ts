import type { WorkspaceIntegration } from "$lib/types/Workspace";

export type WorkspaceEnvironment = Record<string, string | undefined>;

export interface IntegrationConfig {
	base: WorkspaceIntegration;
	url?: URL;
	token?: string;
}

const DEFINITIONS = [
	{ id: "ruflo", name: "Ruflo", key: "WORKSPACE_RUFLO_MCP_URL", kind: "mcp" },
	{ id: "metaharness", name: "MetaHarness", key: "WORKSPACE_METAHARNESS_MCP_URL", kind: "mcp" },
	{ id: "autogenous", name: "Autogenous", key: "WORKSPACE_AUTOGENOUS_MCP_URL", kind: "mcp" },
	{ id: "ruos", name: "ruOS", key: "WORKSPACE_RUOS_BASE_URL", kind: "http" },
] as const;

/** Deployment configuration is the only source of endpoints and credentials. */
export function readWorkspaceConfig(env: WorkspaceEnvironment): IntegrationConfig[] {
	return DEFINITIONS.map(({ id, name, key, kind }) => {
		// Ruflo exposes MetaHarness's actual flywheel status tool through its MCP registry.
		const configuredBy =
			id === "metaharness" && !env[key] && env.WORKSPACE_RUFLO_MCP_URL
				? "WORKSPACE_RUFLO_MCP_URL"
				: key;
		const raw = env[configuredBy]?.trim();
		const tokenKey = configuredBy.replace(/_(MCP_URL|BASE_URL)$/, "_TOKEN");
		const token = env[tokenKey]?.trim();
		const base: WorkspaceIntegration = {
			id,
			name,
			state: "not_configured",
			summary:
				id === "autogenous"
					? "No Autogenous adapter configured. Upstream provides a library, not a status service."
					: "Configure a server endpoint to observe this integration.",
			checkedAt: null,
			latencyMs: null,
			metrics: [],
			source: {
				kind,
				label: kind === "mcp" ? "MCP tool discovery" : "ruOS rendezvous service health",
				configuredBy,
				discoveryOnly: kind === "mcp",
			},
		};
		if (!raw) return { base };
		try {
			const url = new URL(raw);
			if (
				raw.length > 2048 ||
				!["https:", "http:"].includes(url.protocol) ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				(token && (token.length > 8192 || /[^\x21-\x7e]/.test(token)))
			) {
				throw new Error("Invalid deployment configuration");
			}
			if (id === "ruos") {
				url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v1/server/health`;
			}
			return { base, url, token };
		} catch {
			return {
				base: {
					...base,
					state: "degraded",
					summary: "Invalid server configuration. Review the private deployment settings.",
				},
			};
		}
	});
}
