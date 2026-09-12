/**
 * Regression guard for #607 ("analyst agent is never 'found'").
 *
 * Root cause: several bundled `.claude/skills/*.md` files contain example
 * `Task(name, description, type)` calls using generic placeholder type
 * strings ("coordinator", "architect", "analyst", "specialist") that do not
 * match any agent actually registered under `.claude/agents/**\/*.md`.
 * Claude Code's Task tool validates `subagent_type` against that live
 * registry at runtime, so copying these examples verbatim fails with
 * "Agent type 'X' not found."
 *
 * This test asserts the three affected skill files no longer contain that
 * literal invalid-third-argument pattern. It is a narrow content guard
 * (not a general skill/agent-registry linter) scoped to the exact
 * occurrences fixed for #607.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsRoot = path.resolve(__dirname, '../../../../.claude/skills');

// Generic placeholder type strings that are never registered agent names.
const INVALID_TYPE_PATTERN = /Task\([^)]*"(coordinator|architect|analyst|specialist)"\)/;

const affectedFiles = [
  'github-multi-repo/SKILL.md',
  'hive-mind-advanced/SKILL.md',
  'github-release-management/SKILL.md',
];

describe('#607 skill example agent types', () => {
  for (const relPath of affectedFiles) {
    it(`${relPath} has no invalid placeholder Task(...) agent types`, () => {
      const content = readFileSync(path.join(skillsRoot, relPath), 'utf-8');
      const match = content.match(INVALID_TYPE_PATTERN);
      expect(match).toBeNull();
    });
  }

  it('github-multi-repo/SKILL.md uses real registered agent names for its example agents', () => {
    const content = readFileSync(path.join(skillsRoot, 'github-multi-repo/SKILL.md'), 'utf-8');
    expect(content).toContain('"multi-repo-swarm"');
    expect(content).toContain('"code-analyzer"');
    expect(content).toContain('"sync-coordinator"');
    expect(content).toContain('"repo-architect"');
  });

  it('hive-mind-advanced/SKILL.md uses "queen-coordinator" for its Queen example', () => {
    const content = readFileSync(path.join(skillsRoot, 'hive-mind-advanced/SKILL.md'), 'utf-8');
    expect(content).toContain('Task("Queen Coordinator", "Orchestrate REST API development...", "queen-coordinator")');
  });

  it('github-release-management/SKILL.md uses "release-manager" for its coordinator examples', () => {
    const content = readFileSync(path.join(skillsRoot, 'github-release-management/SKILL.md'), 'utf-8');
    const releaseManagerCount = (content.match(/"release-manager"/g) ?? []).length;
    expect(releaseManagerCount).toBeGreaterThanOrEqual(4);
  });
});
