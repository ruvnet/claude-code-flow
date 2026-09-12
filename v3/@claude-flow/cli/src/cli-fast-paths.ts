/**
 * CLI fast-path helpers (#2256 / #2561).
 *
 * These are the tested reference implementations of the pre-import guards
 * that live inline in `bin/cli.js` and `ruflo/bin/ruflo.js`. The inline
 * copies MUST match the logic here — they are duplicated on purpose so
 * the guards can run before any code from the dist bundle is loaded.
 */

/**
 * Return true iff argv is a top-level version query that should short-circuit
 * the whole CLI import chain.
 *
 * Rule: scan argv left-to-right; a match is any argv containing `--version`
 * or `-V` with NO positional command-name token before it. The POSIX `--`
 * end-of-flags separator ends the scan (a version flag after `--` is a
 * positional). Presentation flags like `--no-color`, `--quiet`, or
 * `--format=json` before `--version` still hit the fast path — that is the
 * point of #2561: the original single-arg check missed those and fell
 * through to the full dist import, timing out the verification harness.
 *
 * Deliberately conservative: value-taking flags in split form (e.g.
 * `--config path`) leave `path` as a positional, so we defer to the
 * parser. Losing the fast path in that rare case is harmless — the
 * command still runs correctly, just via the slower import path.
 */
export function isVersionFastPath(argv: readonly string[]): boolean {
  for (const a of argv) {
    if (a === '--version' || a === '-V') return true;
    if (a === '--') return false;         // POSIX end-of-flags separator
    if (a.startsWith('-')) continue;      // any other flag/option token
    return false;                         // positional (command) — defer
  }
  return false;
}
