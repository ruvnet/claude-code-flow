import type {
  BudgetLimit,
  PolicyApproval,
  PolicyRequest,
  PolicyRule,
  PolicyState,
} from '@claude-flow/security';
import type { MCPTool } from './types.js';
import {
  evaluatePolicyRequest,
  issuePolicyApproval,
  loadPolicyState,
  revokePolicyApproval,
  setPolicyBudget,
  setPolicyMode,
  upsertPolicyRule,
  verifyPolicyLedger,
} from '../services/policy-runtime.js';

function requireAuthenticatedAdministrator(
  context: Record<string, unknown> | undefined,
): asserts context is Record<string, unknown> & { principalId: string; principalType: 'user' } {
  if (context?.principalType !== 'user' || typeof context.principalId !== 'string') {
    throw new Error('policy administration requires an authenticated user context');
  }
}

// #2894: `input.request` was cast straight to `PolicyRequest` with no
// validation, so a missing/malformed `request` argument (including the
// documented `policy_evaluate {}` repro) flowed all the way into
// `AgenticPolicyEngine.evaluate()`, which unconditionally reads
// `request.requestId` — crashing with a bare
// "Cannot read properties of undefined (reading 'requestId')" TypeError
// that surfaced to MCP clients as an opaque JSON-RPC -32603. Validate the
// shape here so a missing/malformed request is a clear, catchable error
// instead of an internal crash.
function requireWellFormedPolicyRequest(
  input: Record<string, unknown>,
): asserts input is Record<string, unknown> & { request: PolicyRequest } {
  const { request } = input;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(
      "policy_evaluate requires a `request` object argument (e.g. { request: { identity, action } }), not top-level fields",
    );
  }
  const { identity, action } = request as Record<string, unknown>;
  if (!identity || typeof identity !== 'object') {
    throw new Error('policy_evaluate requires `request.identity` ({ id, type })');
  }
  if (!action || typeof action !== 'object') {
    throw new Error('policy_evaluate requires `request.action` ({ type, resource, ... })');
  }
}

export const policyTools: MCPTool[] = [
  {
    name: 'policy_evaluate',
    description: 'Evaluate an agent action against ADR-324 policy and persist a tamper-evident decision receipt. Use when a consequential tool, deployment, network, spend, or promotion action needs authorization.',
    category: 'security',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'object', description: 'Policy request containing identity, action, and optional evidence/envelope context' },
      },
      required: ['request'],
    },
    handler: async (input, context) => {
      requireWellFormedPolicyRequest(input);
      return evaluatePolicyRequest(
        input.request,
        typeof context?.projectRoot === 'string' ? context.projectRoot : process.cwd(),
      );
    },
  },
  {
    name: 'policy_status',
    description: 'Inspect policy mode, migration state, rules, budgets, approvals, and ledger integrity. Use when diagnosing whether an installation is in compatibility, observation, or enforcement mode.',
    category: 'security',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_input, context) => {
      const root = typeof context?.projectRoot === 'string' ? context.projectRoot : process.cwd();
      const state = loadPolicyState(root);
      return {
        version: state.version,
        mode: state.mode,
        migratedFrom: state.migratedFrom,
        counts: {
          rules: state.rules.length,
          budgets: state.budgets.length,
          approvals: state.approvals.length,
          receipts: state.receipts.length,
        },
        ledger: await verifyPolicyLedger(root),
      };
    },
  },
  {
    name: 'policy_rule_upsert',
    description: 'Create or update a versioned agentic policy rule. Use when defining explicit allow, deny, or human-approval requirements; existing installations remain unchanged until rules and enforcement mode are configured.',
    category: 'security',
    inputSchema: {
      type: 'object',
      properties: {
        rule: { type: 'object' },
        mode: { type: 'string', enum: ['legacy', 'observe', 'enforce'] },
      },
      required: ['rule'],
    },
    handler: async (input, context) => {
      requireAuthenticatedAdministrator(context);
      const root = typeof context?.projectRoot === 'string' ? context.projectRoot : process.cwd();
      await upsertPolicyRule(input.rule as PolicyRule, root);
      if (input.mode) await setPolicyMode(input.mode as PolicyState['mode'], root);
      return { success: true, ruleId: (input.rule as PolicyRule).id, mode: loadPolicyState(root).mode };
    },
  },
  {
    name: 'policy_budget_set',
    description: 'Create or update an atomic USD/token ceiling for a principal, action, and resource window. Use when constraining agent spend; budget checks and decision receipts commit under the same policy-state lock.',
    category: 'security',
    inputSchema: {
      type: 'object',
      properties: {
        budget: { type: 'object' },
      },
      required: ['budget'],
    },
    handler: async (input, context) => {
      requireAuthenticatedAdministrator(context);
      const budget = input.budget as BudgetLimit;
      await setPolicyBudget(
        budget,
        typeof context?.projectRoot === 'string' ? context.projectRoot : process.cwd(),
      );
      return { success: true, budgetId: budget.id };
    },
  },
  {
    name: 'policy_approve',
    description: 'Issue a scoped, expiring, limited-use human approval. Use when policy_evaluate returns approval_required; self-approval is rejected.',
    category: 'security',
    inputSchema: {
      type: 'object',
      properties: {
        approval: { type: 'object' },
      },
      required: ['approval'],
    },
    handler: async (input, context) => {
      requireAuthenticatedAdministrator(context);
      const requested = input.approval as Omit<PolicyApproval, 'uses' | 'issuedAt' | 'issuedBy'>
        & { uses?: number; issuedAt?: number };
      return issuePolicyApproval(
        { ...requested, issuedBy: context.principalId },
        typeof context.projectRoot === 'string' ? context.projectRoot : process.cwd(),
        (issuer) => issuer === context.principalId,
      );
    },
  },
  {
    name: 'policy_revoke',
    description: 'Revoke an outstanding policy approval immediately. Use when responding to an incident or when a previously approved action is no longer authorized.',
    category: 'security',
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string' },
      },
      required: ['approvalId'],
    },
    handler: async (input, context) => {
      requireAuthenticatedAdministrator(context);
      return {
        success: await revokePolicyApproval(
          String(input.approvalId),
          typeof context.projectRoot === 'string' ? context.projectRoot : process.cwd(),
        ),
      };
    },
  },
];
