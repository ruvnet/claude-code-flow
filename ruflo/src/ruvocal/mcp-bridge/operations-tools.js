/** ADR-042: opt-in, exact-name inspection surface. No mutation family prefixes. */
export const OPERATIONS_TOOL_NAMES = Object.freeze([
  "mcp_status",
  "managed_agent_list",
  "managed_agent_status",
  "autopilot_status",
  "policy_status",
  "ruvllm_status",
  "metaharness_flywheel_status",
]);

export function createOperationsGroup(env = process.env) {
  return {
    enabled: env.MCP_GROUP_OPERATIONS === "true",
    description: "Read-only runtime, managed-agent, policy, and evolution status",
    source: "ruflo",
    exactNames: OPERATIONS_TOOL_NAMES,
  };
}

/** A missing selector retains legacy wildcard behavior; an empty selector does not. */
export function toolMatchesGroup(tool, group) {
  if (!group?.enabled || tool._backend !== group.source) return false;
  if (group.exactNames?.includes(tool._originalName)) return true;
  if (group.prefixes?.some(prefix => tool._originalName.startsWith(prefix))) return true;
  return group.exactNames === undefined && group.prefixes === undefined;
}

const EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false };

function operationSchema(name) {
  if (name === "managed_agent_list") {
    return {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    };
  }
  if (name === "managed_agent_status") {
    return {
      type: "object",
      properties: { sessionId: { type: "string", minLength: 1, maxLength: 256 } },
      required: ["sessionId"],
      additionalProperties: false,
    };
  }
  return { ...EMPTY_INPUT };
}

/** Only synthesize the wrapper when the real upstream tool was discovered. */
export function projectBackendTools(tools, backendName) {
  if (backendName !== "ruflo") return tools;
  const projected = tools
    .filter(tool => tool._originalName !== "metaharness_flywheel_status")
    .map(tool => OPERATIONS_TOOL_NAMES.includes(tool._originalName)
      ? { ...tool, inputSchema: operationSchema(tool._originalName) }
      : tool);
  if (tools.some(tool => tool._originalName === "metaharness_flywheel")) {
    projected.push({
      name: "metaharness_flywheel_status",
      _originalName: "metaharness_flywheel_status",
      _backend: "ruflo",
      description: "Inspect the current project's MetaHarness evolution state and receipt-ledger integrity. Accepts no arguments; never runs or promotes a candidate.",
      inputSchema: operationSchema("metaharness_flywheel_status"),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    });
  }
  return projected;
}

/** Revalidate in the common executor; discovery schemas alone are not authorization. */
export function backendInvocation(tool, args) {
  const name = tool._originalName;
  if (tool._backend !== "ruflo" || !OPERATIONS_TOOL_NAMES.includes(name)) {
    return { name, arguments: args };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Operations tool arguments must be an object");
  }
  const allowed = name === "managed_agent_list" ? ["limit"]
    : name === "managed_agent_status" ? ["sessionId"] : [];
  if (Object.keys(args).some(key => !allowed.includes(key))) {
    throw new Error("Unsupported operations tool argument");
  }
  if (name === "managed_agent_list" && args.limit !== undefined &&
      (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) {
    throw new Error("limit must be an integer from 1 to 200");
  }
  if (name === "managed_agent_status" &&
      (typeof args.sessionId !== "string" || !args.sessionId.trim() || args.sessionId.length > 256)) {
    throw new Error("sessionId must be a nonempty string of at most 256 characters");
  }
  if (name === "metaharness_flywheel_status") {
    return { name: "metaharness_flywheel", arguments: { operation: "status" } };
  }
  return { name, arguments: { ...args } };
}
