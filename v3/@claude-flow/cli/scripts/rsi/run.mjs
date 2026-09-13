#!/usr/bin/env node
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { MAX_BUNDLE_BYTES, runExperiment, signResult, replay } from './experiment.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--config', '--bundle', '--public-key'].includes(args[i]) || !args[i + 1] || args[i] in options) throw new Error('invalid or duplicate option');
    options[args[i]] = args[i + 1];
  }
  const read = (path, max) => { if (statSync(path).size > max) throw new Error('input too large'); return readFileSync(path, 'utf8'); };
  if (command === 'run') {
    if (!options['--out'] || options['--bundle'] || options['--public-key']) throw new Error('run requires --out; optional --config');
    const start = performance.now();
    const result = runExperiment(options['--config'] ? JSON.parse(read(options['--config'], 4096)) : {});
    const bundle = signResult(result);
    // Explicit new destination only. No overwrite, append, auto-serve or resume.
    const encoded = JSON.stringify(bundle) + '\n';
    if (Buffer.byteLength(encoded) > MAX_BUNDLE_BYTES) throw new Error('output too large to replay');
    writeFileSync(options['--out'], encoded, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ summary: result.summary, totalWallMs: performance.now() - start, publicKey: bundle.publicKey, note: 'Pin this public key independently before replay. Self-signing is not independent attestation.' }, null, 2));
  } else if (command === 'replay') {
    if (!options['--bundle'] || !options['--public-key'] || options['--config'] || options['--out']) throw new Error('replay requires --bundle and --public-key');
    const bundle = JSON.parse(read(options['--bundle'], MAX_BUNDLE_BYTES));
    console.log(JSON.stringify(replay(bundle, read(options['--public-key'], 4096)), null, 2));
  } else throw new Error('usage: node run.mjs run --out FILE [--config FILE] | replay --bundle FILE --public-key FILE');
} catch (error) { console.error(error.message); process.exitCode = 1; }
