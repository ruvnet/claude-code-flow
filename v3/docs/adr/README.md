# Claude Flow V3 - Architecture Decision Records

All ADRs are located in [`/v3/implementation/adrs/`](../../implementation/adrs/).

## Quick Links

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](../../implementation/adrs/ADR-001-AGENT-IMPLEMENTATION.md) | Adopt agentic-flow as Core Foundation | Complete |
| [ADR-002](../../implementation/adrs/ADR-002-DDD-STRUCTURE.md) | Domain-Driven Design Structure | Complete |
| [ADR-003](../../implementation/adrs/ADR-003-CONSOLIDATION-COMPLETE.md) | Single Coordination Engine | Complete |
| [ADR-004](../../implementation/adrs/ADR-004-PLUGIN-ARCHITECTURE.md) | Plugin Architecture | Complete |
| [ADR-005](../../implementation/adrs/ADR-005-implementation-summary.md) | MCP-First API Design | Complete |
| [ADR-006](../../implementation/adrs/ADR-006-UNIFIED-MEMORY.md) | Unified Memory Service | Complete |
| [ADR-007](../../implementation/adrs/ADR-007-EVENT-SOURCING.md) | Event Sourcing | Complete |
| [ADR-008](../../implementation/adrs/ADR-008-VITEST.md) | Vitest Testing | Complete |
| [ADR-009](../../implementation/adrs/ADR-009-IMPLEMENTATION.md) | Hybrid Memory Backend | Complete |
| [ADR-010](../../implementation/adrs/ADR-010-NODE-ONLY.md) | Node.js Only | Complete |
| [ADR-011](../../implementation/adrs/ADR-011-llm-provider-system.md) | LLM Provider System | Complete |
| [ADR-012](../../implementation/adrs/ADR-012-mcp-security-features.md) | MCP Security Features | Complete |
| [ADR-013](../../implementation/adrs/ADR-013-core-security-module.md) | Core Security Module | Complete |
| [ADR-014](../../implementation/adrs/ADR-014-workers-system.md) | Workers System | Complete |
| [ADR-015](../../implementation/adrs/ADR-015-unified-plugin-system.md) | Unified Plugin System | Complete |
| [ADR-016](../../implementation/adrs/ADR-016-collaborative-issue-claims.md) | Collaborative Issue Claims | Complete |
| [ADR-017](../../implementation/adrs/ADR-017-ruvector-integration.md) | RuVector Integration | Complete |
| [ADR-018](../../implementation/adrs/ADR-018-claude-code-integration.md) | Claude Code Integration | Complete |
| [ADR-019](../../implementation/adrs/ADR-019-headless-runtime-package.md) | Headless Runtime Package | Complete |
| [ADR-020](../../implementation/adrs/ADR-020-headless-worker-integration.md) | Headless Worker Integration | Complete |
| [ADR-046](../../implementation/adrs/ADR-046-ruflo-rebrand.md) | Dual Umbrella: claude-flow + ruflo | Accepted |
| [ADR-047](../../implementation/adrs/ADR-047-fast-mode-integration.md) | Fast Mode Integration | Proposed |
| [ADR-178](ADR-178-dream-cycle-security-vmg-repe-ipi.md) | Verifiable Memory Governance and RepE IPI Detection | Proposed |
| [ADR-301](ADR-301-promotional-status-surface.md) | Promotional Status Surface for CLI Runtime | Proposed |
| [ADR-302](ADR-302-post-init-capability-enrollment.md) | Post-Initialization Capability Enrollment | Proposed |
| [ADR-303](ADR-303-credit-exhaustion-experience.md) | Intelligent Credit Exhaustion Experience | Proposed |
| [ADR-304](ADR-304-local-meta-llm-proxy.md) | Local Meta LLM Proxy Product | Proposed |
| [ADR-305](ADR-305-customer-lifecycle-funnel.md) | Customer Lifecycle Funnel (RuFlo → Cognitum) | Proposed |
| [ADR-306](ADR-306-cognitum-authentication-account-linking.md) | Cognitum Authentication and Account Linking | Proposed |
| [ADR-307](ADR-307-proxy-runtime-packaging-lifecycle.md) | Proxy Runtime, Packaging, and Service Lifecycle | Proposed |
| [ADR-308](ADR-308-cognitum-public-api-contract.md) | Cognitum Public API and Server Contract | Proposed |
| [ADR-309](ADR-309-funnel-governance-privacy-ecosystem.md) | Funnel Governance, Privacy, and Ecosystem Policy | Proposed |
| [ADR-310](ADR-310-funnel-rollout-measurement-emergency-controls.md) | Funnel Rollout, Measurement, and Emergency Controls | Proposed |
| [ADR-320](ADR-320-mcp-composition-inspector-channel-guardrails.md) | MCP Tool Composition Inspector + Inter-Agent Channel Guardrails | Accepted |
| [ADR-323](ADR-323-typed-memory-provenance.md) | Typed Memory Provenance in AgentDB (MemIR-style claim typing, corrects #2804's dream-cycle proposal) | Accepted |
| [ADR-324](ADR-324-agentic-policy-engine-codex-swarm.md) | Agentic Policy Engine and Policy-Governed Codex Swarms | Accepted |
| [ADR-325](ADR-325-claim-federation-zero-trust-capability-plane.md) | Claim Federation as a Zero-Trust Capability and Work-Ownership Plane | Proposed |
| [ADR-326](ADR-326-cognitum-product-plane-claim-federation.md) | Cognitum Product-Plane Claim Federation Profile | Proposed |
| [ADR-327](ADR-327-federated-concurrent-development-harness.md) | Federated Concurrent Development Harness | Proposed |
| [ADR-328](ADR-328-cognitum-assisted-agent-learning.md) | Cognitum-Assisted Agent Learning Capability Plane | Proposed |
| [ADR-329](ADR-329-ruflo-capability-brain-mcp-guidance.md) | Ruflo Capability Brain for MCP Guidance | Accepted |
| [ADR-330](ADR-330-adaptive-pheromone-swarm-consensus.md) | Adaptive Pheromone Swarm Consensus | Accepted |
| [ADR-331](ADR-331-project-local-flywheel-anchors.md) | Project-Local Flywheel Evaluation Anchors | Accepted |
| [ADR-332](ADR-332-hermetic-release-verification-runtime-baseline.md) | Hermetic Release Verification and Supported Runtime Baseline | Accepted |
| [ADR-333](ADR-333-efficiency-first-orchestration-prehoc-failure-inference.md) | Efficiency-First Orchestration — Pre-hoc Failure Inference and Adaptive Agent Count Routing | Proposed |
| [ADR-334](ADR-334-hierarchical-consensus-topology.md) | Hierarchical Consensus Topology for Large-Scale Swarm Coordination | Proposed |
| [ADR-335](ADR-335-mv-hnsw-agent-memory-upgrade.md) | Upgrade to Multi-Vector HNSW (MV-HNSW) for Agent Memory Retrieval | Proposed |
| [ADR-336](ADR-336-agent-authorization-propagation.md) | Agent Authorization Propagation and MCP Authentication Enforcement | Proposed |
| [ADR-337](ADR-337-plugin-supply-chain-integrity-memory-governance.md) | Plugin Supply Chain Integrity and Memory Namespace Governance | Proposed |
| [ADR-338](ADR-338-sona-behavioral-trajectory-auditing.md) | SONA Behavioral Trajectory Auditing via Embedding-Space Trait Vectors | Proposed |
| [ADR-339](ADR-339-memory-integrity-mcp-verification.md) | Memory Write Integrity Validation & MCP Tool Verification | Proposed |
| [ADR-340](ADR-340-retrospective-harness-optimization.md) | Retrospective Harness Optimization (RHO) for SONA Intelligence Loop | Proposed |
| [ADR-341](ADR-341-multi-signal-memory-retrieval.md) | Multi-Signal Memory Retrieval | Proposed |
| [ADR-342](ADR-342-dream-cycle-ruvector-production-scale-backend.md) | RuVector Production-Scale Backend Adoption | Proposed |
| [ADR-343](ADR-343-shared-context-parallel-dispatch.md) | Shared-Context Parallel Dispatch for Multi-Agent Performance | Proposed |
| [ADR-344](ADR-344-knowledge-graph-index-for-reasoningbank.md) | Knowledge Graph Index for ReasoningBank | Proposed |
| [ADR-345](ADR-345-swarm-credit-routing-shapley.md) | Swarm Credit Routing via Shapley-Value Attribution | Proposed |
| [ADR-346](ADR-346-multi-layer-agent-security.md) | Multi-Layer Agent Security Stack | Proposed |
| [ADR-347](ADR-347-trajectory-quality-judge-scoring.md) | Trajectory-Quality JUDGE Scoring for ReasoningBank | Proposed |
| [ADR-348](ADR-348-dream-cycle-swarm-adaptive-topology-selector.md) | Task-Adaptive Swarm Topology Selector | Proposed |
| [ADR-349](ADR-349-dream-cycle-intelligence-flare-lookahead.md) | FLARE-Style Lookahead Planning Buffer for SONA Intelligence Layer | Proposed |
| [ADR-350](ADR-350-dream-cycle-swarm-trust-weighted-consensus.md) | Trust-Weighted Consensus for Swarm Coordination | Proposed |
| [ADR-351](ADR-351-dream-cycle-performance-stateful-execution-loop.md) | Stateful Execution Loop with KV-Cache Discipline and Agent Execution Graphs | Proposed |
| [ADR-352](ADR-352-mcp-tool-permission-attestation.md) | MCP Tool Permission Attestation (Min-Privilege Contract) | Proposed |
| [ADR-353](ADR-353-dream-cycle-intelligence-skill-distillation.md) | Trace-to-Skill Distillation for Intelligence Pipeline | Proposed |
| [ADR-354](ADR-354-agentdb-write-verification-temporal-supersession.md) | AgentDB Memory Write Verification and Temporal Supersession Layer | Proposed |
| [ADR-355](ADR-355-swarm-rl-stopping-policy.md) | Reinforcement-Learned Stopping Policy for Ruflo Swarm Orchestration | Proposed |
| [ADR-356](ADR-356-dream-cycle-performance-cross-agent-kvcache.md) | Cross-Agent KV-Cache Sharing for Swarm Performance | Proposed |
| [ADR-357](ADR-357-dream-cycle-intelligence-dimension-aware-routing.md) | Dimension-Aware Intelligence Routing for Heterogeneous Agent Pools | Proposed |
| [ADR-358](ADR-358-automem-memory-rl-training-loop.md) | AutoMem-Style RL Training Loop for AgentDB Memory Operations | Proposed |
| [ADR-359](ADR-359-swarm-inverse-wisdom-dissent-mechanism.md) | Swarm Dissent Mechanism: Inverse-Wisdom Law Compliance | Proposed |
| [ADR-360](ADR-360-dream-cycle-performance-polykv-shared-kv-pool.md) | Cross-Agent Shared KV Pool (PolyKV Architecture) | Proposed |
| [ADR-361](ADR-361-dream-cycle-intelligence-skill-evolution-worker.md) | Skill Evolution Worker (SEW) — Runtime RL-Based Skill Acquisition for SONA | Proposed |
| [ADR-362](ADR-362-dream-cycle-swarm-hnsw-comms-fabric.md) | HNSW-as-Communication-Fabric (HCF) for RuVector Swarm Knowledge Gossip | Proposed |
| [ADR-363](ADR-363-dream-cycle-performance-workflow-atomic-inference-scheduling.md) | Workflow-Atomic Inference Scheduling (WAIS) for Multi-Agent Execution | Proposed |
| [ADR-364](ADR-364-dream-cycle-security-plugin-supply-chain-scanner.md) | Plugin Supply-Chain Scanner and Behavioral Manifest | Proposed |
| [ADR-365](ADR-365-recurrence-gated-memory-consolidation.md) | Recurrence-Gated Memory Consolidation for AgentDB | Proposed |
| [ADR-366](ADR-366-dream-cycle-swarm-self-evolving-skill-distillation.md) | Self-Evolving Swarm Skill Distillation via Trajectory Feedback | Proposed |
| [ADR-367](ADR-367-epistemic-working-memory-intelligence-pipeline.md) | Epistemic Working Memory in the Intelligence Pipeline | Proposed |
| [ADR-368](ADR-368-dream-cycle-memory-selective-persistence.md) | Selective Persistent Memory Categories for AgentDB | Proposed |
| [ADR-369](ADR-369-dream-cycle-swarm-ib-vq-inter-agent-messaging.md) | Information-Bottleneck Vector-Quantized Inter-Agent Messaging | Proposed |
| [ADR-370](ADR-370-dream-cycle-performance-world-model-agent-planning.md) | World-Model Agent Planning for Cost-Aware Task Pre-Simulation | Proposed |
| [ADR-371](ADR-371-dream-cycle-security-neural-cryptographic-authorization.md) | Neural Cryptographic Authorization Gate for Agentic Action Execution | Proposed |
| [ADR-372](ADR-372-dream-cycle-intelligence-cognitive-mode-router.md) | Cognitive Mode Router for Agent Memory Query Dispatch | Proposed |
| [ADR-373](ADR-373-dream-cycle-memory-budget-operator-selection.md) | Budget-Dependent Memory Operator Selection (OAS) | Proposed |
| [ADR-374](ADR-374-dream-cycle-swarm-subagent-permission-delegate.md) | SubagentPermissionDelegate: Workspace-Scoped Privilege Delegation for Swarm Agents | Proposed |
| [ADR-375](ADR-375-dream-cycle-performance-agentperf-benchmark-mixture-of-agents.md) | Agentic Inference Benchmarking Standard + Mixture-of-Agents Test-Time Scaling | Proposed |
| [ADR-376](ADR-376-dream-cycle-intelligence-heterogeneous-ensemble-api.md) | Heterogeneous Agent Ensemble Composition API | Proposed |
| [ADR-377](ADR-377-agentdb-retrieval-security.md) | AgentDB Retrieval Security Layer | Proposed |
| [ADR-378](ADR-378-npm-trusted-publishing-cicd.md) | npm Trusted Publishing for CI/CD Release Automation | Proposed |
| [ADR-379](ADR-379-statusline-optional-usage-segments.md) | Optional Context/Session/Week Usage Segments and Extra Statusline Lines | Proposed |
| [ADR-380](ADR-380-agntcy-outshift-runtime-integration.md) | AGNTCY/Outshift Runtime Integration: SLIM Transport, CASA Enforcement, IOC Coordination Events | Proposed |

## Summary Documents

- [ADR Status Summary](../../implementation/adrs/ADR-STATUS-SUMMARY.md) - Implementation status overview
- [V3 ADRs Master](../../implementation/adrs/v3-adrs.md) - Complete ADR document
- [Full README](../../implementation/adrs/README.md) - Detailed index with roadmap

## Performance Targets

| Metric | Target | Status |
|--------|--------|--------|
| HNSW Search | 150x-12,500x faster | ✅ Achieved |
| Flash Attention | 2.49x-7.47x speedup | ✅ Achieved (alpha.102) |
| Memory Reduction | 50-75% | ✅ Achieved |
| MCP Response | <100ms | ✅ Achieved |
| CLI Startup | <500ms | ✅ Achieved |

## Neural Features (alpha.102+)

| Component | Status | Lines | Notes |
|-----------|--------|-------|-------|
| SONA Optimizer | ✅ Real | 841 | Pattern learning from trajectories |
| EWC++ Consolidation | ✅ Real | ~600 | Fisher matrix, prevents forgetting |
| MoE Router | ✅ Real | ~500 | 8 experts with gating network |
| Flash Attention | ✅ Real | ~500 | O(N) block attention |
| LoRA Adapter | ✅ Real | ~400 | 128x compression (rank=8) |
| Hyperbolic Embeddings | ✅ Real | - | Poincaré ball model |
| Int8 Quantization | ✅ Real | - | 3.92x memory savings |

## Security Status

| CVE | Severity | Status |
|-----|----------|--------|
| CVE-2 | Critical | ✅ Fixed |
| CVE-3 | Critical | ✅ Fixed |
| HIGH-1 | High | ✅ Fixed |
| HIGH-2 | High | ✅ Fixed |

**Security Score:** 10/10

---

| [ADR-131](ADR-131-dream-cycle-security-tool-output-guardrail.md) | Tool-Output Semantic Guardrail (Indirect Prompt Injection) | Proposed |

**Last Updated:** 2026-05-26
**CLI Version:** @claude-flow/cli@3.7.x
