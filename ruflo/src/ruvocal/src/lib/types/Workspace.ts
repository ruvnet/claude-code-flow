export type WorkspaceIntegrationId = "ruflo" | "metaharness" | "autogenous" | "ruos";

export type WorkspaceIntegrationState = "not_configured" | "available" | "degraded" | "unreachable";

/** Only normalized, explicitly allowed fields cross the server boundary. */
export interface WorkspaceIntegration {
	id: WorkspaceIntegrationId;
	name: string;
	state: WorkspaceIntegrationState;
	summary: string;
	checkedAt: string | null;
	latencyMs: number | null;
	toolCount?: number;
	metrics: { label: string; value: string | number }[];
	source: {
		kind: "mcp" | "http";
		label: string;
		configuredBy: string;
		discoveryOnly: boolean;
	};
}

export interface WorkspaceSnapshot {
	schemaVersion: 1;
	checkedAt: string;
	integrations: WorkspaceIntegration[];
}
