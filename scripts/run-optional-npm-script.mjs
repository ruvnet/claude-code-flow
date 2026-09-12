#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , packageDir, scriptName] = process.argv;

if (!packageDir || !scriptName) {
  console.error('Usage: node scripts/run-optional-npm-script.mjs <package-dir> <script>');
  process.exit(1);
}

if (!/^[\w:.-]+$/.test(scriptName)) {
  console.error(`[optional-script] invalid script name: ${scriptName}`);
  process.exit(1);
}

const packageRoot = resolve(packageDir);
const packageJsonPath = resolve(packageRoot, 'package.json');

if (!existsSync(packageJsonPath)) {
  console.warn(`[optional-script] package not found: ${packageJsonPath}`);
  process.exit(0);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

if (!packageJson.scripts?.[scriptName]) {
  console.warn(`[optional-script] ${packageDir} has no "${scriptName}" script; skipping`);
  process.exit(0);
}

const result = process.platform === 'win32'
  ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm run ${scriptName}`], {
      cwd: packageRoot,
      stdio: 'inherit',
      shell: false,
    })
  : spawnSync('npm', ['run', scriptName], {
      cwd: packageRoot,
      stdio: 'inherit',
      shell: false,
    });

if (result.error) {
  console.warn(`[optional-script] ${scriptName} failed to start: ${result.error.message}`);
}

if (result.status && result.status !== 0) {
  console.warn(`[optional-script] ${scriptName} exited with ${result.status}; continuing`);
}

process.exit(0);
