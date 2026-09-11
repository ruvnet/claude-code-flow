#!/usr/bin/env node
/**
 * RuFlo V3 Statusline — delegation build (#2195)
 *
 * Fix for ruvnet/ruflo#2195: the previous version re-implemented all data
 * readers locally using fragile file probes that missed AgentDB patterns,
 * the v3/docs/adr/ ADR directory, and the real vector count.
 *
 * This version delegates to 'npx @claude-flow/cli hooks statusline --json'
 * as the single source of truth. That command queries AgentDB directly,
 * counts ADRs in both directories, and reports the real intelligence pct.
 *
 * ADR counting falls back to local file reads so the display still works
 * without network access (counts both v3/docs/adr/ and v3/implementation/adrs/).
 *
 * Cache: JSON result is cached in /tmp for 10s so rapid prompt triggers
 * (every keystroke in some shells) don't hammer the CLI on every call.
 *
 * Usage: node statusline.cjs [--json] [--compact] [--dashboard]
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// #2897 — on Android (Termux + PRoot Linux), bionic libc hard-aborts
// (SIGABRT) any platform binary that touches tzdata/ICU when
// ANDROID_TZDATA_ROOT is unset, and PRoot doesn't export Android's
// runtime env roots. sqlite3 is one such binary, so every sqlite3 shell-out
// below via safeExec() died silently (safeExec swallows the throw and
// returns ''), permanently pinning Vectors/HNSW at 0 with no error surfaced.
// Detect Android via /apex/com.android.tzdata and backfill the roots it
// needs — existing env values always win (the `||` pattern), so a
// correctly-configured ambient environment is never overridden, and this
// is a no-op everywhere /apex/com.android.tzdata doesn't exist.
const EXEC_ENV = (() => {
  const e = Object.assign({}, process.env);
  try {
    if (fs.existsSync('/apex/com.android.tzdata')) {
      e.ANDROID_ROOT = e.ANDROID_ROOT || '/system';
      e.ANDROID_DATA = e.ANDROID_DATA || '/data';
      e.ANDROID_TZDATA_ROOT = e.ANDROID_TZDATA_ROOT || '/apex/com.android.tzdata';
      e.ANDROID_I18N_ROOT = e.ANDROID_I18N_ROOT || '/apex/com.android.i18n';
    }
  } catch { /* not Android, or /apex unreadable -- leave env untouched */ }
  return e;
})();

// Configuration
const CONFIG = {
  maxAgents: 15,
  // Header identity defaults to project/repository name. Set `author` to
  // retain the previous `git config user.name` display (#2682).
  identityMode: (process.env.RUFLO_STATUSLINE_IDENTITY || 'project').toLowerCase(),
  // Session-cost display. Claude Code's cost.total_cost_usd is a client-side
  // estimate that "may differ from your actual bill" and reads as misleading on
  // subscription plans, where token usage is not billed per dollar. These let
  // each user pick what the segment means to them without changing the default.
  //   RUFLO_STATUSLINE_COST_SYMBOL  override the leading '$' (e.g. ⚡, €, 🌱);
  //                                 set to an empty string for the number alone.
  //   RUFLO_STATUSLINE_HIDE_COST    1/true/yes/on removes the segment entirely.
  costSymbol: process.env.RUFLO_STATUSLINE_COST_SYMBOL ?? '$',
  hideCost: /^(1|true|yes|on)$/i.test(process.env.RUFLO_STATUSLINE_HIDE_COST || ''),
};

const CWD = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// Replaced by statusline-generator with the package root of the CLI that
// installed this helper. This survives custom npm prefixes and bundled Node
// runtimes whose process.execPath belongs to a different tree (#2811).
const BAKED_INSTALL_ROOT = "";

// ─── Delegation cache ───────────────────────────────────────────
// Cache the CLI JSON result so rapid prompt re-renders (Claude Code
// refreshes the statusline several times a second while streaming) don't
// re-invoke the CLI each time.
// #2337 bumped 10s → 60s.
// Followup for anthropics/claude-code#70200 (Windows console-flash bug —
// claude.exe spawns hook/statusline subprocesses without CREATE_NO_WINDOW,
// producing a visible cmd flash on every render): bumped 60s → 300s to
// reduce the flash rate 5x on Windows until the upstream fix ships.
// Tradeoff: stat/git counters update every 5min instead of every 1min;
// promo/insight row still rotates on its own tighter 20s promoFresh clock.
const CACHE_FILE = path.join(os.tmpdir(), 'ruflo-statusline-cache-' + require('crypto').createHash('md5').update(CWD).digest('hex').slice(0, 8) + '.json');
const CACHE_TTL_MS = 300000;

// The promo/insight row is designed to rotate on a 20s cadence (funnel/
// rotation.ts's ROTATION_SLOT_MS / funnel/promo.ts's insight-slot check —
// duplicated here as a bare number since this generated script has no
// runtime import of the funnel module; keep in sync if that constant ever
// changes). The rotation slot is only ever (re)computed SERVER-SIDE inside
// the CLI subprocess this file shells out to — so a general 60s data cache
// (correct and necessary for #2337) silently made that 20s design
// unreachable: cache.fresh stayed true across 2-3 whole rotation slots,
// so the row visibly "didn't rotate" (user report). Fix: track promo
// freshness on its OWN, tighter clock — when it lags behind the current
// slot, fall through to a real CLI call even though the REST of the
// cached data (security/swarm/system) is still within CACHE_TTL_MS. This
// does not touch or regress #2337's fix; it only adds a narrower check.
const PROMO_ROTATION_SLOT_MS = 20000;

// Persistent last-known-good promo record. Lives outside the /tmp cache so it
// survives a full cache wipe / cache write race / CLI failure combo. Written
// every time we successfully render a promo; read as a last resort so the row
// never blinks out mid-session (was: 'promo shows then hides' bug report).
const PROMO_MEMO_FILE = path.join(os.homedir(), '.ruflo', 'statusline-promo.json');
const PROMO_MEMO_TTL_MS = 6 * 60 * 60 * 1000; // 6h — long enough to bridge any hiccup, short enough that a real disable takes effect fast.

// #2337: resolve an already-installed @claude-flow/cli (or ruflo) bin so we
// can invoke it directly via `node`. The previous version called
// `npx --yes @claude-flow/cli@latest` on every uncached render, which forces
// a registry resolution + cold-start of the entire CLI per render. With
// multiple concurrent Claude Code sessions this storms the host (reporter
// saw load average 40-65 on a 12-core box).
//
// Returns EVERY existing bin/cli.js candidate, in preference order (project,
// monorepo, plugin marketplace, global node_modules including custom-prefix
// layouts like ~/.npm-global) — mirrors getPkgVersion()'s own path probing.
//
// Returns a list, not a single winner: `fs.existsSync` only proves a file is
// present, not that it actually runs. A marketplace/npx-cached install can
// exist on disk but be broken (observed in practice: a stale marketplace
// checkout whose dist/ imports a workspace package, '@claude-flow/cli-core',
// that isn't bundled there — every invocation throws ERR_MODULE_NOT_FOUND).
// Picking the first EXISTING path and never falling through meant a single
// broken install silently killed the promo row for the entire session (the
// CLI call always failed, so the memo could never refresh and eventually
// expired). getStatuslineData() now walks this whole list and tries the next
// candidate on failure, so one broken install can't permanently wedge it.
function resolveCliBinCandidates() {
  const candidates = [];
  try {
    const home = os.homedir();
    candidates.push(
      path.join(home, '.claude', 'plugins', 'marketplaces', 'ruflo', 'bin', 'cli.js'),
      path.join(CWD, 'node_modules', '@claude-flow', 'cli', 'bin', 'cli.js'),
      path.join(CWD, 'node_modules', 'ruflo', 'bin', 'cli.js'),
      path.join(CWD, 'v3', '@claude-flow', 'cli', 'bin', 'cli.js'),
    );
    try {
      const binDir = path.dirname(process.execPath);
      const globalModuleDirs = [path.join(binDir, '..', 'lib', 'node_modules'), path.join(binDir, 'node_modules')];
      for (const prefix of [process.env.npm_config_prefix, process.env.PREFIX, path.join(home, '.npm-global')]) {
        if (prefix) globalModuleDirs.push(path.join(prefix, 'lib', 'node_modules'));
      }
      for (const gm of globalModuleDirs) {
        candidates.push(
          path.join(gm, 'ruflo', 'bin', 'cli.js'),
          path.join(gm, '@claude-flow', 'cli', 'bin', 'cli.js'),
        );
      }
    } catch { /* ignore */ }
  } catch { /* ignore */ }
  return candidates.filter((p) => {
    try {
      if (!fs.existsSync(p)) return false;
      // A candidate's bin/cli.js can exist on disk while its compiled
      // dist/ never got built (Claude Code's own plugin marketplace just
      // git-clones the repo — no install/build step — so every marketplace
      // install is a source-only checkout by construction). Importing
      // dist/src/index.js from bin/cli.js then throws MODULE_NOT_FOUND on
      // every real command; only --version happens to survive it. Check
      // for the compiled entrypoint too so a doomed candidate is skipped
      // up front instead of wasting a spawn-and-fail on every render.
      return fs.existsSync(path.join(path.dirname(p), '..', 'dist', 'src', 'index.js'));
    } catch { return false; }
  });
}

// Return { fresh, promoFresh, data }. 'fresh' is true only if within the TTL
// — but data is returned regardless (stale-while-revalidate). This lets us
// serve last known state (specifically the promo row) when the CLI is
// slow/unavailable, so users don't see the funnel row flicker in and out on
// cache expiry. 'promoFresh' is a SEPARATE, tighter check on the same clock
// as PROMO_ROTATION_SLOT_MS — see that constant's comment for why the promo
// row needs its own freshness bound distinct from the general 60s TTL.
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (raw && raw._ts && raw.data) {
        const age = Date.now() - raw._ts;
        return { fresh: age < CACHE_TTL_MS, promoFresh: age < PROMO_ROTATION_SLOT_MS, data: raw.data };
      }
    }
  } catch { /* ignore */ }
  return { fresh: false, promoFresh: false, data: null };
}

function writeCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ _ts: Date.now(), data }), 'utf-8'); } catch { /* ignore */ }
  // Also memoize any promo we saw so the row can survive future CLI hiccups.
  try {
    if (data && data.promo && typeof data.promo === 'object') {
      fs.mkdirSync(path.dirname(PROMO_MEMO_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(PROMO_MEMO_FILE, JSON.stringify({ _ts: Date.now(), promo: data.promo }), { encoding: 'utf-8', mode: 0o600 });
    }
  } catch { /* ignore */ }
}

// Last resort: read a memoized promo (up to 6h old). Used when no cache and
// no CLI response is available — the row still renders, so users don't see
// the disclosure blink out. Returns null when the memo is absent, expired,
// or malformed. Never throws.
function readPromoMemo() {
  try {
    if (!fs.existsSync(PROMO_MEMO_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(PROMO_MEMO_FILE, 'utf-8'));
    if (raw && raw._ts && (Date.now() - raw._ts) < PROMO_MEMO_TTL_MS && raw.promo) {
      return raw.promo;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Single source of truth: delegate to the CLI hooks statusline --json command.
 * Falls back to a minimal static object on failure so the statusline still renders.
 *
 * Fix for ruflo#2195: the previous local readers returned 0 for AgentDB patterns
 * (missed the .swarm/memory.db → AgentDB path), computed dddProgress wrong,
 * and only counted ADRs in v3/implementation/adrs/ (missed v3/docs/adr/).
 */
// Overlay the memoized promo onto any data object that's missing one. This is
// the safety net that keeps the funnel row rendered when an OLDER cached CLI
// version is picked up by npx — that older CLI succeeds but omits promo, so
// the JSON round-trips clean but without our row. We patch it back here.
function overlayMemoPromo(data) {
  if (data && !data.promo) {
    const memoPromo = readPromoMemo();
    if (memoPromo) data.promo = memoPromo;
  }
  return data;
}

function getStatuslineData() {
  const cache = readCache();
  // Both clocks must be satisfied to skip the CLI call entirely: the general
  // 60s TTL (#2337 — don't re-spawn the CLI on every rapid re-render) AND the
  // tighter promo-rotation clock (this fix — don't let a still-fresh 60s
  // cache silently freeze the promo/insight row across multiple 20s slots).
  if (cache.fresh && cache.promoFresh) {
    return applyLocalOverlays(overlayMemoPromo(cache.data));
  }

  // #2337: prefer an already-installed CLI bin via direct `node` invocation —
  // no npx, no registry round-trip, no @latest re-resolve per render. Try
  // every candidate that actually EXISTS (not just the first) before falling
  // back to `npx --prefer-offline @claude-flow/cli` (no @latest); an existing
  // but broken install (e.g. a stale marketplace checkout missing a bundled
  // workspace dep) must not block trying the next one.
  //
  // No `2>/dev/null` here (deliberately) — the execSync call below already
  // sets stdio: ['pipe','pipe','pipe'], which captures/discards stderr at the
  // Node level regardless of shell. The redirect was redundant on POSIX and
  // actively broke every candidate on Windows: cmd.exe (execSync's default
  // shell there) doesn't understand /dev/null, so the CLI delegation always
  // failed, silently degrading every render to buildLocalFallback() — 0%
  // intelligence and an empty promo row (the memo cache that keeps the row
  // populated across CLI hiccups is only ever written from a SUCCESSFUL
  // delegation, so it could never get seeded on Windows either).
  const cmds = resolveCliBinCandidates()
    .map((bin) => '"' + process.execPath + '" "' + bin + '" hooks statusline --json')
    .concat(['npx --prefer-offline @claude-flow/cli hooks statusline --json']);
  for (const cmd of cmds) {
    try {
      const raw = execSync(
        cmd,
        { encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'], cwd: CWD, windowsHide: true }
      ).trim();
      // The CLI may emit preamble lines before the JSON — find the first '{'.
      const jsonStart = raw.indexOf('{');
      if (jsonStart === -1) throw new Error('no JSON in CLI output');
      const data = JSON.parse(raw.slice(jsonStart));
      // Overlay every block the CLI JSON omits (adrs/agentdb/tests/hooks/integration)
      // with real local reads, so those segments reflect actual state instead of 0.
      applyLocalOverlays(data);
      overlayMemoPromo(data);
      writeCache(data);
      return data;
    } catch { /* this candidate unavailable, broken, or timed out — try the next */ }
  }

  // Stale-while-revalidate: if we have any cached data, keep serving it so the
  // funnel row doesn't flicker on CLI hiccups. Overlay fresh local reads for
  // the segments the CLI JSON doesn't populate; the promo row survives.
  if (cache.data) {
    applyLocalOverlays(cache.data);
    overlayMemoPromo(cache.data);
    return cache.data;
  }

  // Last resort: local probes + memo. Users still see the funnel row.
  return overlayMemoPromo(buildLocalFallback());
}

// Count ADRs from BOTH known directories (fix for ruflo#2195: old code missed
// v3/docs/adr/ which holds ADR-088..ADR-137, i.e. 41 of the 128 total ADRs).
function getLocalADRCount() {
  const adrDirs = [
    path.join(CWD, 'v3', 'implementation', 'adrs'),
    path.join(CWD, 'v3', 'docs', 'adr'),
    path.join(CWD, 'docs', 'adrs'),
    path.join(CWD, '.claude-flow', 'adrs'),
  ];
  let total = 0;
  for (const dir of adrDirs) {
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(function(f) {
          return f.endsWith('.md') && (f.startsWith('ADR-') || f.startsWith('adr-') || /^\d{4}-/.test(f));
        });
        total += files.length;
      }
    } catch { /* ignore */ }
  }
  return { count: total, implemented: total, compliance: 0 };
}

// ─── Local overlays for segments the CLI JSON omits ──────────────
// 'hooks statusline --json' only returns user/v3Progress/security/swarm/system.
// agentdb/tests/hooks/integration are never populated, so without these overlays
// they render as a permanent 0. Each reader is cheap and degrades to zeros.

// Real AgentDB stats from the local memory DB. Vectors live in .swarm/memory.db
// (sql.js + HNSW); ruvector.db is an opaque redb store counted only toward size.
// One read-only sqlite3 query (mode=ro never takes a write lock the daemon owns).
function getLocalAgentDB() {
  const result = { vectorCount: 0, dbSizeKB: 0, hasHnsw: false };
  try {
    let bytes = 0;
    for (const f of ['.swarm/memory.db', 'ruvector.db']) {
      try { bytes += fs.statSync(path.join(CWD, f)).size; } catch { /* missing */ }
    }
    result.dbSizeKB = Math.round(bytes / 1024);

    const memDb = path.join(CWD, '.swarm', 'memory.db');
    if (fs.existsSync(memDb)) {
      const Q = String.fromCharCode(34);
      // Two INDEPENDENT statements -- do NOT combine into one. Coupling the
      // vector count with the vector_indexes row count in a single statement
      // meant that on a DB missing the vector_indexes table (older/agentdb-
      // written DBs), the whole statement failed at PREPARE time (SQLite
      // compiles the full SQL before running), so the valid memory_entries
      // count was discarded too and the statusline showed Vectors 0 despite
      // thousands of real vectors. Split so a missing table can only zero the
      // HNSW flag, never the count. The init self-heal provisions the table so
      // the flag recovers on the next ruflo init / MCP start.
      const countSql = Q + 'SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL;' + Q;
      const vc = safeExec("sqlite3 'file:" + memDb + "?mode=ro' " + countSql, 1500);
      if (vc) result.vectorCount = parseInt(vc, 10) || 0;
      // HNSW flag: separate statement. If vector_indexes is absent, sqlite3
      // exits non-zero and safeExec returns empty -- hasHnsw stays false (exact
      // original semantics: at least one index-config row present).
      const hnswSql = Q + 'SELECT COUNT(*) FROM vector_indexes;' + Q;
      const hn = safeExec("sqlite3 'file:" + memDb + "?mode=ro' " + hnswSql, 1500);
      if (hn) result.hasHnsw = (parseInt(hn, 10) || 0) > 0;
    }
  } catch { /* ignore */ }
  return result;
}

// Count test files via a bounded directory walk (no file reads).
function getLocalTests() {
  let testFiles = 0;
  function countTests(dir, depth) {
    if ((depth || 0) > 4) return;
    try {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          countTests(path.join(dir, e.name), (depth || 0) + 1);
        } else if (e.isFile() && (e.name.includes('.test.') || e.name.includes('.spec.') || e.name.startsWith('test_') || e.name.startsWith('spec_'))) {
          testFiles++;
        }
      }
    } catch { /* ignore */ }
  }
  for (const d of ['tests', 'test', '__tests__', 'src', 'v3']) countTests(path.join(CWD, d));
  return { testFiles, testCases: testFiles * 4 };
}

// Count configured hooks from project .claude/settings.json. Claude Code hooks
// have no enabled/disabled flag, so every configured hook counts as enabled.
function getLocalHooks() {
  const result = { enabled: 0, total: 0 };
  try {
    const settings = readJSON(path.join(CWD, '.claude', 'settings.json'));
    const hooks = settings && settings.hooks;
    if (hooks && typeof hooks === 'object') {
      let n = 0;
      for (const ev of Object.keys(hooks)) {
        const groups = hooks[ev];
        if (Array.isArray(groups)) {
          for (const g of groups) {
            if (g && Array.isArray(g.hooks)) n += g.hooks.length;
          }
        }
      }
      result.total = n;
      result.enabled = n;
    }
  } catch { /* ignore */ }
  return result;
}

// Best-effort integration block: DB presence + locally-configured stdio MCP
// servers (project .mcp.json + global ~/.claude.json). Remote connectors are
// account-managed and not present in local config, so they are not counted.
function getLocalIntegration() {
  const integration = { mcpServers: { enabled: 0, total: 0 }, hasDatabase: false };
  try {
    for (const f of ['.swarm/memory.db', 'ruvector.db']) {
      if (fs.existsSync(path.join(CWD, f))) { integration.hasDatabase = true; break; }
    }
    const names = new Set();
    const projMcp = readJSON(path.join(CWD, '.mcp.json'));
    if (projMcp && projMcp.mcpServers) for (const k of Object.keys(projMcp.mcpServers)) names.add(k);
    const claudeJson = readJSON(path.join(os.homedir(), '.claude.json'));
    if (claudeJson) {
      if (claudeJson.mcpServers) for (const k of Object.keys(claudeJson.mcpServers)) names.add(k);
      const proj = claudeJson.projects && claudeJson.projects[CWD];
      if (proj && proj.mcpServers && !Array.isArray(proj.mcpServers)) {
        for (const k of Object.keys(proj.mcpServers)) names.add(k);
      }
    }
    integration.mcpServers.total = names.size;
    integration.mcpServers.enabled = names.size;
  } catch { /* ignore */ }
  return integration;
}

// ─── Security freshness overlay (ruvnet/ruflo#2776) ──────────────
// The shipped CLI producer (dist/src/funnel/local-signals.js getSecurityStatus)
// only ever emits PENDING / CLEAN / ISSUES — it captures `scannedAt` but never
// inspects it, so a year-old scan renders 🛡 ✓ forever and the renderer's
// STALE / IN_PROGRESS branches are unreachable. Worse, when CLI delegation
// fails, the stale-while-revalidate cache (readCache() below) keeps serving
// the pre-scan PENDING pill indefinitely, so a user who runs the advertised
// `ruflo security scan` sees no change — the pill freezes at "scan pending".
//
// This overlay recomputes the security block from disk on EVERY render (same
// pattern as adrs/agentdb/tests/hooks above), which:
//   1) Makes STALE reachable — when the newest scan is older than
//      RUFLO_SCAN_STALE_HOURS (default 24h — matches the CVE feed refresh
//      cadence), report STALE regardless of what the cached CLI JSON says.
//   2) Makes IN_PROGRESS reachable — when a `scan-in-progress` marker file
//      exists and is younger than SECURITY_IN_PROGRESS_MAX_MIN (guards against
//      a crashed scan leaving the marker behind).
//   3) Caps the "scan pending" display window — if PENDING has been shown for
//      >RUFLO_SCAN_PENDING_CAP_MIN (default 30) without a completion write,
//      switch to STALE and stop rendering the yellow indicator. The tracker
//      lives in ~/.ruflo/statusline-scan-pending-since.json, keyed by CWD
//      hash so multiple project checkouts don't collide.
//   4) Since this runs AFTER readCache() serves stale data, it bypasses the
//      "pill freezes at PENDING" freeze in defect 2 — the overlay reads
//      fresh disk state even when the CLI delegation is broken.
const SECURITY_STALE_HOURS = Math.max(1, parseInt(process.env.RUFLO_SCAN_STALE_HOURS || '24', 10) || 24);
const SECURITY_PENDING_CAP_MIN = Math.max(1, parseInt(process.env.RUFLO_SCAN_PENDING_CAP_MIN || '30', 10) || 30);
const SECURITY_IN_PROGRESS_MAX_MIN = 30; // marker older than this = crashed scan; treat as absent
const PENDING_TRACK_FILE = path.join(os.homedir(), '.ruflo', 'statusline-scan-pending-since.json');
const CWD_KEY = require('crypto').createHash('md5').update(CWD).digest('hex').slice(0, 12);

function readPendingSince() {
  try {
    if (!fs.existsSync(PENDING_TRACK_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(PENDING_TRACK_FILE, 'utf-8'));
    if (raw && typeof raw === 'object' && typeof raw[CWD_KEY] === 'number') return raw[CWD_KEY];
  } catch { /* ignore */ }
  return null;
}

function writePendingSince(ts) {
  try {
    let obj = {};
    if (fs.existsSync(PENDING_TRACK_FILE)) {
      try { obj = JSON.parse(fs.readFileSync(PENDING_TRACK_FILE, 'utf-8')) || {}; } catch { obj = {}; }
    }
    if (ts === null) { delete obj[CWD_KEY]; } else { obj[CWD_KEY] = ts; }
    fs.mkdirSync(path.dirname(PENDING_TRACK_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(PENDING_TRACK_FILE, JSON.stringify(obj), { encoding: 'utf-8', mode: 0o600 });
  } catch { /* ignore */ }
}

function getLocalSecurity(cliSecurity) {
  const base = (cliSecurity && typeof cliSecurity === 'object')
    ? Object.assign({}, cliSecurity)
    : { status: 'NONE', findings: 0, cvesFixed: 0, totalCves: 0 };
  base.findings = Math.max(0, base.findings || 0);

  const scanDir = path.join(CWD, '.claude', 'security-scans');

  // Detect a live in-progress marker (writer opts-in by writing this file).
  let inProgress = false;
  try {
    const marker = path.join(scanDir, 'scan-in-progress');
    if (fs.existsSync(marker)) {
      const ageMin = (Date.now() - fs.statSync(marker).mtimeMs) / 60000;
      if (ageMin < SECURITY_IN_PROGRESS_MAX_MIN) inProgress = true;
    }
  } catch { /* ignore */ }

  // Find newest scan-*.json by mtime and read its findings/timestamp.
  let newestPath = null;
  let newestMtime = 0;
  try {
    if (fs.existsSync(scanDir)) {
      for (const name of fs.readdirSync(scanDir)) {
        if (!name.startsWith('scan-') || !name.endsWith('.json')) continue;
        try {
          const st = fs.statSync(path.join(scanDir, name));
          if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newestPath = path.join(scanDir, name); }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  if (newestPath) {
    // We have a scan on disk — the never-scanned pending tracker is no longer
    // relevant. Clear it so a re-created directory can start a fresh window.
    writePendingSince(null);

    let scannedAtMs = newestMtime;
    let findings = base.findings;
    try {
      const j = JSON.parse(fs.readFileSync(newestPath, 'utf-8'));
      // scannedAt (CLI producer's field name) OR timestamp (writer's field name).
      const isoStr = (j && (j.scannedAt || j.timestamp)) || null;
      if (isoStr) {
        const t = Date.parse(isoStr);
        if (!isNaN(t)) scannedAtMs = t;
      }
      // findings may be a number, an array, or nested in summary.total.
      if (j) {
        if (typeof j.findings === 'number') findings = j.findings;
        else if (Array.isArray(j.findings)) findings = j.findings.length;
        else if (j.summary && typeof j.summary.total === 'number') findings = j.summary.total;
      }
    } catch { /* ignore parse — fall back to mtime + cached findings */ }

    base.findings = Math.max(0, findings || 0);
    base.scannedAt = new Date(scannedAtMs).toISOString();

    const ageHours = (Date.now() - scannedAtMs) / 3600000;
    if (ageHours >= SECURITY_STALE_HOURS) {
      // Stale but findings still render red (a year-old ISSUES scan is still bad).
      base.status = 'STALE';
    } else if (inProgress) {
      base.status = 'IN_PROGRESS';
    } else if (base.findings > 0) {
      base.status = 'ISSUES';
    } else {
      base.status = 'CLEAN';
    }
    return base;
  }

  // No scan file. If a live marker exists, we're mid-scan.
  if (inProgress) {
    base.status = 'IN_PROGRESS';
    // Reset the pending tracker so, if the scan crashes mid-flight, the next
    // render starts a fresh N-minute pending window instead of an already-expired one.
    writePendingSince(null);
    return base;
  }

  // Truly never-scanned: track how long we've shown PENDING. After the cap,
  // escalate to STALE with the dim/gray glyph so the pill visibly stops
  // shouting for attention — the user has either ignored it for 30 min or
  // the scan is silently failing to write.
  let pendingSince = readPendingSince();
  if (pendingSince === null || typeof pendingSince !== 'number') {
    pendingSince = Date.now();
    writePendingSince(pendingSince);
  }
  const pendingAgeMin = (Date.now() - pendingSince) / 60000;
  base.status = (pendingAgeMin >= SECURITY_PENDING_CAP_MIN) ? 'STALE' : 'PENDING';
  return base;
}

// Cached pattern count. The store is routinely >10MB (14.5MB / 1277 patterns on
// the machine this was diagnosed on, costing 53ms to read+parse), and the
// statusline re-renders on every prompt, so the parse is keyed on the file's
// mtime+size and reused until the store actually changes.
const PATTERN_COUNT_CACHE = path.join(os.tmpdir(), 'ruflo-statusline-patterns-' + require('crypto').createHash('md5').update(CWD).digest('hex').slice(0, 8) + '.json');

function countPatternsCached(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return 0; }
  const key = stat.mtimeMs + ':' + stat.size;

  try {
    const memo = JSON.parse(fs.readFileSync(PATTERN_COUNT_CACHE, 'utf-8'));
    if (memo && memo[file] && memo[file].key === key) return memo[file].count;
  } catch { /* no memo yet, or unreadable — fall through and recount */ }

  let count = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(raw)) count = raw.length;
    else if (raw && Array.isArray(raw.patterns)) count = raw.patterns.length;
    else if (raw && typeof raw === 'object') count = Object.keys(raw).length;
  } catch { return 0; }

  try {
    let memo = {};
    try { memo = JSON.parse(fs.readFileSync(PATTERN_COUNT_CACHE, 'utf-8')) || {}; } catch { /* start fresh */ }
    memo[file] = { key, count };
    fs.writeFileSync(PATTERN_COUNT_CACHE, JSON.stringify(memo));
  } catch { /* cache is an optimisation, never a requirement */ }

  return count;
}

// `system` is nominally CLI-populated, but the pattern store is on disk, so a
// dead CLI must not render as "no learning". Without this, every candidate in
// resolveCliBinCandidates() failing (a source-only marketplace checkout, or an
// npx fetch that dies in a workspace root) silently degraded the brain to a
// hardcoded 0% while the overlaid segments beside it kept showing live data —
// indistinguishable from a genuine zero. Same reasoning as getLocalAgentDB(),
// which had to start reading locally after the statusline reported "Vectors 0"
// on a database holding thousands.
function getLocalIntelligence(current) {
  const base = (current && typeof current === 'object') ? current : {};
  if (typeof base.intelligencePct === 'number' && base.intelligencePct > 0) return base;

  for (const file of [
    path.join(CWD, '.claude-flow', 'neural', 'patterns.json'),
    path.join(os.homedir(), '.claude-flow', 'neural', 'patterns.json'),
  ]) {
    const n = countPatternsCached(file);
    if (n > 0) {
      base.intelligencePct = Math.min(100, Math.floor(n / 10));
      return base;
    }
  }

  // No CLI value and no local store: unknown, which is not the same as zero.
  base.intelligencePct = null;
  return base;
}

// Overlay every locally-derived block onto the CLI data (mutates in place).
function applyLocalOverlays(data) {
  data.adrs = getLocalADRCount();
  data.agentdb = getLocalAgentDB();
  data.tests = getLocalTests();
  data.hooks = getLocalHooks();
  data.integration = getLocalIntegration();
  // Security overlay: recompute freshness from disk on every render so cached
  // CLI JSON can never freeze the pill at PENDING. See getLocalSecurity() above.
  data.security = getLocalSecurity(data.security);
  data.system = getLocalIntelligence(data.system);
  return data;
}

// Minimal local fallback when the CLI is not installed or times out.
// Returns a structure that matches the CLI JSON schema so the renderer works.
function buildLocalFallback() {
  const memMB = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);

  return applyLocalOverlays({
    user: { name: 'user', gitBranch: '', modelName: 'Claude Code' },
    v3Progress: { domainsCompleted: 0, totalDomains: 5, dddProgress: 0, patternsLearned: 0, sessionsCompleted: 0 },
    security: { status: 'NONE', findings: 0, cvesFixed: 0, totalCves: 0 },
    swarm: { activeAgents: 0, maxAgents: CONFIG.maxAgents, coordinationActive: false },
    system: { memoryMB: memMB, contextPct: 0, intelligencePct: null, subAgents: 0 },
    lastUpdated: new Date().toISOString(),
  });
}

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  blue: '\x1b[0;34m',
  purple: '\x1b[0;35m',
  cyan: '\x1b[0;36m',
  brightRed: '\x1b[1;31m',
  brightGreen: '\x1b[1;32m',
  brightYellow: '\x1b[1;33m',
  brightBlue: '\x1b[1;34m',
  brightPurple: '\x1b[1;35m',
  brightCyan: '\x1b[1;36m',
  brightWhite: '\x1b[1;37m',
};

// Safe execSync with strict timeout (returns empty string on failure)
function safeExec(cmd, timeoutMs) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs || 2000,
      env: EXEC_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows: without this, every execSync spawns cmd.exe /d /s /c which
      // flashes a visible console window every render (~1/min via the 60s
      // cache TTL). windowsHide runs the child in a hidden window instead.
      // No-op on POSIX. Fix for #2XXX (user report: "cmd prompt keeps opening").
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

// Safe JSON file reader (returns null on failure)
function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Git info (pure-Node / single exec — needed for branch display) ──────────

function getGitInfo() {
  const result = {
    name: path.basename(CWD) || 'project', gitBranch: '', modified: 0, untracked: 0,
    staged: 0, ahead: 0, behind: 0,
  };

  const script = [
    'git rev-parse --show-toplevel 2>/dev/null || pwd',
    'echo "---SEP---"',
    'git config user.name 2>/dev/null || echo user',
    'echo "---SEP---"',
    'git branch --show-current 2>/dev/null',
    'echo "---SEP---"',
    'git status --porcelain 2>/dev/null',
    'echo "---SEP---"',
    'git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null || echo "0 0"',
  ].join('; ');

  const raw = safeExec("sh -c '" + script + "'", 3000);
  if (!raw) return result;

  const parts = raw.split('---SEP---').map(function(s) { return s.trim(); });
  if (parts.length >= 5) {
    const projectName = path.basename(parts[0] || CWD) || path.basename(CWD) || 'project';
    const authorName = parts[1] || 'user';
    result.name = CONFIG.identityMode === 'author' ? authorName : projectName;
    result.gitBranch = parts[2] || '';

    if (parts[3]) {
      for (const line of parts[3].split('\n')) {
        if (!line || line.length < 2) continue;
        const x = line[0], y = line[1];
        if (x === '?' && y === '?') { result.untracked++; continue; }
        if (x !== ' ' && x !== '?') result.staged++;
        if (y !== ' ' && y !== '?') result.modified++;
      }
    }

    const ab = (parts[4] || '0 0').split(/\s+/);
    result.ahead = parseInt(ab[0]) || 0;
    result.behind = parseInt(ab[1]) || 0;
  }

  return result;
}

// Detect model name from Claude config (pure file reads, no exec)
function getModelName() {
  try {
    const claudeConfig = readJSON(path.join(os.homedir(), '.claude.json'));
    if (claudeConfig && claudeConfig.projects) {
      for (const [projectPath, projectConfig] of Object.entries(claudeConfig.projects)) {
        if (CWD === projectPath || CWD.startsWith(projectPath + '/')) {
          const usage = projectConfig.lastModelUsage;
          if (usage) {
            const ids = Object.keys(usage);
            if (ids.length > 0) {
              let modelId = ids[ids.length - 1];
              let latest = 0;
              for (const id of ids) {
                const ts = usage[id] && usage[id].lastUsedAt ? new Date(usage[id].lastUsedAt).getTime() : 0;
                if (ts > latest) { latest = ts; modelId = id; }
              }
              if (modelId.includes('opus')) return 'Opus 4.8';
              if (modelId.includes('sonnet')) return 'Sonnet 4.6';
              if (modelId.includes('haiku')) return 'Haiku 4.5';
              return modelId.split('-').slice(1, 3).join(' ');
            }
          }
          break;
        }
      }
    }
  } catch { /* ignore */ }

  // Fallback: settings.json model field
  const settings = getSettings();
  if (settings && settings.model) {
    const m = settings.model;
    if (m.includes('opus')) return 'Opus 4.8';
    if (m.includes('sonnet')) return 'Sonnet 4.6';
    if (m.includes('haiku')) return 'Haiku 4.5';
  }
  return 'Claude Code';
}

// ─── Stdin reader (Claude Code pipes session JSON) ──────────────
// Claude Code sends session JSON via stdin. Read synchronously so the
// script works both when invoked by Claude Code (stdin has JSON) and
// when run manually from terminal (stdin is empty/tty).
let _stdinData = null;
function getStdinData() {
  if (_stdinData !== undefined && _stdinData !== null) return _stdinData;
  try {
    if (process.stdin.isTTY) { _stdinData = null; return null; }
    const chunks = [];
    const buf = Buffer.alloc(4096);
    let bytesRead;
    try {
      while ((bytesRead = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
        chunks.push(buf.slice(0, bytesRead));
      }
    } catch { /* EOF or read error */ }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    _stdinData = (raw && raw.startsWith('{')) ? JSON.parse(raw) : null;
  } catch {
    _stdinData = null;
  }
  return _stdinData;
}

function getModelFromStdin() {
  const data = getStdinData();
  return (data && data.model && data.model.display_name) ? data.model.display_name : null;
}

function getContextFromStdin() {
  const data = getStdinData();
  if (data && data.context_window) {
    return { usedPct: Math.floor(data.context_window.used_percentage || 0) };
  }
  return null;
}

function getCostFromStdin() {
  const data = getStdinData();
  if (data && data.cost) {
    const durationMs = data.cost.total_duration_ms || 0;
    const mins = Math.floor(durationMs / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);
    return {
      costUsd: data.cost.total_cost_usd || 0,
      duration: mins > 0 ? mins + 'm' + secs + 's' : secs + 's',
    };
  }
  return null;
}

// Compares dotted-numeric version strings (e.g. "3.27.1" vs "3.27.10").
// Returns >0 if a>b, <0 if a<b, 0 if equal-as-far-as-parseable. Deliberately
// simple (no prerelease/build-metadata handling) — this only orders local
// package.json versions against each other, never anything untrusted from
// a payload, so a full semver implementation would be dead weight here.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10));
  const pb = String(b).split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// #2742: when CWD is a linked git worktree, it has no node_modules of its
// own (worktrees don't get their own `npm install`), so every CWD-relative
// probe in getPkgVersion() misses and the version silently falls back to
// the baked-in default — even though the main repo's install a few
// directories away is perfectly resolvable. A linked worktree's `.git` is
// a plain FILE (not a directory) containing `gitdir: <main>/.git/worktrees/
// <name>`; walk up from CWD to find it, parse the pointer, and strip the
// trailing `.git/worktrees/<name>` segment to recover the main repo root.
// Pure fs — no `git rev-parse` spawn (statusline renders are latency-
// sensitive; this doc comment's neighbors are explicit about avoiding
// spawns in the render path).
function resolveWorktreeMainRoot() {
  try {
    let dir = CWD;
    for (;;) {
      const dotGit = path.join(dir, '.git');
      if (fs.existsSync(dotGit)) {
        if (fs.statSync(dotGit).isFile()) {
          const contents = fs.readFileSync(dotGit, 'utf-8');
          const m = contents.match(/^gitdir:\s*(.+)$/m);
          const wtGitDir = m && m[1].trim();
          if (wtGitDir) {
            // Git writes this pointer with forward slashes even on Windows
            // (a git-for-windows convention for its own internal files) —
            // path.sep (backslash on win32) never matches, so normalize
            // before searching rather than building an OS-specific marker.
            const normalized = wtGitDir.replace(/\\/g, '/');
            const marker = '/.git/worktrees/';
            const idx = normalized.lastIndexOf(marker);
            if (idx > 0) return normalized.slice(0, idx);
          }
        }
        return null; // a real (non-worktree) .git dir — nothing to resolve
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached filesystem root
      dir = parent;
    }
  } catch {
    return null;
  }
}

function getPkgVersion() {
  // Baked in at generation time from the real running CLI's own resolved
  // version (see generateStatuslineScript()'s doc comment) — correct even
  // when this renders via a pure npx invocation with no local install for
  // the candidate scan below to find.
  let ver = "3.32.8";
  try {
    const home = os.homedir();
    const pkgPaths = [
      ...(BAKED_INSTALL_ROOT ? [path.join(BAKED_INSTALL_ROOT, 'package.json')] : []),
      path.join(home, '.claude', 'plugins', 'marketplaces', 'ruflo', 'package.json'),
      path.join(CWD, 'node_modules', '@claude-flow', 'cli', 'package.json'),
      path.join(CWD, 'node_modules', 'ruflo', 'package.json'),
      path.join(CWD, 'v3', '@claude-flow', 'cli', 'package.json'),
    ];
    // #2742: CWD is a linked git worktree with no node_modules of its own —
    // probe the main repo's install too, so a worktree session shows the
    // same version a main-repo session would.
    const worktreeMainRoot = resolveWorktreeMainRoot();
    if (worktreeMainRoot) {
      pkgPaths.push(
        path.join(worktreeMainRoot, 'node_modules', '@claude-flow', 'cli', 'package.json'),
        path.join(worktreeMainRoot, 'node_modules', 'ruflo', 'package.json'),
        path.join(worktreeMainRoot, 'v3', '@claude-flow', 'cli', 'package.json'),
      );
    }
    // #2221: global installs (npm i -g ruflo) live outside CWD/node_modules, so the
    // probes above all miss and the version falls back to the hard-coded default.
    // Derive the global node_modules dir from the running node binary (no npm spawn —
    // statusline renders often). Covers nvm/mise (bin/../lib/node_modules) and Windows
    // (bin/node_modules) layouts.
    try {
      const binDir = path.dirname(process.execPath);
      const globalModuleDirs = [path.join(binDir, '..', 'lib', 'node_modules'), path.join(binDir, 'node_modules')];
      // #2221 follow-up: a custom npm prefix (e.g. ~/.npm-global) is decoupled from
      // the node binary location, so the binDir-derived probes above all miss. Also
      // probe the npm prefix from the environment and the common ~/.npm-global default.
      for (const prefix of [
        process.env.npm_config_prefix,
        process.env.PREFIX,
        path.join(home, '.local'),
        path.join(home, '.npm-global'),
      ]) {
        if (prefix) globalModuleDirs.push(path.join(prefix, 'lib', 'node_modules'));
      }
      for (const gm of globalModuleDirs) {
        pkgPaths.push(
          path.join(gm, 'ruflo', 'package.json'),
          path.join(gm, '@claude-flow', 'cli', 'package.json'),
        );
      }
    } catch { /* ignore */ }
    // Pick the HIGHEST version among every candidate that exists, not the
    // first one found. The marketplace plugin path is probed first (list
    // order above), but Claude Code's own plugin marketplace mechanism
    // syncs on its own git-pull cadence, independent of npm publishes — a
    // freshly-published npm version can sit alongside a stale marketplace
    // checkout for a while (observed live: marketplace one release behind
    // right after a publish). Taking the first EXISTING candidate meant the
    // header could show a stale version even when a newer install (e.g.
    // node_modules/@claude-flow/cli from a plain npm install) was sitting right there.
    for (const p of pkgPaths) {
      if (!fs.existsSync(p)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (pkg && typeof pkg.version === 'string' && pkg.version.length > 0) {
          if (compareVersions(pkg.version, ver) > 0) ver = pkg.version;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return ver;
}

// ─── Rendering ──────────────────────────────────────────────────

function progressBar(current, total) {
  const width = 5;
  const filled = Math.round((current / total) * width);
  return '[' + '●'.repeat(filled) + '○'.repeat(width - filled) + ']';
}

function generateStatusline() {
  const d = getStatuslineData();
  const git = getGitInfo();
  const modelName = getModelFromStdin() || (d.user && d.user.modelName) || 'Claude Code';
  const ctxInfo = getContextFromStdin();
  const costInfo = getCostFromStdin();
  // Named RUFLO_VERSION (not pkgVersion) so the #1951 regression guard
  // (scripts/audit-fix-invariants.mjs) can pin its presence in the emitted
  // .cjs artifact — without it the header silently reverts to a hard-coded
  // "RuFlo V3.5" for anyone whose install doesn't match the first probe path.
  const RUFLO_VERSION = getPkgVersion();

  const progress = d.v3Progress || {};
  const security = d.security || {};
  const swarm = d.swarm || {};
  const system = d.system || {};
  const adrs = d.adrs || {};
  const hooks = d.hooks || {};
  const agentdb = d.agentdb || {};
  const tests = d.tests || {};

  const domainsCompleted = progress.domainsCompleted || 0;
  const totalDomains = progress.totalDomains || 5;
  const dddProgress = progress.dddProgress || 0;
  const patternsLearned = progress.patternsLearned || 0;
  const activeAgents = swarm.activeAgents || 0;
  const maxAgents = swarm.maxAgents || CONFIG.maxAgents;
  const coordinationActive = swarm.coordinationActive || false;
  // null/undefined means "no source answered", which must not collapse to 0 --
  // that is exactly the ambiguity this segment used to present.
  const intelligencePct = (typeof system.intelligencePct === 'number')
    ? system.intelligencePct
    : null;
  const memoryMB = system.memoryMB || 0;
  const subAgents = system.subAgents || 0;
  const findings = Math.max(0, security.findings || 0);
  const secStatus = security.status || 'NONE';
  const adrCount = adrs.count || 0;
  const adrImpl = adrs.implemented || 0;
  const hooksEnabled = hooks.enabled || 0;
  const hooksTotal = hooks.total || 0;
  const vectorCount = agentdb.vectorCount || 0;
  const hasHnsw = agentdb.hasHnsw || false;
  const dbSizeKB = agentdb.dbSizeKB || 0;
  const testFiles = tests.testFiles || 0;
  const testCases = tests.testCases || testFiles * 4;

  const lines = [];

  // 3-line design (fits Claude Code's visible statusline area — line 4+ gets
  // replaced by the system guidance / input prompt line):
  //   Line 1 — Header (RuFlo version · git · model · timing · context · cost)
  //   Line 2 — Compressed ops (Swarm · Hooks · 🧠 · 💾 · Health)
  //   Line 3 — Promo / disclosure row (funnel surface, ADR-301)

  // ─── Line 1: header ────────────────────────────────────────────
  let header = c.bold + c.brightPurple + '▊ RuFlo V' + RUFLO_VERSION + ' ' + c.reset;
  header += (coordinationActive ? c.brightCyan : c.dim) + '● ' + c.brightCyan + git.name + c.reset;
  if (git.gitBranch) {
    header += '  ' + c.dim + '│' + c.reset + '  ' + c.brightBlue + '⏇ ' + git.gitBranch + c.reset;
    const changes = git.modified + git.staged + git.untracked;
    if (changes > 0) {
      let ind = '';
      if (git.staged > 0) ind += c.brightGreen + '+' + git.staged + c.reset;
      if (git.modified > 0) ind += c.brightYellow + '~' + git.modified + c.reset;
      if (git.untracked > 0) ind += c.dim + '?' + git.untracked + c.reset;
      header += ' ' + ind;
    }
    if (git.ahead > 0) header += ' ' + c.brightGreen + '↑' + git.ahead + c.reset;
    if (git.behind > 0) header += ' ' + c.brightRed + '↓' + git.behind + c.reset;
  }
  header += '  ' + c.dim + '│' + c.reset + '  ' + c.purple + modelName + c.reset;
  const duration = costInfo ? costInfo.duration : '';
  if (duration) header += '  ' + c.dim + '│' + c.reset + '  ' + c.cyan + '⏱ ' + duration + c.reset;
  if (ctxInfo && ctxInfo.usedPct > 0) {
    const ctxColor = ctxInfo.usedPct >= 90 ? c.brightRed : ctxInfo.usedPct >= 70 ? c.brightYellow : c.brightGreen;
    header += '  ' + c.dim + '│' + c.reset + '  ' + ctxColor + '● ' + ctxInfo.usedPct + '% ctx' + c.reset;
  }
  if (!CONFIG.hideCost && costInfo && costInfo.costUsd > 0) {
    header += '  ' + c.dim + '│' + c.reset + '  ' + c.brightYellow + CONFIG.costSymbol + costInfo.costUsd.toFixed(2) + c.reset;
  }
  lines.push(header);

  // ─── Line 2: compressed ops ────────────────────────────────────
  // Everything actionable in one dense row. Show only what changes what you
  // do next; diagnostic detail moves to `ruflo status --verbose`.
  const agentsColor = activeAgents > 0 ? c.brightGreen : c.dim;
  const hooksColor = hooksEnabled > 0 ? c.brightGreen : c.dim;
  const intellColor = intelligencePct === null ? c.dim : intelligencePct >= 80 ? c.brightGreen : intelligencePct >= 40 ? c.brightYellow : c.dim;
  const swarmInd = coordinationActive ? c.brightGreen + '◉' + c.reset + ' ' : c.dim + '○' + c.reset + ' ';
  const healthAllGreen = (secStatus === 'CLEAN' || secStatus === 'NONE') && findings === 0;
  const opsParts = [];
  opsParts.push(c.cyan + 'Swarm ' + swarmInd + agentsColor + activeAgents + c.reset + '/' + c.brightWhite + maxAgents + c.reset);
  if (subAgents > 0) opsParts.push(c.brightPurple + '👥 ' + subAgents + c.reset);
  opsParts.push(c.cyan + 'Hooks ' + hooksColor + hooksEnabled + c.reset + '/' + c.brightWhite + hooksTotal + c.reset);
  opsParts.push(intellColor + '🧠 ' + (intelligencePct === null ? '—' : intelligencePct + '%') + c.reset);
  opsParts.push(c.brightCyan + '💾 ' + memoryMB + 'MB' + c.reset);
  // Health: one glyph when green, terse copy when there's something to act on.
  if (healthAllGreen) {
    opsParts.push(c.brightGreen + '🛡 ✓' + c.reset);
  } else {
    // #2776: STALE gets dim/gray (distinct from the actionable yellow of
    // PENDING/IN_PROGRESS) so a stale pill visibly stops shouting for
    // attention — the user can act on the "run ruflo security scan" prompt or
    // ignore it without a permanently-yellow indicator.
    if (secStatus === 'PENDING') opsParts.push(c.brightYellow + '🛡 scan pending' + c.reset);
    else if (secStatus === 'IN_PROGRESS') opsParts.push(c.brightYellow + '🛡 scanning…' + c.reset);
    else if (secStatus === 'ISSUES') opsParts.push(c.brightRed + '🛡 findings' + c.reset);
    else if (secStatus === 'STALE') opsParts.push(c.dim + '🛡 scan stale' + c.reset);
    else if (secStatus !== 'NONE' && secStatus !== 'CLEAN') opsParts.push(c.brightRed + '🛡 ' + secStatus.toLowerCase() + c.reset);
    if (findings > 0) {
      opsParts.push(c.brightRed + '⚠ ' + findings + ' finding' + (findings === 1 ? '' : 's') + c.reset);
    }
  }
  lines.push(opsParts.join('  ' + c.dim + '·' + c.reset + '  '));

  // ─── Line 3: promo / disclosure / insight ───────────────────────
  // Colored by content kind so it reads as *what it is*, not as noise:
  //   disclosure  → brightCyan   (announcement / capability link)
  //   promotional → brightPurple (Cognitum sponsor spot)
  //   educational → yellow       (a tip)
  //   insight     → brightRed    (environment/task-aware, local, actionable —
  //                               distinct from remote content on purpose)
  const promoRow = getPromoRow(d);
  if (promoRow) {
    const kind = (d && d.promo && d.promo.kind) || 'disclosure';
    const promoColor = kind === 'promotional' ? c.brightPurple
                     : kind === 'educational' ? c.yellow
                     : kind === 'insight' ? c.brightRed
                     : c.brightCyan;
    lines.push(promoColor + promoRow + c.reset);
  }

  // Trailing blank line so Claude Code's input prompt gets breathing room
  // instead of butting directly against the last statusline row.
  return lines.join('\n') + '\n';
}

// ─── Funnel promo row (ADR-301) ─────────────────────────────────
// Allowlist for OSC 8 hyperlink targets. Ships in code (not in payload) so
// no message can smuggle a link to an unapproved host.
//
// The final destination hosts (cognitum.one / agentics.org) AND the
// click-redirect host are both allowlisted here: promo.ts routes every
// clickable message through the server-side click-redirect (ADR-311 §7)
// so promo_open + geo are captured before the 302 to the real target —
// so the OSC 8 link the renderer emits points at the redirect host, not
// the final destination directly.
const PROMO_LINK_HOSTS = new Set([
  'cognitum.one', 'www.cognitum.one', 'docs.cognitum.one',
  // agentics.org — OSS foundation, distinct sponsor domain. Kept in sync
  // with messages.ts ALLOWED_URL_HOSTS.
  'agentics.org', 'www.agentics.org',
  // Click-redirect host (funnel.ruv.io once its TLS cert is live; the raw
  // Cloud Run hostname is allowlisted too since event-transport.ts /
  // message-transport.ts / attribution.ts currently point at it as a TEMP
  // fallback while the domain mapping's cert provisions).
  'funnel.ruv.io',
  'cognitum-analytics-63rzcdswba-uc.a.run.app',
]);

// Emit OSC 8 hyperlinks unless the environment is known-broken. tmux mangles
// raw OSC 8 (see anthropics/claude-code#27047) — opt in via env if wrapped.
function terminalSupportsHyperlinks() {
  if (process.env.CI || process.env.GITHUB_ACTIONS) return false;
  if (process.env.TERM === 'dumb') return false;
  if (/^(0|false|off|no)$/i.test(String(process.env.RUFLO_STATUSLINE_HYPERLINKS || ''))) return false;
  if (process.env.TMUX && !process.env.RUFLO_STATUSLINE_HYPERLINKS_TMUX) return false;
  return true;
}

// Wrap a label in an OSC 8 hyperlink escape sequence. Falls back to the raw
// label whenever the URL is not an allowlisted https target, when the terminal
// can't render hyperlinks, or when parsing fails — a broken link must never
// leave a raw URL or stray escape in the statusline output.
function safeTerminalLink(label, url) {
  if (!terminalSupportsHyperlinks()) return label;
  if (typeof url !== 'string' || url.length === 0) return label;
  let parsed;
  try { parsed = new URL(url); } catch { return label; }
  if (parsed.protocol !== 'https:') return label;
  if (!PROMO_LINK_HOSTS.has(parsed.hostname)) return label;
  const cleanLabel = String(label).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
  if (cleanLabel.length === 0) return label;
  const ESC = '\u001b';
  return ESC + ']8;;' + parsed.href + ESC + '\\' + cleanLabel + ESC + ']8;;' + ESC + '\\';
}

function getPromoRow(d) {
  try {
    if (process.env.CI || process.env.GITHUB_ACTIONS) return null;
    if (/^(0|false|off|no)$/i.test(String(process.env.RUFLO_FUNNEL || ''))) return null;
    const promo = d && d.promo;
    if (!promo || typeof promo.text !== 'string') return null;
    // Strip control chars / ANSI / bidi overrides — promo copy is data and
    // must never emit its own terminal sequences. Hard-cap length AFTER the
    // strip; append an ellipsis when the cap fires so the row visibly reads
    // as truncated instead of chopping a word mid-character (was: silent
    // slice(0,100) that could produce output that looked like corrupt data).
    const MAX_LEN = 100;
    const sanitized = promo.text
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
      ;
    const text = (sanitized.length > MAX_LEN ? sanitized.slice(0, MAX_LEN - 1).trimEnd() + '…' : sanitized).trim();
    if (text.length === 0) return null;
    // Split the label from the trailing "· manage: ruflo settings" instruction
    // so each part gets styling that matches what it actually IS:
    //   1. label   — OSC 8 hyperlink + underline. A real clickable link.
    //   2. "manage:" — dim. Just a connector word, no action implied.
    //   3. "ruflo settings" — bold/bright, NOT underlined. This is a shell
    //      command the user TYPES, not a link they CLICK — a terminal can
    //      never safely execute a command from a click (that would let any
    //      server-served message run arbitrary commands), so we deliberately
    //      avoid the underline/OSC8 cues that imply "clickable". Bold+bright
    //      instead signals "this is the important bit — copy/type it".
    // Educational tips have no manage tail and no URL — plain text through.
    const manageIdx = text.indexOf(' · manage: ');
    const label = manageIdx > 0 ? text.slice(0, manageIdx) : text;
    const manageWord = manageIdx > 0 ? ' · manage: ' : '';
    const command = manageIdx > 0 ? text.slice(manageIdx + manageWord.length) : '';
    const UL_ON = '\u001b[4m';
    const UL_OFF = '\u001b[24m';
    const DIM_ON = '\u001b[2m';
    const DIM_OFF = '\u001b[22m';
    const BOLD_ON = '\u001b[1m';
    const BOLD_OFF = '\u001b[22m';
    const FG_BRIGHT_WHITE = '[97m';
    // Reset FG to default so the caller's row-color code resumes coloring the
    // rest of the row after the command portion. Without this the row-color
    // escape wouldn't visibly re-apply because we already emitted an explicit FG.
    const FG_DEFAULT = '[39m';
    // Some hosts (Claude Code's Windows UI, cmd.exe, older mintty) don't
    // render OSC 8 hyperlinks as clickable — the label just underlines and
    // clicks do nothing. Append a "(domain)" suffix so the destination is
    // visible/copyable everywhere. Wrap the suffix in OSC 8 too so terminals
    // that DO support hyperlinks give users TWO click targets (label AND
    // domain hint) instead of one — some Windows hosts render one but not
    // the other depending on how the statusline row is parsed.
    // Only for URLs (not educational tips), and only when the label doesn't
    // already end in the domain to avoid duplication.
    let visibleUrlHint = '';
    if (promo.url) {
      try {
        const host = new URL(promo.url).hostname.replace(/^www\./, '');
        // Strip the click-redirect wrapper so users see the FINAL destination,
        // not funnel.ruv.io. If the URL is /v1/click/<id>?to=<encoded>, pull the target.
        let displayHost = host;
        try {
          const to = new URL(promo.url).searchParams.get('to');
          if (to) displayHost = new URL(to).hostname.replace(/^www\./, '');
        } catch { /* not a click-redirect, keep the raw host */ }
        if (displayHost && !label.toLowerCase().endsWith(displayHost.toLowerCase())) {
          // safeTerminalLink returns the plain string if URL isn't allowlisted
          // or the terminal can't do OSC 8 — either way the domain stays visible.
          const clickableDomain = safeTerminalLink(displayHost, promo.url);
          visibleUrlHint = DIM_ON + ' (' + clickableDomain + ')' + DIM_OFF;
        }
      } catch { /* malformed URL — omit hint, never break the row */ }
    }
    // "Entire row clickable" (user request) — wrap the whole assembled
    // string in ONE OSC 8 hyperlink instead of just the label. The command
    // portion keeps its bold + bright-white treatment (no underline) so it
    // still VISUALLY reads as a shell command the user should type, not a
    // link — but if the user clicks anywhere on the row (label, domain
    // hint, connector, even the command text), the terminal opens the URL.
    // Clicking DOES NOT execute the command; it just opens the target URL,
    // which is safe. Terminals that ignore OSC 8 render the whole row as
    // styled text and no click behavior — the previous fallback (visible
    // domain suffix) still keeps the destination readable.
    const wrapWholeRowInHyperlink = (assembled) => {
      if (!promo.url) return assembled;
      if (!terminalSupportsHyperlinks()) return assembled;
      let parsed;
      try { parsed = new URL(promo.url); } catch { return assembled; }
      if (parsed.protocol !== 'https:') return assembled;
      if (!PROMO_LINK_HOSTS.has(parsed.hostname)) return assembled;
      const ESC = '';
      return ESC + ']8;;' + parsed.href + ESC + '\\' + assembled + ESC + ']8;;' + ESC + '\\';
    };
    // Visual styling stays per-part. We only add the OSC 8 wrap around the
    // combined string, so the whole row is one click target.
    const labelStyled = promo.url ? UL_ON + label + UL_OFF : label;
    if (!command) return wrapWholeRowInHyperlink(labelStyled + visibleUrlHint);
    return wrapWholeRowInHyperlink(
      labelStyled + visibleUrlHint
      + DIM_ON + manageWord + DIM_OFF
      + BOLD_ON + FG_BRIGHT_WHITE + command + FG_DEFAULT + BOLD_OFF
    );
  } catch (e) {
    return null; // the promo row must never break the statusline
  }
}

// JSON output — delegates to CLI for accuracy; caller can use --json flag
function generateJSON() {
  const d = getStatuslineData();
  const git = getGitInfo();
  return Object.assign({}, d, {
    user: Object.assign({ name: git.name, gitBranch: git.gitBranch }, d.user || {}),
    git: { modified: git.modified, untracked: git.untracked, staged: git.staged, ahead: git.ahead, behind: git.behind },
    lastUpdated: new Date().toISOString(),
  });
}

// ─── Main ───────────────────────────────────────────────────────
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(generateJSON(), null, 2));
} else if (process.argv.includes('--compact')) {
  console.log(JSON.stringify(generateJSON()));
} else {
  console.log(generateStatusline());
}
