/**
 * Funnel release-gate invariants — ADR-301..310.
 *
 * Every test here maps to a hard gate in ADR-310:
 *   - promo output in CI: 0
 *   - promotional display before disclosure: 0
 *   - control-sequence injection through message copy: 0
 *   - lower-precedence source re-enabling a higher disable: 0
 *   - credit-recovery on anything but COGNITUM_CREDIT_EXHAUSTED: 0
 *   - funnel events without telemetry consent: 0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isValidMessage,
  isAllowedUrl,
  containsForbiddenSequences,
  displayWidth,
  MESSAGES,
  MAX_MESSAGE_COLUMNS,
} from '../src/funnel/messages.js';
import {
  selectMessage,
  ROTATION_SLOT_MS,
  PROMO_SLOT_MODULO,
  PROMO_REPEAT_CAP_MS,
} from '../src/funnel/rotation.js';
import { resolveFunnelEnabled } from '../src/funnel/precedence.js';
import {
  DISCLOSURE_GRACE_MS,
  DISCLOSURE_ROTATION_SLOT_MS,
  getDisclosure,
  promoEligible,
  recordDisclosureDeclined,
  recordDisclosureShown,
  selectDisclosureMessage,
} from '../src/funnel/disclosure.js';
import { getConsent, hasConsent, recordConsent } from '../src/funnel/consent.js';
import { CONSENT_POLICY_VERSION, CreditErrorCode } from '../src/funnel/types.js';
import {
  classifyCreditError,
  shouldShowCreditRecovery,
  renderCreditRecovery,
} from '../src/funnel/credit-errors.js';
import { getFunnelId, recordFunnelEvent, deleteFunnelData } from '../src/funnel/events.js';
import { attributionUrl } from '../src/funnel/attribution.js';
import {
  flushEvents,
  DEFAULT_ENDPOINT,
  MAX_BATCH,
  MIN_FLUSH_INTERVAL_MS,
  FLUSH_TIMEOUT_MS,
} from '../src/funnel/event-transport.js';
import {
  markCreditExhausted,
  clearCreditStatus,
  readCreditStatus,
  creditExhaustedNotice,
} from '../src/funnel/credit-notifier.js';
import { getFunnelPromo } from '../src/funnel/promo.js';
import { isCI } from '../src/funnel/environment.js';
import {
  RATE_LIMIT_TTL_MS,
  clearRateLimitStatus,
  markRateLimited,
  rateLimitNotice,
  readRateLimitStatus,
} from '../src/funnel/rate-limit-notifier.js';
import {
  QUOTA_LOW_TTL_MS,
  clearQuotaLowStatus,
  markQuotaLow,
  quotaLowNotice,
  readQuotaLowStatus,
} from '../src/funnel/power-saver-notifier.js';
import { TOGGLE_COOLDOWN_MS, cooldownActive, cooldownRemainingMin } from '../src/funnel/toggle-cooldown.js';
import { computeLocalInsights, selectLocalInsight } from '../src/funnel/insights.js';
import { shouldOfferEnrollment, recordEnrollmentOutcome, getEnrollmentRecord } from '../src/funnel/enrollment.js';
import { generateStatuslineScript } from '../src/init/statusline-generator.js';

let stateDir: string;
let savedEnv: NodeJS.ProcessEnv;

const CLEAN_ENV_KEYS = [
  'RUFLO_FUNNEL', 'RUFLO_ENTERPRISE_POLICY', 'CI', 'GITHUB_ACTIONS', 'GITLAB_CI',
  'CIRCLECI', 'TRAVIS', 'BUILDKITE', 'JENKINS_URL', 'TEAMCITY_VERSION', 'TF_BUILD',
];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-test-'));
  savedEnv = { ...process.env };
  process.env.RUFLO_STATE_DIR = stateDir;
  for (const k of CLEAN_ENV_KEYS) delete process.env[k];
});

/**
 * Seed the local remote-message cache exactly the way message-transport.ts's
 * writeCache() would after a successful GET /v1/messages. The remote pool is
 * authoritative and overrides the in-code seed pool by id, so tests that need
 * remote-specific content seed this cache; cold-start tests deliberately do not.
 */
function seedRemoteMessages(messages: unknown[]): void {
  fs.writeFileSync(
    path.join(stateDir, 'funnel-messages-cache.json'),
    JSON.stringify({ _ts: Date.now(), messages }),
    'utf-8',
  );
}

const TEST_DISCLOSURE_POOL = [
  { id: 'disclosure-1', schemaVersion: 1, class: 'disclosure', text: '✨ Tips, features and Cognitum updates here · manage: ruflo settings', url: 'https://cognitum.one/ruflo' },
  { id: 'disclosure-2', schemaVersion: 1, class: 'disclosure', text: '✨ Additional AI capabilities from Cognitum · manage: ruflo settings', url: 'https://cognitum.one/ruflo' },
  { id: 'disclosure-3', schemaVersion: 1, class: 'disclosure', text: '✨ Tips and Cognitum updates appear here · manage: ruflo settings', url: 'https://cognitum.one/ruflo' },
];

const TEST_ROTATION_POOL = [
  { id: 'edu-test-1', schemaVersion: 1, class: 'educational', text: 'edu tip one' },
  { id: 'edu-test-2', schemaVersion: 1, class: 'educational', text: 'edu tip two' },
  { id: 'edu-test-3', schemaVersion: 1, class: 'educational', text: 'edu tip three' },
  { id: 'edu-test-4', schemaVersion: 1, class: 'educational', text: 'edu tip four' },
  { id: 'promo-test-1', schemaVersion: 1, class: 'promotional', text: 'promo one', url: 'https://cognitum.one' },
];

afterEach(() => {
  process.env = savedEnv;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// ─── ADR-301: signed content boundaries ─────────────────────────────────────

describe('message content boundaries (ADR-301)', () => {
  const base = { id: 'test', schemaVersion: 1 as const, class: 'educational' as const };

  it('accepts a plain valid message', () => {
    expect(isValidMessage({ ...base, text: 'hello world' })).toBe(true);
  });

  it('drops ANSI escape sequences', () => {
    expect(isValidMessage({ ...base, text: 'hi \u001b[31mred\u001b[0m' })).toBe(false);
  });

  it('drops OSC sequences (terminal title / hyperlink injection)', () => {
    expect(isValidMessage({ ...base, text: 'x\u001b]0;pwned\u0007' })).toBe(false);
  });

  it('drops C0/C1 control characters', () => {
    expect(isValidMessage({ ...base, text: 'a\u0008b' })).toBe(false);
    expect(isValidMessage({ ...base, text: 'a\u009bb' })).toBe(false);
  });

  it('drops bidirectional override characters', () => {
    expect(isValidMessage({ ...base, text: 'a‮evil' })).toBe(false);
    expect(isValidMessage({ ...base, text: 'a⁦evil⁩' })).toBe(false);
  });

  it('drops over-length messages instead of truncating', () => {
    expect(isValidMessage({ ...base, text: 'x'.repeat(MAX_MESSAGE_COLUMNS + 1) })).toBe(false);
    expect(isValidMessage({ ...base, text: 'x'.repeat(MAX_MESSAGE_COLUMNS) })).toBe(true);
  });

  it('counts wide characters as 2 columns', () => {
    expect(displayWidth('あ')).toBe(2);
    expect(displayWidth('ab')).toBe(2);
    // 41 CJK chars = 82 display columns > 80 even though length is 41
    expect(isValidMessage({ ...base, text: 'あ'.repeat(41) })).toBe(false);
  });

  it('drops wrong schema version and bad class', () => {
    expect(isValidMessage({ ...base, schemaVersion: 2, text: 'x' })).toBe(false);
    expect(isValidMessage({ ...base, class: 'urgent', text: 'x' })).toBe(false);
  });

  it('drops expired messages', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isValidMessage({ ...base, text: 'x', expiresAt: past })).toBe(false);
  });

  it('URL allowlist: exact hosts only, https only, no lookalikes', () => {
    expect(isAllowedUrl('https://cognitum.one/routing')).toBe(true);
    expect(isAllowedUrl('https://github.com/ruvnet/ruflo')).toBe(true);
    expect(isAllowedUrl('http://cognitum.one')).toBe(false); // not https
    expect(isAllowedUrl('https://cognitum.one.evil.com')).toBe(false); // lookalike
    expect(isAllowedUrl('https://evilcognitum.one')).toBe(false);
    expect(isAllowedUrl('https://github.com/attacker/repo')).toBe(false); // wrong org
    expect(isAllowedUrl('https://1.2.3.4/')).toBe(false); // IP literal
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedUrl('not a url')).toBe(false);
  });

  it('ships a bounded, self-validating local seed pool (cold-start fallback)', () => {
    expect(MESSAGES.length).toBeGreaterThan(0);
    for (const message of MESSAGES) expect(isValidMessage(message)).toBe(true);
    expect(MESSAGES.filter((message) => message.class === 'disclosure')).toHaveLength(1);
    expect(MESSAGES.filter((message) => message.class === 'promotional')).toHaveLength(1);
    expect(MESSAGES.every((message) => message.id.startsWith('local.'))).toBe(true);
  });

  it('a disclosure-class message without the manage tail is rejected, never repaired', () => {
    const base = { id: 'disclosure-x', schemaVersion: 1 as const, class: 'disclosure' as const };
    expect(isValidMessage({ ...base, text: '✨ Missing the tail entirely' })).toBe(false);
    expect(isValidMessage({ ...base, text: '✨ Has it · manage: ruflo settings' })).toBe(true);
  });

  it('selectDisclosureMessage uses the local seed disclosure on cold start', () => {
    const message = selectDisclosureMessage(new Date());
    expect(message).not.toBeNull();
    expect(message!.id).toBe('local.disclosure.v1');
    expect(message!.class).toBe('disclosure');
  });

  it('selectDisclosureMessage is deterministic per 5-minute slot once seeded', () => {
    seedRemoteMessages(TEST_DISCLOSURE_POOL);
    const t0 = new Date('2026-07-10T12:00:00.000Z');
    const t0plus1s = new Date(t0.getTime() + 1000);
    expect(selectDisclosureMessage(t0)?.id).toBe(selectDisclosureMessage(t0plus1s)?.id);
    const poolSize =
      TEST_DISCLOSURE_POOL.length + MESSAGES.filter((message) => message.class === 'disclosure').length;
    const seen = new Set<string>();
    for (let i = 0; i < poolSize * 2; i++) {
      seen.add(selectDisclosureMessage(new Date(t0.getTime() + i * DISCLOSURE_ROTATION_SLOT_MS))?.id ?? '');
    }
    expect(seen.size).toBe(poolSize);
  });
});

// ─── ADR-301: rotation ratio ────────────────────────────────────────────────

describe('rotation scheduler (ADR-301 content ratio)', () => {
  it('uses bounded local seed content when no remote pool is cached', () => {
    const message = selectMessage(new Date());
    expect(message).not.toBeNull();
    expect(message!.id.startsWith('local.')).toBe(true);
    expect(['educational', 'promotional']).toContain(message!.class);
  });

  it('promotional content appears only in 1-of-5 slots and honors the 30-min cap', () => {
    seedRemoteMessages(TEST_ROTATION_POOL);
    const base = Date.UTC(2026, 6, 10, 12, 0, 0);
    let promos = 0;
    let educational = 0;
    const slots = 200; // 200 slots × 20s ≈ 66 minutes
    for (let i = 0; i < slots; i++) {
      const now = new Date(base + i * ROTATION_SLOT_MS);
      const msg = selectMessage(now);
      expect(msg).not.toBeNull();
      if (msg!.class === 'promotional') {
        promos++;
        // structural ratio: promo only in the designated slot
        const slot = Math.floor(now.getTime() / ROTATION_SLOT_MS);
        expect(slot % PROMO_SLOT_MODULO).toBe(PROMO_SLOT_MODULO - 1);
      } else {
        educational++;
      }
    }
    // 30-min repeat cap over ~66 minutes → at most 3 promos
    const maxPromos = Math.floor((slots * ROTATION_SLOT_MS) / PROMO_REPEAT_CAP_MS) + 1;
    expect(promos).toBeLessThanOrEqual(maxPromos);
    expect(promos).toBeGreaterThan(0);
    // ratio: far better than 4:1
    expect(educational / Math.max(promos, 1)).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic for a fixed time slot', () => {
    seedRemoteMessages(TEST_ROTATION_POOL);
    const now = new Date(Date.UTC(2026, 6, 10, 12, 0, 1));
    const a = selectMessage(now);
    const b = selectMessage(now);
    expect(a?.id).toBe(b?.id);
  });
});

// ─── ADR-305: control precedence ────────────────────────────────────────────

describe('control precedence (ADR-305)', () => {
  it('defaults to enabled by package default', () => {
    expect(resolveFunnelEnabled(stateDir)).toEqual({ enabled: true, decidedBy: 'package-default' });
  });

  it('RUFLO_FUNNEL=0 disables at the top of the chain', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE']) {
      expect(resolveFunnelEnabled(stateDir, { ...process.env, RUFLO_FUNNEL: v }).decidedBy).toBe('env');
    }
  });

  it('enterprise policy disables below env', () => {
    const policyFile = path.join(stateDir, 'policy.json');
    fs.writeFileSync(policyFile, JSON.stringify({ funnel: { enabled: false } }));
    const decision = resolveFunnelEnabled(stateDir, { ...process.env, RUFLO_ENTERPRISE_POLICY: policyFile });
    expect(decision).toEqual({ enabled: false, decidedBy: 'enterprise-policy' });
  });

  it('a lower-precedence source never re-enables a higher-precedence disable', () => {
    // user config says enabled=true, env says off → env wins
    fs.writeFileSync(path.join(stateDir, 'funnel.json'), JSON.stringify({ enabled: true }));
    const decision = resolveFunnelEnabled(stateDir, { ...process.env, RUFLO_FUNNEL: '0' });
    expect(decision.enabled).toBe(false);
    expect(decision.decidedBy).toBe('env');
  });

  it('user config disable wins over project config and default', () => {
    fs.writeFileSync(path.join(stateDir, 'funnel.json'), JSON.stringify({ enabled: false }));
    expect(resolveFunnelEnabled(stateDir).decidedBy).toBe('user-config');
  });

  it('project claude-flow.config.json funnel.enabled=false disables', () => {
    fs.writeFileSync(path.join(stateDir, 'claude-flow.config.json'), JSON.stringify({ funnel: { enabled: false } }));
    expect(resolveFunnelEnabled(stateDir).decidedBy).toBe('project-config');
  });

  it('a stored remote policy can disable but sits at the bottom', () => {
    fs.writeFileSync(path.join(stateDir, 'funnel-remote-policy.json'), JSON.stringify({ funnelEnabled: false }));
    expect(resolveFunnelEnabled(stateDir).decidedBy).toBe('remote-policy');
    // remote enable=true must NOT override user disable
    fs.writeFileSync(path.join(stateDir, 'funnel-remote-policy.json'), JSON.stringify({ funnelEnabled: true }));
    fs.writeFileSync(path.join(stateDir, 'funnel.json'), JSON.stringify({ enabled: false }));
    expect(resolveFunnelEnabled(stateDir).decidedBy).toBe('user-config');
  });
});

// ─── ADR-301: disclosure gate ───────────────────────────────────────────────

describe('disclosure gate (ADR-301)', () => {
  it('starts never_seen; no promo before disclosure', () => {
    expect(getDisclosure().state).toBe('never_seen');
    expect(promoEligible()).toBe(false);
  });

  it('first render records disclosed_enabled but promo waits for the grace window', () => {
    const t0 = new Date();
    recordDisclosureShown(t0);
    expect(getDisclosure().state).toBe('disclosed_enabled');
    expect(promoEligible(t0)).toBe(false);
    expect(promoEligible(new Date(t0.getTime() + DISCLOSURE_GRACE_MS - 1000))).toBe(false);
    expect(promoEligible(new Date(t0.getTime() + DISCLOSURE_GRACE_MS + 1000))).toBe(true);
  });

  it('declining disables all funnel surfaces through the precedence chain', () => {
    recordDisclosureDeclined();
    expect(getDisclosure().state).toBe('disclosed_disabled');
    expect(promoEligible()).toBe(false);
    expect(resolveFunnelEnabled(stateDir)).toEqual({ enabled: false, decidedBy: 'disclosure-declined' });
  });
});

// ─── ADR-301/305: promo orchestrator gates ──────────────────────────────────

describe('promo orchestrator (getFunnelPromo)', () => {
  it('renders nothing in CI regardless of state', () => {
    expect(getFunnelPromo({ interactive: true, env: { ...process.env, CI: 'true' } })).toBeNull();
    expect(getFunnelPromo({ interactive: true, env: { ...process.env, GITHUB_ACTIONS: 'true' } })).toBeNull();
  });

  it('renders nothing when not interactive', () => {
    expect(getFunnelPromo({ interactive: false })).toBeNull();
  });

  it('renders nothing when disabled by any precedence source', () => {
    expect(getFunnelPromo({ interactive: true, env: { ...process.env, RUFLO_FUNNEL: '0' } })).toBeNull();
  });

  it('first render uses the local seed disclosure when no remote pool is cached', () => {
    const row = getFunnelPromo({ interactive: true, cwd: stateDir });
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('disclosure');
    expect(row!.text).toBe(
      'Ruflo shows occasional tips and sponsor notes here · manage: ruflo settings',
    );
  });

  it('first interactive render is the disclosure, never a promotion', () => {
    seedRemoteMessages(TEST_DISCLOSURE_POOL);
    const now = new Date(Date.UTC(2026, 6, 10, 12, 0, 0));
    const row = getFunnelPromo({ interactive: true, cwd: stateDir, now });
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('disclosure');
    // Row text is one of the seeded disclosure variants.
    expect(TEST_DISCLOSURE_POOL.map((m) => m.text)).toContain(row!.text);
    // The URL is click-tracked (routes through the server redirect) — the
    // real cognitum.one/ruflo target rides in the `to` query param.
    expect(row!.url).toBeDefined();
    const outer = new URL(row!.url!);
    expect(outer.pathname).toMatch(/^\/v1\/click\/disclosure-\d+$/);
    const to = outer.searchParams.get('to');
    expect(to).toBeTruthy();
    const parsed = new URL(to!);
    expect(parsed.origin + parsed.pathname).toBe('https://cognitum.one/ruflo');
    expect(parsed.searchParams.get('utm_source')).toBe('ruflo');
    expect(parsed.searchParams.get('utm_medium')).toBe('statusline');
    expect(parsed.searchParams.get('utm_campaign')).toBe('disclosure');
    expect(parsed.searchParams.get('utm_content')).toMatch(/^disclosure-\d+$/);
    // Without telemetry consent (default in this test suite), no fid rides along.
    expect(parsed.searchParams.get('fid')).toBeNull();
  });

  it('keeps showing the disclosure through the grace window, then rotates messages', () => {
    seedRemoteMessages([...TEST_DISCLOSURE_POOL, ...TEST_ROTATION_POOL]);
    const t0 = new Date(Date.UTC(2026, 6, 10, 12, 0, 0));
    recordDisclosureShown(t0);
    const during = getFunnelPromo({ interactive: true, cwd: stateDir, now: new Date(t0.getTime() + 1000) });
    expect(during!.kind).toBe('disclosure');
    const after = getFunnelPromo({
      interactive: true,
      cwd: stateDir,
      now: new Date(t0.getTime() + DISCLOSURE_GRACE_MS + 60_000),
    });
    expect(after).not.toBeNull();
    expect(['educational', 'promotional']).toContain(after!.kind);
  });
});

// ─── ADR-302: consent receipts ──────────────────────────────────────────────

describe('consent receipts (ADR-302)', () => {
  it('unasked domains are not consented and have a null timestamp', () => {
    expect(hasConsent('account')).toBe(false);
    expect(getConsent('account').at).toBeNull();
  });

  it('records grant AND decline as decisions', () => {
    recordConsent('account', true, 'post-init');
    recordConsent('telemetry', false, 'post-init');
    expect(hasConsent('account')).toBe(true);
    expect(hasConsent('telemetry')).toBe(false);
    expect(getConsent('telemetry').at).not.toBeNull(); // decline is recorded
  });

  it('a stale policyVersion is not consent (re-ask, never carry forward)', () => {
    recordConsent('cloud-routing', true, 'test');
    // simulate a policy bump by rewriting the receipt with an older version
    const file = path.join(stateDir, 'consent.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    data['cloud-routing'].policyVersion = CONSENT_POLICY_VERSION - 1;
    fs.writeFileSync(file, JSON.stringify(data));
    expect(hasConsent('cloud-routing')).toBe(false);
  });

  it('accepting account consent enables nothing else (domains are separate)', () => {
    recordConsent('account', true, 'post-init');
    expect(hasConsent('cloud-routing')).toBe(false);
    expect(hasConsent('telemetry')).toBe(false);
    expect(hasConsent('proxy-install')).toBe(false);
  });
});

describe('training-data-sharing consent domain (ADR-315 Tier 2)', () => {
  it('is unconsented by default, independent of sponsored-downtime', () => {
    recordConsent('sponsored-downtime', true, 'proxy-sponsor-enable');
    expect(hasConsent('sponsored-downtime')).toBe(true);
    expect(hasConsent('training-data-sharing')).toBe(false);
  });

  it('granting sponsored-downtime never implicitly grants training-data-sharing', () => {
    recordConsent('sponsored-downtime', true, 'proxy-sponsor-enable');
    recordConsent('power-saver', true, 'proxy-power-saver-enable');
    expect(hasConsent('training-data-sharing')).toBe(false);
  });

  it('records grant and decline as explicit decisions, same as every other domain', () => {
    recordConsent('training-data-sharing', true, 'proxy-training-share-enable');
    expect(hasConsent('training-data-sharing')).toBe(true);
    recordConsent('training-data-sharing', false, 'proxy-training-share-disable');
    expect(hasConsent('training-data-sharing')).toBe(false);
    expect(getConsent('training-data-sharing').at).not.toBeNull(); // decline recorded, not absent
  });

  it('granting training-data-sharing does not implicitly grant sponsored-downtime', () => {
    recordConsent('training-data-sharing', true, 'proxy-training-share-enable');
    expect(hasConsent('sponsored-downtime')).toBe(false);
  });

  it('the funnel event schema accepts training_share_enabled/disabled once telemetry is consented', () => {
    recordConsent('telemetry', true, 'test');
    expect(recordFunnelEvent('training_share_enabled', 'statusline', '3.25.6')).toBe(true);
    expect(recordFunnelEvent('training_share_disabled', 'statusline', '3.25.6')).toBe(true);
  });
});

describe('advisor-tips consent domain (ADR-316)', () => {
  it('is unconsented by default, independent of every other domain', () => {
    recordConsent('sponsored-downtime', true, 'proxy-sponsor-enable');
    recordConsent('power-saver', true, 'proxy-power-saver-enable');
    recordConsent('training-data-sharing', true, 'proxy-training-share-enable');
    expect(hasConsent('advisor-tips')).toBe(false);
  });

  it('granting advisor-tips does not implicitly grant any other domain', () => {
    recordConsent('advisor-tips', true, 'advisor-enable');
    expect(hasConsent('sponsored-downtime')).toBe(false);
    expect(hasConsent('power-saver')).toBe(false);
    expect(hasConsent('training-data-sharing')).toBe(false);
  });

  it('records grant and decline as explicit decisions', () => {
    recordConsent('advisor-tips', true, 'advisor-enable');
    expect(hasConsent('advisor-tips')).toBe(true);
    recordConsent('advisor-tips', false, 'advisor-disable');
    expect(hasConsent('advisor-tips')).toBe(false);
    expect(getConsent('advisor-tips').at).not.toBeNull();
  });

  it('the funnel event schema accepts advisor_tip_enabled/disabled once telemetry is consented', () => {
    recordConsent('telemetry', true, 'test');
    expect(recordFunnelEvent('advisor_tip_enabled', 'statusline', '3.25.6')).toBe(true);
    expect(recordFunnelEvent('advisor_tip_disabled', 'statusline', '3.25.6')).toBe(true);
  });
});

// ─── ADR-303: credit-error classifier ───────────────────────────────────────

describe('credit-error classifier (ADR-303, fail-closed)', () => {
  it('only COGNITUM_CREDIT_EXHAUSTED triggers the recovery surface', () => {
    const session = { creditPromptShown: false };
    const fire = classifyCreditError({ providerCode: 'cognitum_credit_exhausted' });
    expect(fire.code).toBe(CreditErrorCode.COGNITUM_CREDIT_EXHAUSTED);
    expect(shouldShowCreditRecovery(fire, session)).toBe(true);

    for (const code of ['insufficient_quota', 'rate_limit_exceeded', 'authentication_error', 'api_error']) {
      const e = classifyCreditError({ providerCode: code });
      expect(shouldShowCreditRecovery(e, session), `${code} must not fire`).toBe(false);
    }
  });

  it('provider quota exhaustion maps to PROVIDER_QUOTA_EXHAUSTED, never Cognitum', () => {
    const e = classifyCreditError({ providerCode: 'insufficient_quota' });
    expect(e.code).toBe(CreditErrorCode.PROVIDER_QUOTA_EXHAUSTED);
  });

  it('unmapped codes stay unclassified with confidence 0', () => {
    const e = classifyCreditError({ providerCode: 'weird_new_error' });
    expect(e.code).toBeNull();
    expect(e.confidence).toBe(0);
    expect(shouldShowCreditRecovery(e, { creditPromptShown: false })).toBe(false);
  });

  it('a bare 429 with no code is ambiguous → unmapped', () => {
    const e = classifyCreditError({ status: 429 });
    expect(e.code).toBeNull();
    expect(e.confidence).toBe(0);
  });

  it('never parses message text (only codes and status)', () => {
    const e = classifyCreditError({
      providerCode: undefined,
      // message text saying "credits exhausted" is NOT a signal
    } as never);
    expect(e.code).toBeNull();
  });

  it('caps at one prompt per session', () => {
    const fire = classifyCreditError({ providerCode: 'cognitum_credit_exhausted' });
    expect(shouldShowCreditRecovery(fire, { creditPromptShown: true })).toBe(false);
  });

  it('recovery screen distinguishes signed-in vs signed-out', () => {
    expect(renderCreditRecovery(false)).toContain('ruflo auth login');
    expect(renderCreditRecovery(true)).toContain('ruflo proxy enable');
  });
});

// ─── ADR-305/309: events, consent-gated, bucketed ───────────────────────────

describe('funnel events (ADR-305/309)', () => {
  it('records nothing without telemetry consent', () => {
    expect(recordFunnelEvent('disclosure_shown', 'statusline', '3.25.6')).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'funnel-events.jsonl'))).toBe(false);
    expect(getFunnelId()).toBeNull();
  });

  it('with consent: daily buckets only, closed event set, pseudonymous id', () => {
    recordConsent('telemetry', true, 'test');
    expect(recordFunnelEvent('signup_opened', 'init', '3.25.6')).toBe(true);
    const lines = fs.readFileSync(path.join(stateDir, 'funnel-events.jsonl'), 'utf-8').trim().split('\n');
    const evt = JSON.parse(lines[0]);
    expect(evt.timestampBucket).toMatch(/^\d{4}-\d{2}-\d{2}$/); // daily, no time
    expect(evt.pseudonymousId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(evt).sort()).toEqual(
      ['event', 'pseudonymousId', 'release', 'schemaVersion', 'surface', 'timestampBucket'],
    );
    // unknown event names are rejected
    expect(recordFunnelEvent('exfiltrate_prompts' as never, 'init', 'x')).toBe(false);
  });

  it('opt-out deletes the id and the queue', () => {
    recordConsent('telemetry', true, 'test');
    recordFunnelEvent('signup_opened', 'init', '3.25.6');
    const id = getFunnelId();
    expect(id).not.toBeNull();
    deleteFunnelData();
    expect(fs.existsSync(path.join(stateDir, 'funnel-events.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'funnel-id.json'))).toBe(false);
  });
});

// ─── ADR-302: enrollment gates ──────────────────────────────────────────────

describe('enrollment gates (ADR-302)', () => {
  it('never offers in CI, with --no-signup, or when funnel is disabled', () => {
    expect(shouldOfferEnrollment({ noSignup: true, cwd: stateDir })).toBe(false);
    expect(shouldOfferEnrollment({ noSignup: false, cwd: stateDir, env: { ...process.env, CI: '1' } })).toBe(false);
    expect(
      shouldOfferEnrollment({ noSignup: false, cwd: stateDir, env: { ...process.env, RUFLO_FUNNEL: '0' } }),
    ).toBe(false);
  });

  it('is one-time: any recorded outcome suppresses future offers', () => {
    recordEnrollmentOutcome(false);
    expect(getEnrollmentRecord()?.outcome).toBe('skipped');
    expect(shouldOfferEnrollment({ noSignup: false, cwd: stateDir })).toBe(false);
  });

  it('accepting records ONLY the account consent domain', () => {
    recordEnrollmentOutcome(true);
    expect(hasConsent('account')).toBe(true);
    expect(hasConsent('telemetry')).toBe(false);
    expect(hasConsent('cloud-routing')).toBe(false);
  });
});

// ─── environment gates ──────────────────────────────────────────────────────

describe('CI detection', () => {
  it('recognizes the common CI environments', () => {
    for (const v of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL', 'TF_BUILD']) {
      expect(isCI({ [v]: 'true' } as NodeJS.ProcessEnv), v).toBe(true);
    }
    expect(isCI({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCI({ CI: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

// ─── generated statusline renderer (defense-in-depth) ──────────────────────

describe('generated statusline promo row', () => {
  const script = generateStatuslineScript({
    runtime: { maxAgents: 8 },
    statusline: { enabled: true },
  } as never);

  it('embeds the promo renderer with CI and RUFLO_FUNNEL gates', () => {
    expect(script).toContain('getPromoRow');
    expect(script).toContain('process.env.CI');
    expect(script).toContain('RUFLO_FUNNEL');
  });

  it('re-sanitizes promo text at render time (control chars stripped, capped)', () => {
    expect(script).toContain('\\u0000-\\u001f');
    // v3.29.0 replaced the silent `.slice(0, 100)` truncation with a
    // MAX_LEN + ellipsis path that shows the row was truncated instead
    // of chopping a word mid-character. Assert both the cap constant AND
    // the ellipsis suffix are present.
    expect(script).toContain('MAX_LEN');
    expect(script).toMatch(/MAX_LEN\s*=\s*100/);
    expect(script).toContain('…');
  });

  it('never renders promo styling from payload — colors come from a fixed kind map', () => {
    // The row is styled by the renderer's own hardcoded color, chosen from the
    // CLI-supplied `kind` enum (disclosure/promotional/educational). The payload
    // text itself never provides ANSI — the sanitiser above strips all of it.
    // The wrapping ALWAYS ends with c.reset so no color leaks into subsequent
    // Claude Code UI. Guards against a future edit that lets payload styling in.
    expect(script).toMatch(/promoColor \+ promoRow \+ c\.reset/);
    expect(script).toMatch(/kind === 'promotional' \? c\.brightPurple/);
    expect(script).toMatch(/kind === 'educational' \? c\.yellow/);
    // Default branch stays a renderer-owned color, not a payload field.
    expect(script).toMatch(/: c\.brightCyan/);
  });

  it('validates a resolved CLI bin candidate actually has a compiled dist, not just a bin/cli.js on disk', () => {
    // Claude Code's own plugin marketplace mechanism installs by git clone/pull
    // with no build step, so ~/.claude/plugins/marketplaces/ruflo is a
    // source-only checkout by construction: bin/cli.js exists but importing
    // dist/src/index.js throws MODULE_NOT_FOUND on every real command
    // (confirmed live). Without checking for the compiled entrypoint too,
    // resolveCliBinCandidates() picked that doomed candidate every render and
    // wasted the render's time budget failing before ever reaching the npx
    // fallback — starving both the promo row and its 20s rotation clock.
    expect(script).toContain("path.join(path.dirname(p), '..', 'dist', 'src', 'index.js')");
  });
});

// ─── ADR-301/305 attribution — network-free fallback discipline ─────────────
// The funnel row must render correctly even when the API is completely down.
// These tests pin that invariant.

describe('attributionUrl (ADR-305 measurement, no runtime network)', () => {
  it('returns the base URL verbatim when it is malformed', () => {
    // The URL builder must never synthesize a broken analytics endpoint —
    // a malformed input passes through unchanged so downstream (OSC 8 host
    // allowlist) can drop it safely.
    const cases = ['not-a-url', '', 'javascript:evil()', 'ftp://cognitum.one'];
    for (const bad of cases) {
      expect(attributionUrl(bad, { medium: 's', campaign: 'c', content: 'x' })).toBe(bad);
    }
  });

  it('appends UTM params and preserves any query already on the base URL', () => {
    const out = attributionUrl('https://cognitum.one/ruflo?foo=1', {
      medium: 'statusline', campaign: 'disclosure', content: 'test-1',
    });
    const parsed = new URL(out);
    expect(parsed.searchParams.get('foo')).toBe('1');
    expect(parsed.searchParams.get('utm_source')).toBe('ruflo');
    expect(parsed.searchParams.get('utm_medium')).toBe('statusline');
    expect(parsed.searchParams.get('utm_campaign')).toBe('disclosure');
    expect(parsed.searchParams.get('utm_content')).toBe('test-1');
  });

  it('does NOT append fid when telemetry consent is absent (privacy default)', () => {
    // Default test state has no consent grants. fid must not appear.
    const out = attributionUrl('https://cognitum.one/ruflo', {
      medium: 'statusline', campaign: 'disclosure', content: 'x',
    });
    expect(new URL(out).searchParams.has('fid')).toBe(false);
  });

  it('emits no network call — attribution is a pure link builder', async () => {
    // This used to assert `elapsed < 100ms` for 1000 builds and treat that as
    // proof of "no network call". Two problems: it never actually observed the
    // network (its own comment conceded a future fetch() would still pass), and
    // wall-clock is not a property of the code under test — under full-suite
    // CPU contention the loop measured 118ms and failed, intermittently.
    // Assert the real property instead, by watching the network primitives.
    // Take the CJS copies: an ESM namespace object's properties are
    // non-writable ("Cannot redefine property: request"), while module.exports
    // on the CJS twin can be swapped and restored. Both surface the same
    // underlying implementation, so patching here observes any real call.
    const { createRequire } = await import('node:module');
    const requireCjs = createRequire(import.meta.url);
    const http = requireCjs('node:http') as { request: unknown };
    const https = requireCjs('node:https') as { request: unknown };
    const originalFetch = globalThis.fetch;
    const fetchCalls: unknown[] = [];
    const httpReq = http.request;
    const httpsReq = https.request;
    const httpCalls: unknown[] = [];
    const httpsCalls: unknown[] = [];
    globalThis.fetch = ((...a: unknown[]) => { fetchCalls.push(a); throw new Error('unexpected fetch'); }) as unknown as typeof fetch;
    (http as { request: unknown }).request = ((...a: unknown[]) => { httpCalls.push(a); throw new Error('unexpected http.request'); }) as unknown;
    (https as { request: unknown }).request = ((...a: unknown[]) => { httpsCalls.push(a); throw new Error('unexpected https.request'); }) as unknown;
    try {
      for (let i = 0; i < 1000; i++) {
        attributionUrl('https://cognitum.one/ruflo', {
          medium: 'statusline', campaign: 'disclosure', content: String(i),
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
      (http as { request: unknown }).request = httpReq;
      (https as { request: unknown }).request = httpsReq;
    }
    expect(fetchCalls).toEqual([]);
    expect(httpCalls).toEqual([]);
    expect(httpsCalls).toEqual([]);
  });
});

describe('getFunnelPromo — API-down fallback discipline', () => {
  it('generated statusline styles the label as a link and the command as bold-not-underlined', () => {
    // CTA affordance: the OSC 8 label is wrapped in ANSI underline so terminals
    // show it as a clickable link even when the OSC 8 hyperlink itself isn't
    // supported.
    //
    // "manage: ruflo settings" is a shell command, not a URL -- a terminal can
    // never safely execute a command from a click (that would let any
    // server-served message run arbitrary commands), so it must NEVER be
    // underlined or OSC-8-wrapped. Instead "ruflo settings" renders bold so it
    // visually reads as "the important bit to copy/type", not a dead link.
    const script = generateStatuslineScript({
      statusline: { enabled: true, style: 'compact' as const },
      runtime: { maxAgents: 15 },
    });
    // v3.29.0: label gets underline styling (still). But the whole row
    // is now wrapped in ONE OSC 8 hyperlink via wrapWholeRowInHyperlink,
    // not just the label — every part of the row is a click target.
    // Label still carries UL_ON/UL_OFF for the underline cue.
    expect(script).toMatch(/UL_ON \+ label \+ UL_OFF/);
    expect(script).toContain('wrapWholeRowInHyperlink');
    // "manage: " connector stays dim.
    expect(script).toMatch(/DIM_ON \+ manageWord \+ DIM_OFF/);
    // The command itself is bold + bright-white, never underlined.
    // v3.29.0 added FG_BRIGHT_WHITE so it visually stands out from the
    // row's kind-color instead of getting lost in it.
    expect(script).toMatch(/BOLD_ON \+ FG_BRIGHT_WHITE \+ command \+ FG_DEFAULT \+ BOLD_OFF/);
    expect(script).not.toMatch(/UL_ON \+ command/);
    // The split must be on the exact manage-instruction anchor.
    expect(script).toMatch(/text\.indexOf\(' · manage: '\)/);
  });

  it('generated statusline emits exactly 3 lines: header, ops, promo', () => {
    // Claude Code truncates statusline past line 4 with the system guidance
    // line. The 3-line design puts RuFlo header on line 1, then ops, then
    // promo — sequence matches order of pushes in the generator source.
    const script = generateStatuslineScript({
      statusline: { enabled: true, style: 'compact' as const },
      runtime: { maxAgents: 15 },
    });
    const headerIdx = script.indexOf('lines.push(header)');
    const opsIdx = script.indexOf("lines.push(opsParts.join(");
    const promoIdx = script.indexOf('lines.push(promoColor + promoRow');
    expect(headerIdx).toBeGreaterThan(0);
    expect(opsIdx).toBeGreaterThan(headerIdx);
    expect(promoIdx).toBeGreaterThan(opsIdx);
  });

  it('generated statusline memoizes promo across renders (survives promoless CLI)', () => {
    // A previously-installed older CLI cached by npx may succeed but omit
    // the promo field. The memo overlay patches it back in so the row
    // doesn't blink out mid-session.
    const script = generateStatuslineScript({
      statusline: { enabled: true, style: 'compact' as const },
      runtime: { maxAgents: 15 },
    });
    expect(script).toMatch(/PROMO_MEMO_FILE/);
    expect(script).toMatch(/function readPromoMemo/);
    expect(script).toMatch(/function overlayMemoPromo/);
    // Overlay must fire on every path (fresh cache, successful CLI, stale
    // cache fallback, cold fallback) — grep the call count as a spot check.
    const overlayCalls = (script.match(/overlayMemoPromo\(/g) || []).length;
    expect(overlayCalls).toBeGreaterThanOrEqual(4);
  });

  it('generated statusline script implements stale-while-revalidate for promo row', () => {
    // The fix for the flicker bug: the promo row must survive CLI hiccups
    // and cache-expiry-mid-render. readCache() returns { fresh, data } and
    // getStatuslineData falls back to stale cache when the CLI fails, so
    // the last known promo persists. This test pins that design in the
    // generator template so a future edit that breaks the pattern trips CI.
    const script = generateStatuslineScript({
      statusline: { enabled: true, style: 'compact' as const },
      runtime: { maxAgents: 15 },
    });
    // Cache reader must expose freshness rather than gating data behind TTL.
    expect(script).toMatch(/const cache = readCache\(\)/);
    expect(script).toMatch(/cache\.fresh/);
    // On CLI failure, must serve stale cache data (with local overlays) not
    // a bare buildLocalFallback() that would drop the promo field.
    expect(script).toMatch(/if \(cache\.data\)/);
    expect(script).toMatch(/applyLocalOverlays\(cache\.data\)/);
  });

  it('the promo row has its own rotation-cadence freshness check, distinct from the general 60s cache TTL', () => {
    // Bug report: "the promo area doesn't seem to be rotating every 20
    // seconds." Root cause: CACHE_TTL_MS (60s, #2337's fix for excessive
    // CLI re-invocation) let getStatuslineData() skip the CLI call — the
    // ONLY place the rotation slot is recomputed — for up to 3 whole 20s
    // rotation slots. A general cache.fresh check alone can never catch
    // this; it must ALSO check a tighter, rotation-cadence-bound freshness
    // signal before it's allowed to skip the CLI call.
    const script = generateStatuslineScript({
      statusline: { enabled: true, style: 'compact' as const },
      runtime: { maxAgents: 15 },
    });
    expect(script).toMatch(/PROMO_ROTATION_SLOT_MS\s*=\s*20000/);
    expect(script).toMatch(/promoFresh/);
    // The early-return that skips the CLI call must require BOTH freshness
    // signals — cache.fresh alone (the pre-fix bug) must not appear as the
    // sole guard on that line.
    expect(script).toMatch(/if \(cache\.fresh && cache\.promoFresh\)/);
  });

  it('renders the row without touching the network (no fetch import path)', async () => {
    // The promo module is imported at test module load; if it pulled in a
    // network library, this stringified module set would carry a fetch/https
    // reference. This is a design lock — a future edit that adds network
    // I/O to the render path breaks this test.
    const promoSrc = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/funnel/promo.ts', import.meta.url), 'utf-8'),
    );
    expect(promoSrc).not.toMatch(/require\(\s*['"]https?['"]\s*\)/);
    expect(promoSrc).not.toMatch(/from\s+['"]https?['"]/);
    expect(promoSrc).not.toMatch(/fetch\s*\(/);
    expect(promoSrc).not.toMatch(/XMLHttpRequest/);
  });
});

// ─── ADR-308 client transport — consent-gated + failure-safe ────────────────

describe('event transport (ADR-308 POST /v1/events)', () => {
  it('exposes ADR-308 defaults: https endpoint, batch cap, backoff, timeout', () => {
    expect(DEFAULT_ENDPOINT.startsWith('https://')).toBe(true);
    expect(MAX_BATCH).toBeGreaterThan(0);
    expect(MAX_BATCH).toBeLessThanOrEqual(1000);
    expect(MIN_FLUSH_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(FLUSH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(FLUSH_TIMEOUT_MS).toBeLessThanOrEqual(10_000); // never stall the CLI
  });

  it('no-ops without telemetry consent — zero network activity', async () => {
    // No consent granted in the base test state.
    const result = await flushEvents({ endpoint: 'https://127.0.0.1:1', now: new Date() });
    expect(result).toEqual({ flushed: 0, skipped: 'no-consent' });
  });

  it('rejects non-https endpoints inside postBatch (via consent-gated caller)', async () => {
    // Grant consent so the transport reaches postBatch, then pass an
    // http:// endpoint — the module must refuse rather than open a plaintext
    // connection.
    recordConsent('telemetry', true, 'test');
    // Also stage at least one event so we don't short-circuit on empty queue.
    recordFunnelEvent('disclosure_shown', 'statusline', 'test');
    const result = await flushEvents({ endpoint: 'http://127.0.0.1:1', force: true, now: new Date() });
    expect(result.skipped).toMatch(/transport-failed|no-consent/);
    // On the failed-transport path we expect a status of 0 (never opened).
    if (result.skipped === 'transport-failed') expect(result.status).toBe(0);
  });
});

describe('credit-notifier (ADR-303 out-of-band signal)', () => {
  it('markCreditExhausted is idempotent — stable `since`', () => {
    const t0 = new Date('2026-07-10T12:00:00.000Z');
    markCreditExhausted(t0);
    const first = readCreditStatus();
    expect(first.exhausted).toBe(true);
    expect(first.since).toBe(t0.toISOString());
    // Second mark must not move the `since` timestamp forward.
    markCreditExhausted(new Date('2026-07-10T13:00:00.000Z'));
    const second = readCreditStatus();
    expect(second.since).toBe(t0.toISOString());
  });

  it('clearCreditStatus stamps `cleared`, drops the exhausted flag', () => {
    markCreditExhausted(new Date('2026-07-10T12:00:00.000Z'));
    clearCreditStatus(new Date('2026-07-10T14:00:00.000Z'));
    const status = readCreditStatus();
    expect(status.exhausted).toBe(false);
    expect(status.cleared).toBe('2026-07-10T14:00:00.000Z');
  });

  it('creditExhaustedNotice renders humanized "since" copy', () => {
    markCreditExhausted(new Date('2026-07-10T12:00:00.000Z'));
    // 3 hours later
    const notice = creditExhaustedNotice(new Date('2026-07-10T15:00:00.000Z'));
    expect(notice).not.toBeNull();
    expect(notice).toContain('Cognitum credits exhausted');
    expect(notice).toContain('ruflo funnel signup');
    expect(notice).toContain('3h ago');
  });

  it('returns null when credit is not exhausted (no surface)', () => {
    clearCreditStatus();
    expect(creditExhaustedNotice()).toBeNull();
  });
});

// ─── ADR-312/313: rate-limit notifier + sponsored downtime override ────────

describe('rate-limit notifier (ADR-312 Phase 0 — manual, self-reported)', () => {
  it('starts not-limited', () => {
    expect(readRateLimitStatus().limited).toBe(false);
    expect(rateLimitNotice()).toBeNull();
  });

  it('markRateLimited is idempotent — stable `since`', () => {
    const t0 = new Date('2026-07-10T12:00:00.000Z');
    markRateLimited(t0);
    const first = readRateLimitStatus(t0);
    expect(first.limited).toBe(true);
    expect(first.since).toBe(t0.toISOString());
    // Marking again later must not move `since`.
    markRateLimited(new Date(t0.getTime() + 60_000));
    const second = readRateLimitStatus(new Date(t0.getTime() + 60_000));
    expect(second.since).toBe(t0.toISOString());
  });

  it('clearRateLimitStatus stamps `cleared` and flips `limited` false', () => {
    const t0 = new Date('2026-07-10T12:00:00.000Z');
    markRateLimited(t0);
    // Past the ADR-314 §D1 toggle cooldown (10 min) — a clear inside that
    // window is deliberately refused (covered separately below).
    const t1 = new Date(t0.getTime() + 11 * 60 * 1000);
    clearRateLimitStatus(t1);
    const status = readRateLimitStatus(t1);
    expect(status.limited).toBe(false);
    expect(status.cleared).not.toBeNull();
  });

  it('auto-expires the flag after the TTL (a stale manual mark self-heals)', () => {
    const t0 = new Date('2026-07-10T12:00:00.000Z');
    markRateLimited(t0);
    const justBefore = readRateLimitStatus(new Date(t0.getTime() + RATE_LIMIT_TTL_MS - 1000));
    expect(justBefore.limited).toBe(true);
    const justAfter = readRateLimitStatus(new Date(t0.getTime() + RATE_LIMIT_TTL_MS + 1000));
    expect(justAfter.limited).toBe(false);
  });

  it('rateLimitNotice humanizes age and points at the sponsor command', () => {
    const t0 = new Date('2026-07-10T12:00:00.000Z');
    markRateLimited(t0);
    const notice = rateLimitNotice(new Date(t0.getTime() + 5 * 60 * 1000));
    expect(notice).toContain('5m ago');
    expect(notice).toContain('ruflo proxy sponsor-enable');
  });
});

describe('toggle cooldown (ADR-314 §D1 — anti-abuse friction)', () => {
  it('is inactive with no prior toggle', () => {
    expect(cooldownActive(null, new Date())).toBe(false);
  });

  it('is active just before the cooldown window elapses', () => {
    const t0 = new Date('2026-07-10T12:00:00.000Z');
    const justBefore = new Date(t0.getTime() + TOGGLE_COOLDOWN_MS - 1000);
    expect(cooldownActive(t0.toISOString(), justBefore)).toBe(true);
  });

  it('clears just after the cooldown window elapses', () => {
    const t0 = new Date('2026-07-10T12:00:00.000Z');
    const justAfter = new Date(t0.getTime() + TOGGLE_COOLDOWN_MS + 1000);
    expect(cooldownActive(t0.toISOString(), justAfter)).toBe(false);
  });

  it('reports remaining minutes, floored to zero once elapsed', () => {
    const t0 = new Date('2026-07-10T12:00:00.000Z');
    const fiveMinIn = new Date(t0.getTime() + 5 * 60 * 1000);
    expect(cooldownRemainingMin(t0.toISOString(), fiveMinIn)).toBe(5);
    expect(cooldownRemainingMin(t0.toISOString(), new Date(t0.getTime() + TOGGLE_COOLDOWN_MS + 1000))).toBe(0);
  });

  it('rate-limit mark→clear inside the cooldown window is refused', () => {
    const t0 = new Date('2026-07-10T12:30:00.000Z');
    expect(markRateLimited(t0)).toBe(true);
    const stillCoolingDown = new Date(t0.getTime() + 1000);
    expect(clearRateLimitStatus(stillCoolingDown)).toBe(false);
    // The refusal must not have silently applied — still limited.
    expect(readRateLimitStatus(stillCoolingDown).limited).toBe(true);
  });

  it('rate-limit mark→clear after the cooldown window succeeds', () => {
    const t0 = new Date('2026-07-10T12:31:00.000Z');
    expect(markRateLimited(t0)).toBe(true);
    const afterCooldown = new Date(t0.getTime() + TOGGLE_COOLDOWN_MS + 1000);
    expect(clearRateLimitStatus(afterCooldown)).toBe(true);
    expect(readRateLimitStatus(afterCooldown).limited).toBe(false);
  });

  it('re-marking an already-limited flag is not a state change — cooldown does not apply', () => {
    const t0 = new Date('2026-07-10T12:32:00.000Z');
    expect(markRateLimited(t0)).toBe(true);
    // Immediately re-marking (still limited) must succeed — it's a no-op idempotent call.
    expect(markRateLimited(new Date(t0.getTime() + 1000))).toBe(true);
  });
});

describe('power-saver notifier (ADR-314 §A — manual, self-reported, mirrors rate-limit)', () => {
  it('starts not-low', () => {
    expect(readQuotaLowStatus().low).toBe(false);
    expect(quotaLowNotice()).toBeNull();
  });

  it('markQuotaLow is idempotent — stable `since`', () => {
    const t0 = new Date('2026-07-10T13:00:00.000Z');
    markQuotaLow(t0);
    const first = readQuotaLowStatus(t0);
    expect(first.low).toBe(true);
    expect(first.since).toBe(t0.toISOString());
    markQuotaLow(new Date(t0.getTime() + 60_000));
    const second = readQuotaLowStatus(new Date(t0.getTime() + 60_000));
    expect(second.since).toBe(t0.toISOString());
  });

  it('clearQuotaLowStatus stamps `cleared` and flips `low` false, past the cooldown', () => {
    const t0 = new Date('2026-07-10T13:01:00.000Z');
    markQuotaLow(t0);
    const t1 = new Date(t0.getTime() + TOGGLE_COOLDOWN_MS + 1000);
    expect(clearQuotaLowStatus(t1)).toBe(true);
    const status = readQuotaLowStatus(t1);
    expect(status.low).toBe(false);
    expect(status.cleared).not.toBeNull();
  });

  it('auto-expires the flag after the TTL', () => {
    const t0 = new Date('2026-07-10T13:02:00.000Z');
    markQuotaLow(t0);
    const justBefore = readQuotaLowStatus(new Date(t0.getTime() + QUOTA_LOW_TTL_MS - 1000));
    expect(justBefore.low).toBe(true);
    const justAfter = readQuotaLowStatus(new Date(t0.getTime() + QUOTA_LOW_TTL_MS + 1000));
    expect(justAfter.low).toBe(false);
  });

  it('quotaLowNotice humanizes age and points at power-saver-disable', () => {
    const t0 = new Date('2026-07-10T13:03:00.000Z');
    markQuotaLow(t0);
    const notice = quotaLowNotice(new Date(t0.getTime() + 5 * 60 * 1000));
    expect(notice).toContain('5m ago');
    expect(notice).toContain('ruflo proxy power-saver-disable');
  });

  it('mark→clear inside the cooldown window is refused, same as rate-limit', () => {
    const t0 = new Date('2026-07-10T13:04:00.000Z');
    expect(markQuotaLow(t0)).toBe(true);
    expect(clearQuotaLowStatus(new Date(t0.getTime() + 1000))).toBe(false);
    expect(readQuotaLowStatus(new Date(t0.getTime() + 1000)).low).toBe(true);
  });
});

describe('sponsored-downtime priority override (ADR-313)', () => {
  it('does not override when the rate-limit flag is unset', () => {
    seedRemoteMessages([...TEST_DISCLOSURE_POOL, ...TEST_ROTATION_POOL]);
    const t0 = new Date();
    recordDisclosureShown(t0);
    const after = new Date(t0.getTime() + DISCLOSURE_GRACE_MS + 60_000);
    const row = getFunnelPromo({ interactive: true, cwd: stateDir, now: after });
    expect(row).not.toBeNull();
    expect(row!.text).not.toContain('ruflo proxy sponsor');
  });

  it('shows the enable-CTA when rate-limited without sponsored consent', () => {
    seedRemoteMessages([...TEST_DISCLOSURE_POOL, ...TEST_ROTATION_POOL]);
    const t0 = new Date();
    recordDisclosureShown(t0);
    const after = new Date(t0.getTime() + DISCLOSURE_GRACE_MS + 60_000);
    markRateLimited(after);
    const row = getFunnelPromo({ interactive: true, cwd: stateDir, now: after });
    expect(row).not.toBeNull();
    expect(row!.text).toContain('Free Cognitum capacity');
    expect(row!.text).toContain('manage: ruflo proxy sponsor-enable');
    expect(displayWidth(row!.text)).toBeLessThanOrEqual(MAX_MESSAGE_COLUMNS);
  });

  it('shows the active-status line when rate-limited WITH sponsored consent granted', () => {
    seedRemoteMessages([...TEST_DISCLOSURE_POOL, ...TEST_ROTATION_POOL]);
    const t0 = new Date();
    recordDisclosureShown(t0);
    const after = new Date(t0.getTime() + DISCLOSURE_GRACE_MS + 60_000);
    markRateLimited(after);
    recordConsent('sponsored-downtime', true, 'test');
    const row = getFunnelPromo({ interactive: true, cwd: stateDir, now: after });
    expect(row).not.toBeNull();
    expect(row!.text).toContain('Running on sponsored Cognitum capacity');
    expect(row!.text).toContain('manage: ruflo proxy sponsor-disable');
    expect(displayWidth(row!.text)).toBeLessThanOrEqual(MAX_MESSAGE_COLUMNS);
  });

  it('the override preempts rotation even mid-promo-slot', () => {
    // Regression guard: without the override, a promotional slot would
    // otherwise render a rotation message here — confirm sponsored wins.
    seedRemoteMessages([...TEST_DISCLOSURE_POOL, ...TEST_ROTATION_POOL]);
    const t0 = new Date();
    recordDisclosureShown(t0);
    const after = new Date(t0.getTime() + DISCLOSURE_GRACE_MS + 60_000);
    markRateLimited(after);
    const row = getFunnelPromo({ interactive: true, cwd: stateDir, now: after });
    expect(row!.kind).toBe('promotional');
    expect(TEST_ROTATION_POOL.map((m) => m.text)).not.toContain(row!.text);
  });

  it('never overrides before the disclosure invariant is satisfied', () => {
    // ADR-301: no promotional content before disclosure — even a rate-limit
    // flag must not bypass the first-render disclosure gate.
    seedRemoteMessages(TEST_DISCLOSURE_POOL);
    markRateLimited(new Date());
    const row = getFunnelPromo({ interactive: true, cwd: stateDir });
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('disclosure');
  });
});

describe('local insight ticker (computeLocalInsights / selectLocalInsight)', () => {
  it('returns nothing when no context signal applies', () => {
    expect(computeLocalInsights({})).toEqual([]);
    expect(selectLocalInsight({})).toBeNull();
  });

  it('surfaces scanner findings at the highest priority without calling them CVEs', () => {
    const insights = computeLocalInsights({ security: { status: 'ISSUES', findings: 2, cvesFixed: 0, totalCves: 0 } });
    expect(insights).toHaveLength(1);
    expect(insights[0].text).toContain('2 security findings');
    expect(insights[0].text).not.toContain('CVE');
  });

  it('singularizes "1 security finding" correctly', () => {
    const insight = selectLocalInsight({ security: { status: 'ISSUES', findings: 1, cvesFixed: 0, totalCves: 0 } });
    expect(insight!.text).toContain('1 security finding');
    expect(insight!.text).not.toContain('1 security findings');
  });

  it('falls back to "scan pending" when no scan result exists', () => {
    const insight = selectLocalInsight({ security: { status: 'PENDING', findings: 0, cvesFixed: 0, totalCves: 0 } });
    expect(insight!.text).toContain('Security scan pending');
  });

  it('is silent when security is CLEAN', () => {
    expect(selectLocalInsight({ security: { status: 'CLEAN', findings: 0, cvesFixed: 0, totalCves: 0 } })).toBeNull();
  });

  it('surfaces uncommitted changes only above the threshold', () => {
    expect(selectLocalInsight({ gitUncommittedCount: 20 })).toBeNull(); // at threshold, not over
    const insight = selectLocalInsight({ gitUncommittedCount: 21 });
    expect(insight!.text).toContain('21 uncommitted changes');
  });

  it('picks the highest-priority candidate when several apply at once', () => {
    const insight = selectLocalInsight({
      security: { status: 'ISSUES', findings: 1, cvesFixed: 0, totalCves: 0 }, // priority 90
      gitUncommittedCount: 50, // priority 50
    });
    expect(insight!.id).toBe('insight-security-findings');
  });

  it('surfaces power-saver mode only when both consented and flagged low', () => {
    expect(selectLocalInsight({})).toBeNull();
    recordConsent('power-saver', true, 'test');
    expect(selectLocalInsight({})).toBeNull(); // consented but not flagged low
    markQuotaLow(new Date());
    const insight = selectLocalInsight({});
    expect(insight!.text).toContain('Power saver mode active');
  });

  it('reads the ADR-315 flywheel-status cache when present and fresh', () => {
    fs.writeFileSync(
      path.join(stateDir, 'flywheel-status.json'),
      JSON.stringify({ _ts: Date.now(), headline: 'test headline' }),
      'utf-8',
    );
    const insight = selectLocalInsight({});
    expect(insight!.text).toContain('test headline');
  });

  it('ignores an expired flywheel-status cache', () => {
    fs.writeFileSync(
      path.join(stateDir, 'flywheel-status.json'),
      JSON.stringify({ _ts: Date.now() - 25 * 60 * 60 * 1000, headline: 'stale headline' }),
      'utf-8',
    );
    expect(selectLocalInsight({})).toBeNull();
  });

  it('surfaces the ADR-316 advisor tip only when consented, and never a stale-past-TTL cache', () => {
    fs.writeFileSync(
      path.join(stateDir, 'advisor-tip.json'),
      JSON.stringify({ _ts: Date.now(), headline: 'commit your work' }),
      'utf-8',
    );
    expect(selectLocalInsight({})).toBeNull(); // not consented — cache is ignored regardless
    recordConsent('advisor-tips', true, 'test');
    const insight = selectLocalInsight({});
    expect(insight!.id).toBe('insight-advisor-tip');
    expect(insight!.text).toContain('commit your work');
  });

  it('an expired advisor-tip cache is silent even when consented', () => {
    recordConsent('advisor-tips', true, 'test');
    fs.writeFileSync(
      path.join(stateDir, 'advisor-tip.json'),
      JSON.stringify({ _ts: Date.now() - 25 * 60 * 60 * 1000, headline: 'stale tip' }),
      'utf-8',
    );
    expect(selectLocalInsight({})).toBeNull();
  });

  it('security findings still outrank the advisor tip', () => {
    recordConsent('advisor-tips', true, 'test');
    fs.writeFileSync(
      path.join(stateDir, 'advisor-tip.json'),
      JSON.stringify({ _ts: Date.now(), headline: 'a tip' }),
      'utf-8',
    );
    const insight = selectLocalInsight({ security: { status: 'ISSUES', findings: 1, cvesFixed: 0, totalCves: 0 } });
    expect(insight!.id).toBe('insight-security-findings');
  });

  it('the advisor tip outranks the flywheel-status placeholder', () => {
    recordConsent('advisor-tips', true, 'test');
    fs.writeFileSync(
      path.join(stateDir, 'advisor-tip.json'),
      JSON.stringify({ _ts: Date.now(), headline: 'a tip' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(stateDir, 'flywheel-status.json'),
      JSON.stringify({ _ts: Date.now(), headline: 'flywheel news' }),
      'utf-8',
    );
    const insight = selectLocalInsight({});
    expect(insight!.id).toBe('insight-advisor-tip');
  });
});

describe('local insight ticker integration with getFunnelPromo (ADR §5)', () => {
  it('never shows an insight when localInsights context is omitted (backward compatible)', () => {
    seedRemoteMessages([...TEST_DISCLOSURE_POOL, ...TEST_ROTATION_POOL]);
    const t0 = new Date();
    recordDisclosureShown(t0);
    // slot 2 (of 5) — the reserved insight slot — but no context passed.
    const insightSlotTime = new Date(t0.getTime() + DISCLOSURE_GRACE_MS + 60_000 + 2 * ROTATION_SLOT_MS);
    const row = getFunnelPromo({ interactive: true, cwd: stateDir, now: insightSlotTime });
    expect(row).not.toBeNull();
    expect(row!.kind).not.toBe('insight');
  });

  it('shows the insight on its reserved slot when context signals one', () => {
    seedRemoteMessages([...TEST_DISCLOSURE_POOL, ...TEST_ROTATION_POOL]);
    const t0 = new Date(0);
    recordDisclosureShown(t0);
    const after = new Date(t0.getTime() + DISCLOSURE_GRACE_MS + 60_000);
    // Find the next slot boundary where slot % 5 === 2 (promo.ts's reserved phase).
    let probe = after;
    while (Math.floor(probe.getTime() / ROTATION_SLOT_MS) % 5 !== 2) {
      probe = new Date(probe.getTime() + ROTATION_SLOT_MS);
    }
    const row = getFunnelPromo({
      interactive: true,
      cwd: stateDir,
      now: probe,
      localInsights: { security: { status: 'ISSUES', findings: 1, cvesFixed: 0, totalCves: 0 } },
    });
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('insight');
    expect(row!.text).toContain('security finding');
  });

  it('falls through to normal rotation on the insight slot when nothing is actionable', () => {
    seedRemoteMessages([...TEST_DISCLOSURE_POOL, ...TEST_ROTATION_POOL]);
    const t0 = new Date(0);
    recordDisclosureShown(t0);
    const after = new Date(t0.getTime() + DISCLOSURE_GRACE_MS + 60_000);
    let probe = after;
    while (Math.floor(probe.getTime() / ROTATION_SLOT_MS) % 5 !== 2) {
      probe = new Date(probe.getTime() + ROTATION_SLOT_MS);
    }
    const row = getFunnelPromo({
      interactive: true,
      cwd: stateDir,
      now: probe,
      localInsights: { security: { status: 'CLEAN', findings: 0, cvesFixed: 0, totalCves: 0 } },
    });
    expect(row).not.toBeNull();
    expect(row!.kind).not.toBe('insight'); // no actionable insight -> normal rotation
  });

  it('the ADR-313 sponsored override still wins even on the insight slot', () => {
    seedRemoteMessages([...TEST_DISCLOSURE_POOL, ...TEST_ROTATION_POOL]);
    const t0 = new Date(0);
    recordDisclosureShown(t0);
    const after = new Date(t0.getTime() + DISCLOSURE_GRACE_MS + 60_000);
    let probe = after;
    while (Math.floor(probe.getTime() / ROTATION_SLOT_MS) % 5 !== 2) {
      probe = new Date(probe.getTime() + ROTATION_SLOT_MS);
    }
    markRateLimited(probe);
    const row = getFunnelPromo({
      interactive: true,
      cwd: stateDir,
      now: probe,
      localInsights: { security: { status: 'ISSUES', findings: 1, cvesFixed: 0, totalCves: 0 } },
    });
    expect(row!.text).toContain('Cognitum capacity');
    expect(row!.kind).not.toBe('insight');
  });
});
