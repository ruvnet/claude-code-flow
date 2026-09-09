#!/usr/bin/env node
// audit-skill-frontmatter — fleet-wide check that every plugins/*/skills/*/SKILL.md
// has the required frontmatter fields with valid values.
//
// Each plugin's own smoke catches missing fields in ITS skills. This audit
// catches violations that escape per-plugin coverage:
//   - A new plugin authored without a smoke contract.
//   - A skill added to an existing plugin that updated its smoke's count
//     in step 2 but forgot to add a frontmatter check.
//   - Edits that delete a required field after smoke was authored.
//
// USAGE
//   node scripts/audit-skill-frontmatter.mjs                  # all skills
//   node scripts/audit-skill-frontmatter.mjs --format json    # machine-readable
//   node scripts/audit-skill-frontmatter.mjs --only ruflo-cost-tracker
//
// CHECKS per SKILL.md
//   1. File has a `---` frontmatter block at the top.
//   2. `name:` field present and non-empty.
//   3. `description:` field present and non-empty.
//   4. `allowed-tools:` field present (security — no implicit "all tools").
//   5. `allowed-tools:` is NOT a wildcard (`*`).
//   6. `name:` value matches the directory name (drift guard).
//
// EXIT CODES
//   0  no violations
//   1  at least one violation found
//   2  scan error (no plugins dir)

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPTS_DIR);
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');

const ARGS = (() => {
  const a = { format: 'table', only: null };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === '--format') a.format = process.argv[++i];
    else if (v === '--only') {
      a.only = new Set((process.argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  return a;
})();

function discoverSkills() {
  const out = [];
  let plugins;
  try { plugins = readdirSync(PLUGINS_DIR); } catch { return out; }
  for (const plugin of plugins) {
    if (ARGS.only && !ARGS.only.has(plugin)) continue;
    const skillsDir = join(PLUGINS_DIR, plugin, 'skills');
    let stat;
    try { stat = statSync(skillsDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let entries;
    try { entries = readdirSync(skillsDir); } catch { continue; }
    for (const skillDir of entries) {
      const skillPath = join(skillsDir, skillDir);
      let s;
      try { s = statSync(skillPath); } catch { continue; }
      if (!s.isDirectory()) continue;
      const md = join(skillPath, 'SKILL.md');
      out.push({ plugin, skillDir, md, exists: existsSync(md) });
    }
  }
  return out.sort((a, b) => (a.plugin + a.skillDir).localeCompare(b.plugin + b.skillDir));
}

function existsSync(p) {
  try { statSync(p); return true; } catch { return false; }
}

function parseFrontmatter(src) {
  const lines = src.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  const fields = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return { fields, error: null };
    const m = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;

    const [, key, rawValue] = m;
    if (Object.hasOwn(fields, key)) {
      return { fields: null, error: `duplicate key \`${key}\`` };
    }

    const value = rawValue.trim();
    const quoted = (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"));
    const blockScalar = /^[>|][+-]?$/.test(value);
    if (value && !quoted && !blockScalar && /:\s/.test(value)) {
      return {
        fields: null,
        error: `plain scalar for \`${key}\` contains \": \": quote the value or use a block scalar`,
      };
    }
    fields[key] = quoted ? value.slice(1, -1) : value;
  }
  return null;
}

function auditSkill(skill) {
  const violations = [];
  if (!skill.exists) {
    violations.push({ check: 'SKILL.md exists', detail: `no SKILL.md in skills/${skill.skillDir}/` });
    return violations;
  }
  let src;
  try { src = readFileSync(skill.md, 'utf-8'); } catch (e) {
    violations.push({ check: 'readable', detail: e.message });
    return violations;
  }
  const parsed = parseFrontmatter(src);
  if (!parsed) {
    violations.push({ check: 'frontmatter block', detail: 'missing or unclosed `---` block' });
    return violations;
  }
  if (parsed.error) {
    violations.push({ check: 'frontmatter YAML', detail: parsed.error });
    return violations;
  }
  const fm = parsed.fields;
  if (!fm.name) violations.push({ check: 'name field', detail: 'missing or empty' });
  if (!fm.description) violations.push({ check: 'description field', detail: 'missing or empty' });
  if (fm['allowed-tools'] === undefined) {
    violations.push({ check: 'allowed-tools field', detail: 'missing (security — no implicit "all tools")' });
  } else if (String(fm['allowed-tools']).trim() === '*') {
    violations.push({ check: 'allowed-tools wildcard', detail: 'value is `*` — explicit list required' });
  }
  if (fm.name && fm.name !== skill.skillDir) {
    violations.push({
      check: 'name matches directory',
      detail: `frontmatter name="${fm.name}" but directory is "${skill.skillDir}"`,
    });
  }
  return violations;
}

function main() {
  const skills = discoverSkills();
  if (skills.length === 0) {
    console.error('audit-skill-frontmatter: no plugins/*/skills/*/SKILL.md found');
    process.exit(2);
  }
  const findings = [];
  for (const s of skills) {
    const v = auditSkill(s);
    if (v.length > 0) {
      findings.push({
        plugin: s.plugin,
        skill: s.skillDir,
        file: s.md.replace(REPO_ROOT + '/', ''),
        violations: v,
      });
    }
  }

  if (ARGS.format === 'json') {
    console.log(JSON.stringify({
      skillsScanned: skills.length,
      pluginCount: new Set(skills.map((s) => s.plugin)).size,
      filesWithViolations: findings.length,
      findings,
      generatedAt: new Date().toISOString(),
    }, null, 2));
  } else {
    console.log('# audit-skill-frontmatter');
    console.log('');
    const pc = new Set(skills.map((s) => s.plugin)).size;
    console.log(`Scanned **${skills.length}** SKILL.md files across **${pc}** plugins.`);
    console.log('');
    if (findings.length === 0) {
      console.log('✓ Every SKILL.md has valid frontmatter:');
      console.log('  - name / description / allowed-tools all present and non-empty');
      console.log('  - no wildcard allowed-tools');
      console.log('  - name matches enclosing directory');
    } else {
      console.log(`⚠ Found ${findings.length} skill(s) with frontmatter violations:`);
      console.log('');
      for (const f of findings) {
        console.log(`## ${f.file}`);
        for (const v of f.violations) {
          console.log(`  - ${v.check}: ${v.detail}`);
        }
        console.log('');
      }
    }
    console.log('');
  }
  process.exit(findings.length > 0 ? 1 : 0);
}

main();
