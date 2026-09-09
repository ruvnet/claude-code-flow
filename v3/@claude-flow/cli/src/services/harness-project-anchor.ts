/**
 * Project-local, hash-pinned flywheel anchors (#2840).
 *
 * Downstream repositories must be evaluated against their own labelled
 * retrieval tasks. Silently using Ruflo's development-history benchmark makes
 * the objective flat and indistinguishable from "already optimal", so foreign
 * projects fail closed unless they supply a pinned anchor manifest.
 */
import {
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  FROZEN_HUMAN_EVAL_HASH,
  loadFrozenHumanEval,
  humanEvalHash,
  type HumanEvalTask,
} from './harness-frozen-eval.js';
import type { AnchorTask } from './harness-flywheel.js';

export const PROJECT_ANCHOR_SCHEMA = 'ruflo.flywheel-anchor/v1';
export const PROJECT_ANCHOR_MANIFEST_SCHEMA = 'ruflo.flywheel-anchor-manifest/v1';
export const DEFAULT_PROJECT_ANCHOR_MANIFEST = join('.claude', 'eval', 'flywheel-anchor.manifest.json');

export interface ProjectAnchorManifest {
  schemaVersion: typeof PROJECT_ANCHOR_MANIFEST_SCHEMA;
  path: string;
  sha256: string;
}

export interface FlywheelAnchorSelection {
  version: string;
  anchorRef: string;
  tasks: AnchorTask[];
  source: 'project' | 'ruflo-built-in';
  path?: string;
}

export interface LoadFlywheelAnchorOptions {
  anchorPath?: string;
  anchorHash?: string;
  manifestPath?: string;
}

function normalizeHash(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('sha256:') ? trimmed : `sha256:${trimmed}`;
}

function containedPath(projectRoot: string, requested: string): string {
  // The project root has two equally valid spellings when its path crosses a
  // symlink — on macOS `/tmp/x` and `/private/tmp/x` name the same directory.
  // Comparing a realpath'd root against a NON-realpath'd candidate (as this
  // did) makes every such project look like an escape, so a project anchored
  // anywhere under a symlink was rejected outright. Compare like with like:
  // the lexical guard accepts either spelling of the root, and the symlink
  // guard below still resolves the target and re-checks it physically.
  const rootLexical = resolve(projectRoot);
  const rootPhysical = realpathSync(rootLexical);
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(rootLexical, requested);
  const escapes = (base: string): boolean => {
    const rel = relative(base, absolute);
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  };
  if (escapes(rootLexical) && escapes(rootPhysical)) {
    throw new Error('flywheel anchor path must stay inside project root');
  }
  const actual = realpathSync(absolute);
  const physical = relative(rootPhysical, actual);
  if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
    throw new Error('flywheel anchor symlink escapes project root');
  }
  return actual;
}

function parseTasks(path: string): { version: string; tasks: HumanEvalTask[] } {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    schemaVersion?: string;
    version?: string;
    tasks?: HumanEvalTask[];
  };
  if (parsed.schemaVersion && parsed.schemaVersion !== PROJECT_ANCHOR_SCHEMA) {
    throw new Error(`unsupported flywheel anchor schema: ${parsed.schemaVersion}`);
  }
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length < 4) {
    throw new Error('project flywheel anchor requires at least 4 labelled tasks');
  }
  const ids = new Set<string>();
  for (const [index, task] of parsed.tasks.entries()) {
    if (!task || typeof task.id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(task.id)) {
      throw new Error(`invalid anchor task id at index ${index}`);
    }
    if (ids.has(task.id)) throw new Error(`duplicate anchor task id: ${task.id}`);
    ids.add(task.id);
    if (typeof task.q !== 'string' || task.q.trim().length === 0) {
      throw new Error(`anchor task ${task.id} has no query`);
    }
    if (!Array.isArray(task.labels) || task.labels.length === 0 || task.labels.some((label) => typeof label !== 'string' || !label.trim())) {
      throw new Error(`anchor task ${task.id} requires non-empty string labels`);
    }
  }
  return { version: parsed.version ?? 'project-anchor-v1', tasks: parsed.tasks };
}

function toSelection(
  path: string,
  expectedHash: string,
): FlywheelAnchorSelection {
  const parsed = parseTasks(path);
  const actualHash = humanEvalHash(parsed.tasks);
  if (actualHash !== normalizeHash(expectedHash)) {
    throw new Error(`project flywheel anchor hash mismatch (got ${actualHash}, pinned ${normalizeHash(expectedHash)})`);
  }
  return {
    version: parsed.version,
    anchorRef: actualHash,
    source: 'project',
    path,
    tasks: parsed.tasks.map((task) => ({
      id: task.id,
      input: { id: task.id, q: task.q },
      expected: task.labels,
    })),
  };
}

function isRufloRepository(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      name?: string;
      repository?: string | { url?: string };
    };
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    return ['claude-flow', 'ruflo', '@claude-flow/cli'].includes(pkg.name ?? '')
      && /github\.com[/:]ruvnet\/(?:ruflo|claude-flow)(?:\.git)?$/i.test(repository ?? '');
  } catch {
    return false;
  }
}

export function loadEffectiveFlywheelAnchor(
  projectRoot: string,
  options: LoadFlywheelAnchorOptions = {},
): FlywheelAnchorSelection {
  const root = resolve(projectRoot);
  if (!!options.anchorPath !== !!options.anchorHash) {
    throw new Error('anchorPath and anchorHash must be supplied together');
  }
  if (options.anchorPath && options.anchorHash) {
    return toSelection(containedPath(root, options.anchorPath), options.anchorHash);
  }

  const manifestCandidate = options.manifestPath ?? DEFAULT_PROJECT_ANCHOR_MANIFEST;
  const manifestPath = isAbsolute(manifestCandidate)
    ? manifestCandidate
    : resolve(root, manifestCandidate);
  if (existsSync(manifestPath)) {
    const containedManifest = containedPath(root, manifestPath);
    const manifest = JSON.parse(readFileSync(containedManifest, 'utf8')) as ProjectAnchorManifest;
    if (manifest.schemaVersion !== PROJECT_ANCHOR_MANIFEST_SCHEMA) {
      throw new Error(`unsupported flywheel anchor manifest schema: ${manifest.schemaVersion}`);
    }
    if (typeof manifest.path !== 'string' || typeof manifest.sha256 !== 'string') {
      throw new Error('flywheel anchor manifest requires path and sha256');
    }
    // Manifest-relative paths are easier to relocate while remaining
    // repository-contained; project-relative paths remain supported.
    const manifestRelative = resolve(dirname(containedManifest), manifest.path);
    const requested = existsSync(manifestRelative) ? manifestRelative : resolve(root, manifest.path);
    return toSelection(containedPath(root, requested), manifest.sha256);
  }

  if (isRufloRepository(root) || process.env.RUFLO_FLYWHEEL_ALLOW_BUILTIN_ANCHOR === '1') {
    const frozen = loadFrozenHumanEval();
    return {
      version: frozen.version,
      anchorRef: FROZEN_HUMAN_EVAL_HASH,
      source: 'ruflo-built-in',
      tasks: frozen.tasks.map((task) => ({
        id: task.id,
        input: { id: task.id, q: task.q },
        expected: task.labels,
      })),
    };
  }

  throw new Error(
    `project-local flywheel anchor required; create ${DEFAULT_PROJECT_ANCHOR_MANIFEST} or pass anchorPath + anchorHash`,
  );
}
