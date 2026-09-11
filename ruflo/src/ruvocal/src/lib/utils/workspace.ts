import type { MCPServer, MCPTool } from "$lib/types/Tool";

export const missionPresets = [
	{
		id: "build",
		title: "Build a feature",
		detail: "Specification, implementation, validation",
		objective: "Implement a feature with a clear acceptance test.",
		icon: "build",
	},
	{
		id: "review",
		title: "Review a repository",
		detail: "Find risks and prioritize fixes",
		objective:
			"Review a repository. Rank confirmed defects by impact and propose the smallest verifiable fixes.",
		icon: "review",
	},
	{
		id: "optimize",
		title: "Optimize with evidence",
		detail: "Measure a baseline, test a candidate",
		objective:
			"Measure a baseline, propose a bounded improvement, and compare the candidate against the same acceptance tests.",
		icon: "optimize",
	},
] as const;

export type MissionKind = (typeof missionPresets)[number]["id"];

/** These are instructions for a chat draft, never runtime policy or authorization. */
export function buildMissionDraft(
	objective: string,
	kind: MissionKind,
	iterations: number
): string {
	const trimmed = objective.trim();
	if (!trimmed || trimmed.length > 4000)
		throw new Error("Enter an objective of 1 to 4,000 characters.");
	if (!missionPresets.some((preset) => preset.id === kind))
		throw new Error("Unknown mission type.");
	if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5)
		throw new Error("Choose 1 to 5 iterations.");
	return `${trimmed}\n\nMission: ${kind}. Requested iteration limit: ${iterations}.\nInspect available tools and repository instructions first. State inputs, outputs, constraints and an executable acceptance test. Use Ruflo for coordination, MetaHarness for evaluation, and Autogenous where a verified adapter is available. Distinguish configured, reachable and authorized capabilities. Record architecture decisions when needed. Measure the same baseline and candidate, retain failure evidence, and stop after the requested iteration limit or a repeated failure. These instructions do not grant permission or enforce runtime budgets. Do not expand authority, promote, publish or deploy without the required approval.`;
}

export function toolFamily(name: string): string {
	name = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
	if (/^(metaharness_|policy_|audit_)/.test(name)) return "Governance";
	if (/^(memory_|agentdb_|embeddings_|ruvector_)/.test(name)) return "Memory";
	if (/^(agent_|managed_agent_|swarm_|task_|hive_|autopilot_)/.test(name)) return "Agents";
	if (/^(hooks_|neural_|learning_|ruvllm_)/.test(name)) return "Learning";
	return "Tools";
}

/** Only observed tool schemas enter the inventory. Selection is not health. */
export function discoveredTools(servers: MCPServer[], selected: Set<string>) {
	const seen = new Set<string>();
	return servers
		.flatMap((server) => {
			const schemas = Array.isArray(server.tools) ? server.tools : [];
			return schemas
				.slice(0, 1024)
				.filter((tool): tool is MCPTool => {
					if (
						!tool ||
						typeof tool.name !== "string" ||
						!/^[A-Za-z0-9_.:/-]{1,128}$/.test(tool.name)
					)
						return false;
					const id = `${server.id}:${tool.name}`;
					if (seen.has(id)) return false;
					seen.add(id);
					return true;
				})
				.map((tool) => ({
					...tool,
					description:
						typeof tool.description === "string" ? tool.description.slice(0, 4000) : undefined,
					id: `${server.id}:${tool.name}`,
					serverId: server.id,
					serverName: server.name,
					family: toolFamily(tool.name),
					selected: selected.has(server.id),
					connected: server.status === "connected",
				}));
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.serverId.localeCompare(b.serverId));
}
