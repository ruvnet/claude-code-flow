/**
 * Skill Name Consistency Tests
 *
 * Verifies that every bundled SKILL.md in .agents/skills/ has a `name:` field
 * matching its containing directory name. A mismatch breaks skill invocation in
 * Claude Code because the autocomplete entry doesn't map to a real skill path.
 *
 * Regression test for: https://github.com/ruvnet/ruflo/issues/1054
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = join(__dirname, '../../../.agents/skills');

/**
 * Parse the `name:` field from SKILL.md YAML frontmatter.
 * Returns the raw value (strip surrounding quotes if present).
 */
function parseSkillName(skillMd: string): string | undefined {
  const match = skillMd.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return match?.[1]?.trim();
}

function getSkillDirs(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

describe('Skill SKILL.md name field consistency', () => {
  const dirs = getSkillDirs();

  it('skills directory exists and contains skill subdirectories', () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  it('every SKILL.md has a name field matching its directory name', () => {
    const mismatches: string[] = [];

    for (const dir of dirs) {
      const skillMdPath = join(SKILLS_DIR, dir, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;

      const content = readFileSync(skillMdPath, 'utf-8');
      const name = parseSkillName(content);

      if (name === undefined) {
        mismatches.push(`${dir}: missing name field`);
      } else if (name !== dir) {
        mismatches.push(`${dir}: name="${name}" does not match directory`);
      }
    }

    if (mismatches.length > 0) {
      throw new Error(
        `${mismatches.length} skill(s) have mismatched name fields:\n` +
        mismatches.map(m => `  - ${m}`).join('\n')
      );
    }
  });

  // Spot-check the 20 skills that were broken before the fix
  const knownFixed = [
    'agentdb-advanced',
    'agentdb-learning',
    'agentdb-memory-patterns',
    'agentdb-optimization',
    'agentdb-vector-search',
    'hooks-automation',
    'pair-programming',
    'reasoningbank-agentdb',
    'reasoningbank-intelligence',
    'skill-builder',
    'v3-cli-modernization',
    'v3-core-implementation',
    'v3-ddd-architecture',
    'v3-integration-deep',
    'v3-mcp-optimization',
    'v3-memory-unification',
    'v3-performance-optimization',
    'v3-security-overhaul',
    'v3-swarm-coordination',
    'verification-quality',
  ];

  for (const skill of knownFixed) {
    it(`${skill}: name field matches directory name`, () => {
      const skillMdPath = join(SKILLS_DIR, skill, 'SKILL.md');
      if (!existsSync(skillMdPath)) return; // skip if skill not present in this build
      const content = readFileSync(skillMdPath, 'utf-8');
      const name = parseSkillName(content);
      expect(name).toBe(skill);
    });
  }
});
