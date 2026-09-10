/**
 * MCP Tools Index for CLI
 *
 * Re-exports all tool definitions for use within the CLI package.
 */

export type { MCPTool, MCPToolInputSchema, MCPToolResult } from './types.js';
export { agentTools } from './agent-tools.js';
export { swarmTools } from './swarm-tools.js';
export { memoryTools } from './memory-tools.js';
export { configTools } from './config-tools.js';
export { hooksTools } from './hooks-tools.js';
export { taskTools } from './task-tools.js';
export { sessionTools } from './session-tools.js';
export { hiveMindTools } from './hive-mind-tools.js';
export { workflowTools } from './workflow-tools.js';
export { coverageRouterTools } from '../ruvector/coverage-tools.js';
export { analyzeTools } from './analyze-tools.js';
export { progressTools } from './progress-tools.js';
export { transferTools } from './transfer-tools.js';
export { securityTools } from './security-tools.js';
export { embeddingsTools } from './embeddings-tools.js';
export { claimsTools } from './claims-tools.js';
export { policyTools } from './policy-tools.js';
export { wasmAgentTools } from './wasm-agent-tools.js';
export { ruvllmWasmTools } from './ruvllm-tools.js';
export {
  configureGuidanceToolProvider,
  guidanceTools,
} from './guidance-tools.js';
export {
  buildCapabilityBrain,
  CAPABILITY_DOMAINS,
  classifyCapabilityTool,
  IMPLEMENTATION_LOOP,
  recommendCapabilities,
  RUFLO_CLI_COMMANDS,
} from './capability-brain.js';
export type {
  AvailabilityState,
  CapabilityAuthority,
  CapabilityBrain,
  CapabilityDomain,
  CapabilityDomainDefinition,
  CapabilityHealth,
  CapabilityMaturity,
  CapabilityRecommendation,
  CapabilityRisk,
  CapabilityToolMetadata,
  ImplementationLoopStep,
} from './capability-brain.js';
export { autopilotTools } from './autopilot-tools.js';
// ADR-150 — MetaHarness MCP tools (score / genome / mcp-scan / threat-model / oia-audit)
export { metaharnessTools } from './metaharness-tools.js';
// ADR-175-inspired — Test-Driven Repair via headless `claude -p`
export { testgenTools } from './testgen-tools.js';
// agenticow@~0.2.3 — Copy-On-Write memory branching (162-byte branches)
export { agenticowTools } from './agenticow-tools.js';
// agenticow step 4 — speculative branch-and-promote (A/B memory exploration)
export { agenticowSpeculateTools } from './agenticow-speculate-tools.js';
// ADR-164 — AgentBBS federated business-domain BBS rooms (Phase 1)
export { agentbbsTools } from './agentbbs-tools.js';
export { xFederationTools } from './x-federation-tools.js';
export { seraphinaTools } from './seraphina-tools.js';
export { xFederationJoinTools } from './x-federation-join.js';
export { xFederationChannelTools } from './x-federation-channels.js';
// ADR-164 Phase 2 — Business-pod template validation
export { businessPodTools } from './business-pod-tools.js';
// ADR-164 Phase 4 §5.1.8 — http_fetch (secure-by-default HTTP probe)
export { httpFetchTools } from './http-fetch-tools.js';
