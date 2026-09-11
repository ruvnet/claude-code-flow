export { AgentFederationPlugin } from './plugin.js';

export { FederationNode, type FederationNodeProps, type FederationNodeCapabilities, type FederationNodeMetadata, type FederationNodeStateRecord } from './domain/entities/federation-node.js';
export {
  FederationNodeState,
  type SuspensionReason,
  type TransitionReason,
  canTransition,
  isCooldownElapsed,
  shouldAutoEvict,
  DEFAULT_SUSPENSION_COOLDOWN_MS,
  DEFAULT_AUTO_EVICTION_AGE_MS,
} from './domain/value-objects/federation-node-state.js';
export {
  FederationBreakerService,
  evaluatePolicy,
  DEFAULT_BREAKER_POLICY,
  DEFAULT_MAX_SAMPLES_PER_PEER,
  type BreakerPolicy,
  type BreakerDecision,
  type SendOutcome,
} from './application/federation-breaker-service.js';
export {
  InMemorySpendReporter,
  MemorySpendReporter,
  DEFAULT_FEDERATION_SPEND_NAMESPACE,
  DEFAULT_FEDERATION_SPEND_TTL_SECONDS,
  type SpendReporter,
  type MemoryStore,
  type MemorySpendReporterConfig,
  type FederationSpendEvent,
} from './application/spend-reporter.js';
export { FederationSession, type FederationSessionProps, type SessionMetrics } from './domain/entities/federation-session.js';
export {
  FederationEnvelope,
  type FederationEnvelopeProps,
  type FederationMessageType,
  type PIIScanResult,
  type PIIScanDetection,
  type PIIScanAction,
  CONSENSUS_REQUIRED_TYPES,
} from './domain/entities/federation-envelope.js';
export {
  TrustLevel,
  TRUST_TRANSITION_THRESHOLDS,
  CAPABILITY_GATES,
  isOperationAllowed,
  getTrustLevelLabel,
  type TrustTransitionThreshold,
} from './domain/entities/trust-level.js';

export {
  PIIPipelineService,
  type PIIType,
  type PIIAction,
  type PIIDetection,
  type PIIPolicyConfig,
  type PIICalibration,
  type PIITransformResult,
  type PIIConfidenceThresholds,
  type PIIPipelineServiceDeps,
} from './domain/services/pii-pipeline-service.js';
export {
  DiscoveryService,
  type DiscoveryMechanism,
  type FederationManifest,
  type DiscoveryServiceDeps,
  type DiscoveryConfig,
} from './domain/services/discovery-service.js';
export {
  HandshakeService,
  type HandshakeChallenge,
  type HandshakeChallengeResponse,
  type HandshakeResult,
  type HandshakeServiceDeps,
  type HandshakeConfig,
} from './domain/services/handshake-service.js';
export {
  RoutingService,
  type RoutingMode,
  type RoutingResult,
  type ConsensusProposal,
  type RoutingServiceDeps,
} from './domain/services/routing-service.js';
export {
  AuditService,
  type FederationAuditEvent,
  type FederationAuditEventType,
  type AuditSeverity,
  type AuditCategory,
  type ComplianceMode,
  type AuditQuery,
  type AuditExportFormat,
  type AuditServiceDeps,
  type AuditServiceConfig,
} from './domain/services/audit-service.js';

export {
  TrustEvaluator,
  type TrustScoreComponents,
  type TrustTransitionResult,
  type ImmediateDowngradeReason,
  type TrustEvaluatorDeps,
} from './application/trust-evaluator.js';
export {
  FederationCoordinator,
  type FederationCoordinatorConfig,
  type FederationStatus,
} from './application/federation-coordinator.js';
export {
  PolicyEngine,
  type FederationClaimType,
  type SecurityPolicy,
  type PolicyEvaluationResult,
  type PolicyEngineDeps,
} from './application/policy-engine.js';
export {
  createFederationClaimChecker,
  type FederationAuthorizationMode,
  type FederationClaimChecker,
  type FederationClaimCheckerConfig,
} from './application/claim-checker.js';
export {
  composeLatentRoles,
  type ComposedLatentRole,
  type LatentRoleCandidate,
  type LatentRoleComposeRequest,
  type LatentRoleFallback,
  type LatentRoleRoute,
} from './application/latent-role-composer.js';
export {
  DEFAULT_ENVELOPE_SIGNATURE_MODE,
  JCS_SIGNATURE_PROTOCOL,
  canonicalizeEnvelopeForVerify,
  isLegacyEnvelopeTypeAllowed,
  selectEnvelopeSignatureVersion,
  type EnvelopeSignatureMode,
  type EnvelopeSignatureVersion,
} from './application/inbound-dispatcher.js';
export { FEDERATION_PLUGIN_VERSION } from './version.js';

// A2A (Agent2Agent, Linux Foundation) Agent Card adapter — cards only.
export {
  A2A_PROTOCOL_VERSION,
  A2A_WELL_KNOWN_PATH,
  RUFLO_FEDERATION_BINDING,
  RUFLO_FEDERATION_EXTENSION_URI,
  toAgentCard,
  fromAgentCard,
  validateAgentCard,
  type A2AAgentCard,
  type A2AAgentInterface,
  type A2AAgentSkill,
  type A2AAgentCapabilities,
  type A2AAgentExtension,
  type A2AAgentProvider,
  type ToAgentCardOptions,
  type AgentCardValidation,
} from './a2a/agent-card.js';
export {
  startAgentCardServer,
  isLoopbackHost,
  type AgentCardServerOptions,
  type AgentCardServerHandle,
} from './a2a/well-known.js';
export {
  fetchAgentCard,
  consumeAgentCard,
  resolveAgentCardUrl,
  type FetchAgentCardOptions,
  type FetchAgentCardResult,
} from './a2a/consume.js';
