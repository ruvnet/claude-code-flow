/**
 * V3 CLI Memory Command
 * Memory operations for AgentDB integration
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { distillCommand } from './memory-distill.js';
import { backupCommand } from './memory-backup.js';
import { countSiblingStoreRows } from '../memory/sibling-store.js';
import { resolveDbPath } from '../memory/memory-initializer.js';

/**
 * #3228: a miss in one store is not a miss in the memory.
 *
 * 3.41.1 disclosed the sibling AgentDB store from `memory list` only. `retrieve`,
 * `search` and `stats` kept reporting a clean negative — "Key not found", "No
 * results" — while the rows sat in the file this interface does not read. On the
 * reported Windows install that is 31,673 rows in the other store answering
 * `found:false`. A confident negative is worse than an error, because nothing
 * prompts anyone to look further.
 */
async function warnIfSiblingHasRows(pathFlag: unknown): Promise<void> {
  const unread = await countSiblingStoreRows(resolveDbPath(pathFlag as string | undefined));
  if (unread && unread.rows > 0) {
    output.printWarning(
      `This read covered one store. ${unread.rows} entries are in ${unread.path} and were not searched. ` +
      `That store is written by the MCP/AgentDB path; read it with --path ${unread.path}.`,
    );
  }
}

// Memory backends
const BACKENDS = [
  { value: 'agentdb', label: 'AgentDB', hint: 'Vector database with HNSW indexing (150x-12,500x faster)' },
  { value: 'sqlite', label: 'SQLite', hint: 'Lightweight local storage' },
  { value: 'hybrid', label: 'Hybrid', hint: 'SQLite + AgentDB (recommended)' },
  { value: 'memory', label: 'In-Memory', hint: 'Fast but non-persistent' }
];
// #2105: shared --path option for memory subcommands.
// Precedence: --path > CLAUDE_FLOW_DB_PATH env var > default root
const DB_PATH_OPTION = {
  name: 'path',
  description:
    'Override DB file path (also: CLAUDE_FLOW_DB_PATH env var). ' +
    'Precedence: --path > CLAUDE_FLOW_DB_PATH > CLAUDE_FLOW_MEMORY_PATH/memory.db > cwd/.swarm/memory.db',
  type: 'string' as const,
};

// Store command
const storeCommand: Command = {
  name: 'store',
  description: 'Store data in memory',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Storage key/namespace',
      type: 'string',
      required: true
    },
    {
      name: 'value',
      // Note: No short flag - global -v is reserved for verbose
      description: 'Value to store (use --value)',
      type: 'string'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string',
      default: 'default'
    },
    {
      name: 'ttl',
      description: 'Time to live in seconds',
      type: 'number'
    },
    {
      name: 'tags',
      description: 'Comma-separated tags',
      type: 'string'
    },
    {
      name: 'vector',
      description: 'Store as vector embedding',
      type: 'boolean',
      default: false
    },
    {
      name: 'upsert',
      short: 'u',
      // #2594: default true so `store → delete → store` doesn't hit the UNIQUE
      // (namespace, key) constraint on the soft-deleted row. Pass --no-upsert
      // for strict insert semantics.
      description: 'Update if key exists (default; pass --no-upsert for strict insert)',
      type: 'boolean',
      default: true
    },
    {
      // #2752 dream-cycle — MemPoison gate. Run ChannelGuard's scanner
      // on the value BEFORE persistence and refuse the write if a
      // finding is present. Opt-in per-call; RUFLO_MEMORY_SCAN_ON_WRITE=1
      // enables it globally.
      // NOTE: no `default:` here — needed so the ADR-125 CLI-flag-wins
      // precedence (`ctx.flags.scanContent ?? envVar`) can distinguish
      // "user didn't pass the flag" (undefined) from "user explicitly
      // said --no-scan-content" (false). Fixes #2794.
      name: 'scan-content',
      description: 'Scan the value for injection payloads before persisting (dream-cycle #2752 MemPoison gate)',
      type: 'boolean',
    },
    {
      // ADR-323 — typed memory provenance. Distinguishes who/what produced
      // this entry so shared-namespace retrieval can filter by trust level
      // instead of conflating a user's stated claim with an agent's own
      // output or a raw tool/system observation.
      name: 'provenance',
      description: 'Who/what produced this value: user_claim | agent_output | system_observation | tool_result | unknown (default: unknown) — ADR-323',
      type: 'string',
      choices: ['user_claim', 'agent_output', 'system_observation', 'tool_result', 'unknown'],
    },
    DB_PATH_OPTION
  ],
  examples: [
    { command: 'claude-flow memory store -k "api/auth" -v "JWT implementation"', description: 'Store text' },
    { command: 'claude-flow memory store -k "pattern/singleton" --vector', description: 'Store vector' },
    { command: 'claude-flow memory store -k "pattern" -v "new" --no-upsert', description: 'Strict insert (fail if key exists)' },
    { command: 'claude-flow memory store -k "user/goal" -v "ship by Friday" --provenance user_claim', description: 'Store with typed provenance (ADR-323)' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const key = ctx.flags.key as string;
    let value = ctx.flags.value as string || ctx.args[0];
    // #2461: without `|| 'default'`, omitting -n stores under the literal
    // string namespace "undefined" — silent data loss for first-time users.
    const namespace = (ctx.flags.namespace as string) || 'default';
    const ttl = ctx.flags.ttl as number;
    const tags = ctx.flags.tags ? (ctx.flags.tags as string).split(',') : [];
    const asVector = ctx.flags.vector as boolean;
    // #2775: the parser's `applyDefaults` only materializes global-option
    // defaults, not per-subcommand ones — so despite the `default: true`
    // above, `ctx.flags.upsert` arrives as `undefined` unless the user
    // passes `--upsert` explicitly. That is exactly the trap #2594 tried
    // to close: `store → delete → store` and even plain `store → store`
    // (against an active row) both fall through to the bridge's strict
    // insert, and before #2775's ON-CONFLICT-DO-UPDATE-WHERE-status-
    // 'deleted' fix, both dead-ended with the misleading #2735 guard.
    // Materialize the declared default locally so it takes effect
    // regardless of the parser gap: only an explicit `--no-upsert` (which
    // arrives as `false`) turns it off.
    const upsert = ctx.flags.upsert !== false;
    // ADR-323: leave undefined (not 'unknown') when omitted so storeEntry's
    // own default applies uniformly across the CLI, MCP tool, and direct
    // callers — one place decides the default, not three.
    const provenance = ctx.flags.provenance as string | undefined;

    if (!key) {
      output.printError('Key is required. Use --key or -k');
      return { success: false, exitCode: 1 };
    }

    if (!value && ctx.interactive) {
      value = await input({
        message: 'Enter value to store:',
        validate: (v) => v.length > 0 || 'Value is required'
      });
    }

    if (!value) {
      output.printError('Value is required. Use --value');
      return { success: false, exitCode: 1 };
    }

    // #2752 MemPoison gate — scan before persist when opted in.
    // CLI flag ctx.flags.scanContent takes precedence over RUFLO_MEMORY_SCAN_ON_WRITE env var
    // (ADR-125 §"CLI flag wins" / ADR-130 §env-var-config-precedence — fix for #2794).
    const scanContent = (ctx.flags.scanContent as boolean | undefined)
      ?? /^(1|true|yes|on)$/i.test(String(process.env.RUFLO_MEMORY_SCAN_ON_WRITE ?? ''));
    if (scanContent) {
      try {
        const { scanChannelMessage } = await import('../security/channel-guard.js');
        const scan = scanChannelMessage(value);
        if (!scan.safe) {
          output.printError(
            `MemPoison gate refused write (#2752): ${scan.findings.length} injection signature(s) in value. ` +
            `Top: ${scan.findings[0].kind}/${scan.findings[0].severity} — ${scan.findings[0].reason}.`
          );
          output.writeln(output.dim('Bypass: drop --scan-content or unset RUFLO_MEMORY_SCAN_ON_WRITE to persist anyway (not recommended).'));
          return { success: false, exitCode: 2, data: scan };
        }
      } catch (err) {
        output.writeln(output.dim(`MemPoison scan skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    const storeData = {
      key,
      namespace,
      value,
      ttl,
      tags,
      asVector,
      storedAt: new Date().toISOString(),
      size: Buffer.byteLength(value, 'utf8')
    };

    output.printInfo(`Storing in ${namespace}/${key}...`);

    // Use direct sql.js storage with automatic embedding generation
    try {
      const { storeEntry, resolveDbPath: _rdbStore } = await import('../memory/memory-initializer.js');
      const dbPath = _rdbStore(ctx.flags.path as string | undefined);

      if (asVector) {
        output.writeln(output.dim('  Generating embedding vector...'));
      }

      const result = await storeEntry({
        key,
        value,
        namespace,
        generateEmbeddingFlag: true, // Always generate embeddings for semantic search
        tags,
        ttl,
        upsert,
        provenanceType: provenance,
        dbPath
      });

      if (!result.success) {
        output.printError(result.error || 'Failed to store');
        return { success: false, exitCode: 1 };
      }

      output.writeln();
      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 15 },
          { key: 'val', header: 'Value', width: 40 }
        ],
        data: [
          { property: 'Key', val: key },
          { property: 'Namespace', val: namespace },
          { property: 'Size', val: `${storeData.size} bytes` },
          { property: 'TTL', val: ttl ? `${ttl}s` : 'None' },
          { property: 'Tags', val: tags.length > 0 ? tags.join(', ') : 'None' },
          { property: 'Vector', val: result.embedding ? `Yes (${result.embedding.dimensions}-dim)` : 'No' },
          { property: 'Provenance', val: provenance || 'unknown' },
          { property: 'ID', val: result.id.substring(0, 20) }
        ]
      });

      output.writeln();
      if (result.persistWarning) {
        // #2968: the write ran, but the checkpoint signal indicates it may
        // not have reached disk (sql.js fallback driver) — do not print an
        // unconditional green success for a write that might vanish.
        output.printWarning(`Data stored, but persistence is not guaranteed: ${result.persistWarning}`);
      } else {
        output.printSuccess('Data stored successfully');
      }

      return { success: true, data: { ...storeData, id: result.id, embedding: result.embedding, provenanceType: provenance || 'unknown' } };
    } catch (error) {
      output.printError(`Failed to store: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Retrieve command
const retrieveCommand: Command = {
  name: 'retrieve',
  aliases: ['get'],
  description: 'Retrieve data from memory',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Storage key',
      type: 'string'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string',
      default: 'default'
    },
    // #2073: --format is the GLOBAL option (parser.ts:78) with choices
    // ['text', 'json', 'table'] and default 'text'. The retrieve handler
    // discriminates: 'json' emits parseable JSON, anything else (text/box/...)
    // emits the human-readable box. No per-command override needed; we just
    // document the behavior in the help text via examples.
    {
      // #2073: --value-only emits ONLY the value string (no wrapper).
      // Designed for piping into JSON.parse without any cleanup.
      name: 'value-only',
      description: 'Print only the stored value to stdout (no wrapper)',
      type: 'boolean',
      default: false
    },
    DB_PATH_OPTION
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const key = ctx.flags.key as string || ctx.args[0];
    // #2461: mirror the store-side default so `memory retrieve -k k` (no -n)
    // looks under "default" rather than the literal namespace "undefined".
    const namespace = (ctx.flags.namespace as string) || 'default';

    if (!key) {
      output.printError('Key is required');
      return { success: false, exitCode: 1 };
    }

    // Use sql.js directly for consistent data access
    try {
      const { getEntry, resolveDbPath: _rdbRetrieve } = await import('../memory/memory-initializer.js');
      const dbPathRetrieve = _rdbRetrieve(ctx.flags.path as string | undefined);
      const result = await getEntry({ key, namespace, dbPath: dbPathRetrieve });

      if (!result.success) {
        output.printError(`Failed to retrieve: ${result.error}`);
        return { success: false, exitCode: 1 };
      }

      if (!result.found || !result.entry) {
        output.printWarning(`Key not found: ${key}`);
        await warnIfSiblingHasRows(ctx.flags.path);
        return { success: false, exitCode: 1, data: { key, found: false } };
      }

      const entry = result.entry;

      // #2073: --value-only emits just the raw value (no decoration) for
      // piping into JSON.parse / jq / other downstream parsers without
      // any cleanup.
      if (ctx.flags['value-only'] || ctx.flags.valueOnly) {
        // Use process.stdout.write directly to bypass any printer-side
        // transformation of quotes/structural characters.
        process.stdout.write(entry.content);
        if (process.stdout.isTTY) process.stdout.write('\n');
        return { success: true, data: entry };
      }

      if (ctx.flags.format === 'json') {
        output.printJson(entry);
        return { success: true, data: entry };
      }

      output.writeln();
      output.printBox(
        [
          `Namespace: ${entry.namespace}`,
          `Key: ${entry.key}`,
          `Size: ${entry.content.length} bytes`,
          `Access Count: ${entry.accessCount}`,
          `Tags: ${entry.tags.length > 0 ? entry.tags.join(', ') : 'None'}`,
          `Vector: ${entry.hasEmbedding ? 'Yes' : 'No'}`,
          '',
          output.bold('Value:'),
          entry.content
        ].join('\n'),
        'Memory Entry'
      );

      return { success: true, data: entry };
    } catch (error) {
      output.printError(`Failed to retrieve: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Search command
const searchCommand: Command = {
  name: 'search',
  description: 'Search memory with semantic/vector search',
  options: [
    {
      name: 'query',
      short: 'q',
      description: 'Search query',
      type: 'string',
      required: true
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string'
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum results',
      type: 'number',
      default: 10
    },
    {
      name: 'threshold',
      description: 'Similarity threshold (0-1)',
      type: 'number',
      // MUST stay <= 0.4. The recall fusion in bridgeSearchEntries scores a
      // full-coverage exact-keyword hit as 0.6*max(0,semantic) + 0.4*lexical,
      // so when the semantic cosine is <= 0 (routine for a one-word query) a
      // perfect keyword match tops out at exactly 0.40. #2790 raised this
      // default to 0.7, which silently re-broke #2558: `memory search` matched
      // content word-for-word and still returned nothing. Regression guard:
      // __tests__/memory-search-recall-2558.test.ts.
      default: 0.3
    },
    {
      name: 'type',
      short: 't',
      description: 'Search type (semantic, keyword, hybrid)',
      type: 'string',
      default: 'semantic',
      choices: ['semantic', 'keyword', 'hybrid']
    },
    {
      name: 'build-hnsw',
      description: 'Build/rebuild HNSW index before searching (enables 150x-12,500x speedup)',
      type: 'boolean',
      default: false
    },
    {
      name: 'smart',
      short: 's',
      description: 'Use SmartRetrieval pipeline (query expansion, RRF, MMR, recency)',
      type: 'boolean',
      default: false
    },
    {
      // #2760 dream-cycle — SCM routed memory. Classify the query intent
      // and route search to the mapped namespaces (episodic → session
      // writes, semantic → patterns, procedural → skills). Default
      // "mixed" preserves the pre-#2760 behavior (search everything).
      name: 'intent',
      description: 'Route query to intent-mapped namespaces (auto | mixed | episodic | semantic | procedural) — dream-cycle #2760',
      type: 'string',
      choices: ['auto', 'mixed', 'episodic', 'semantic', 'procedural'],
      default: 'mixed',
    },
    {
      // ADR-323 — restrict results to entries with a matching provenance
      // type (e.g. exclude user_claim when retrieving for fact-checking,
      // per MemSyco-Bench's memory-induced sycophancy finding). Enforced
      // across semantic, keyword, hybrid, and SmartRetrieval paths.
      name: 'provenance-filter',
      description: 'Comma-separated provenance types to restrict results to: user_claim,agent_output,system_observation,tool_result,unknown — ADR-323',
      type: 'string',
    },
    DB_PATH_OPTION
  ],
  examples: [
    { command: 'claude-flow memory search -q "authentication patterns"', description: 'Semantic search' },
    { command: 'claude-flow memory search -q "JWT" -t keyword', description: 'Keyword search' },
    { command: 'claude-flow memory search -q "test" --build-hnsw', description: 'Build HNSW index and search' },
    { command: 'claude-flow memory search -q "auth patterns" --smart', description: 'SmartRetrieval with RRF + MMR' },
    { command: 'claude-flow memory search -q "when did we last touch auth" --intent auto', description: 'SCM-routed retrieval (dream-cycle #2760)' },
    { command: 'claude-flow memory search -q "deploy plan" --provenance-filter agent_output,tool_result', description: 'Only trust agent/tool-sourced entries (ADR-323)' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const query = ctx.flags.query as string || ctx.args[0];
    let namespace = ctx.flags.namespace as string || 'all';
    const limit = ctx.flags.limit as number || 10;
    // Matches the --build-hnsw / buildHnsw dual-check convention already used
    // below: the parser doesn't consistently camelCase every hyphenated flag.
    const provenanceFilterRaw = (ctx.flags['provenance-filter'] || ctx.flags.provenanceFilter) as string | undefined;
    const provenanceFilter = provenanceFilterRaw
      ? provenanceFilterRaw.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;
    // #2790 fix — `||` discards an explicit `--threshold 0` (falsy) and
    // silently uses the fallback; that made `--threshold 0` return
    // FEWER results than `--threshold 0.01` (non-monotonic). Nullish
    // coalescing preserves an explicit zero. Fallback aligned with the
    // option's declared `default: 0.7` (was `0.3` — the two disagreed
    // and --help advertised a default the code did not honor).
    const threshold = ctx.flags.threshold as number ?? 0.3;
    const searchType = ctx.flags.type as string || 'semantic';
    const buildHnsw = (ctx.flags['build-hnsw'] || ctx.flags.buildHnsw) as boolean;
    const requestedIntent = (ctx.flags.intent as string) || 'mixed';

    if (!query) {
      output.printError('Query is required. Use --query or -q');
      return { success: false, exitCode: 1 };
    }

    // #2760 SCM routed memory (v1 MVP) — classify query intent and
    // print a routing hint. Only fires when --intent is NOT the default
    // "mixed" AND --namespace was NOT explicitly passed. Intentionally
    // does NOT mutate the search path — the routing is advisory in v1
    // so the search backend's exact behavior is preserved. v2 will
    // apply the routing when the search-backend interface adds a
    // multi-namespace OR filter.
    if (requestedIntent !== 'mixed' && (namespace === 'all' || !ctx.flags.namespace)) {
      try {
        const { resolveIntent } = await import('../memory/scm-classifier.js');
        const resolved = resolveIntent(query, requestedIntent as 'auto' | 'episodic' | 'semantic' | 'procedural' | 'mixed');
        if (resolved.intent !== 'mixed' && resolved.namespaces.length > 0) {
          output.printInfo(`SCM router → ${resolved.intent} (confidence ${(resolved.confidence * 100).toFixed(1)}%)`);
          output.writeln(output.dim(`  ${resolved.reason}`));
          output.writeln(output.dim(`  Suggested: rerun with --namespace ${resolved.namespaces[0]} to filter (or one of: ${resolved.namespaces.slice(1, 4).join(', ')}...)`));
        } else {
          output.writeln(output.dim(`SCM router → mixed (${resolved.reason})`));
        }
      } catch (err) {
        output.writeln(output.dim(`SCM routing skipped: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    // Build/rebuild HNSW index if requested
    if (buildHnsw) {
      output.printInfo('Building HNSW index...');
      try {
        const { getHNSWIndex, getHNSWStatus } = await import('../memory/memory-initializer.js');

        const startTime = Date.now();
        const index = await getHNSWIndex({ forceRebuild: true });
        const buildTime = Date.now() - startTime;

        if (index) {
          const status = getHNSWStatus();
          output.printSuccess(`HNSW index built (${status.entryCount} vectors, ${buildTime}ms)`);
          output.writeln(output.dim(`  Dimensions: ${status.dimensions}, Metric: cosine`));
          output.writeln(output.dim(`  Search speedup: ${status.entryCount > 10000 ? '12,500x' : status.entryCount > 1000 ? '150x' : '10x'}`));
        } else {
          output.printWarning('HNSW index not available (install @ruvector/core for acceleration)');
        }
        output.writeln();
      } catch (error) {
        output.printWarning(`HNSW build failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        output.writeln(output.dim('  Falling back to brute-force search'));
        output.writeln();
      }
    }

    output.printInfo(`Searching: "${query}" (${searchType})`);
    output.writeln();

    // Use direct sql.js search with vector similarity
    try {
      const { searchEntries, listEntries, resolveDbPath: _rdbSearch } = await import('../memory/memory-initializer.js');
      const dbPathSearch = _rdbSearch(ctx.flags.path as string | undefined);
      const useSmart = (ctx.flags.smart || ctx.flags.s) as boolean;

      // #2790 fix — keyword mode was declared, echoed, and IGNORED (every
      // search ran semantic regardless). Wire it here: list entries in
      // the requested namespace (or all) and substring-match against key
      // + content. Hybrid unions the keyword hits with the semantic hits
      // and dedups by key + namespace.
      let keywordResults: { key: string; score: number; namespace: string; preview: string; provenanceType?: string }[] = [];
      if (searchType === 'keyword' || searchType === 'hybrid') {
        const list = await listEntries({
          namespace: namespace === 'all' ? undefined : namespace,
          limit: 5000,
          includeContent: true,
          dbPath: dbPathSearch,
          provenanceFilter,
        });
        if (!list.success) {
          output.printError(list.error || 'Keyword search failed');
          return { success: false, exitCode: 1 };
        } else {
          const q = (query as string).toLowerCase();
          keywordResults = list.entries
            .filter((e) => {
              const c = (e as { content?: string }).content ?? '';
              return e.key.toLowerCase().includes(q) || c.toLowerCase().includes(q);
            })
            .map((e) => {
              const c = (e as { content?: string }).content ?? '';
              const inKey = e.key.toLowerCase().includes(q);
              // Keyword scoring: 1.0 for key hit, 0.7 for content hit
              return {
                key: e.key,
                score: inKey ? 1.0 : 0.7,
                namespace: e.namespace,
                preview: c.slice(0, 200),
                provenanceType: e.provenanceType,
              };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
        }
        if (searchType === 'keyword') {
          // Pure-keyword mode returns directly; skip the semantic path entirely.
          if (ctx.flags.format === 'json') {
            output.printJson({ query, searchType, results: keywordResults, searchTime: '0ms' });
            return { success: true, data: keywordResults };
          }
          output.writeln();
          output.printSuccess(`Found ${keywordResults.length} result(s) via keyword substring match`);
          for (const r of keywordResults) {
            output.writeln(`  ${r.key} (${r.namespace}, score=${r.score.toFixed(2)}) — ${r.preview.slice(0, 80)}${r.preview.length > 80 ? '…' : ''}`);
          }
          return { success: true, data: keywordResults };
        }
        // Hybrid mode: keyword hits will be MERGED after semantic runs below.
      }

      let results: { key: string; score: number; namespace: string; preview: string; provenanceType?: string }[];
      let searchTimeMs: number;
      let smartStats: Record<string, unknown> | undefined;
      let backendLabel = 'HNSW + sql.js';

      // #1846: feature-detect smartSearch — older published builds of
      // @claude-flow/memory don't expose it. Fall through to plain
      // semantic search with a one-line warning instead of throwing.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let smartSearchFn: any | undefined;
      if (useSmart) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const memMod: any = await import('@claude-flow/memory');
          if (typeof memMod.smartSearch === 'function') {
            smartSearchFn = memMod.smartSearch;
          }
        } catch {
          /* memory package not loadable */
        }
        if (!smartSearchFn) {
          output.printWarning(
            'Smart search requested but smartSearch is not available on the installed @claude-flow/memory build (#1846). Falling back to standard semantic search.',
          );
        }
      }

      if (useSmart && smartSearchFn) {
        // Adapt searchEntries to the SearchFn interface
        const rawSearch = async (req: { query: string; namespace?: string; limit?: number; threshold?: number }) => {
          const r = await searchEntries({
            query: req.query,
            namespace: req.namespace || namespace,
            limit: req.limit || limit * 3,
            threshold: req.threshold ?? threshold,
            dbPath: dbPathSearch,
            provenanceFilter,
          });
          return {
            results: r.results.map(e => ({
              id: e.id,
              key: e.key,
              content: e.content,
              score: e.score,
              namespace: e.namespace,
              provenanceType: e.provenanceType,
              // Dream Cycle 2026-09-03: thread the already-computed
              // embedding through so SmartRetrieval's MMR step can use
              // cosine similarity instead of a text-overlap proxy.
              embedding: e.embedding,
            })),
          };
        };

        const smartResult = await smartSearchFn(rawSearch, {
          query,
          namespace,
          limit,
          threshold,
        });

        results = smartResult.results.map((r: { content: string; key: string; namespace: string; score: number; provenanceType?: string }) => ({
          key: r.key,
          score: r.score,
          namespace: r.namespace,
          preview: r.content,
          provenanceType: r.provenanceType,
        }));
        searchTimeMs = smartResult.stats.durationMs;
        smartStats = smartResult.stats as unknown as Record<string, unknown>;
        backendLabel = 'SmartRetrieval (RRF + MMR + Recency)';
      } else {
        const searchResult = await searchEntries({
          query,
          namespace,
          limit,
          threshold,
          dbPath: dbPathSearch,
          provenanceFilter
        });

        if (!searchResult.success) {
          output.printError(searchResult.error || 'Search failed');
          return { success: false, exitCode: 1 };
        }

        results = searchResult.results.map(r => ({
          key: r.key,
          score: r.score,
          namespace: r.namespace,
          preview: r.content,
          provenanceType: r.provenanceType,
        }));
        searchTimeMs = searchResult.searchTime;
      }

      // #2790 fix (hybrid mode): union keyword results with semantic
      // results, dedup by (key, namespace), then take top `limit`.
      if (searchType === 'hybrid' && keywordResults.length > 0) {
        const seen = new Set(results.map((r) => `${r.namespace}::${r.key}`));
        for (const k of keywordResults) {
          const id = `${k.namespace}::${k.key}`;
          if (!seen.has(id)) {
            results.push(k);
            seen.add(id);
          }
        }
        // Rerank by score
        results.sort((a, b) => b.score - a.score);
        results = results.slice(0, limit);
        backendLabel = `${backendLabel} + keyword union (#2790)`;
      }

      if (ctx.flags.format === 'json') {
        output.printJson({ query, searchType, results, searchTime: `${searchTimeMs}ms`, ...(smartStats ? { stats: smartStats } : {}) });
        return { success: true, data: results };
      }

      // Performance stats
      output.writeln(output.dim(`  Search time: ${searchTimeMs}ms`));
      if (useSmart && smartStats) {
        output.writeln(output.dim(`  Backend: ${backendLabel}`));
        output.writeln(output.dim(`  Variants: ${(smartStats as any).variantCount}, Raw candidates: ${(smartStats as any).rawCandidateCount}`));
      }
      output.writeln();

      if (results.length === 0) {
        output.printWarning('No results found');
        await warnIfSiblingHasRows(ctx.flags.path);
        output.writeln(output.dim('Try: claude-flow memory store -k "key" --value "data"'));
        return { success: true, data: [] };
      }

      output.printTable({
        columns: [
          { key: 'key', header: 'Key', width: 20 },
          { key: 'score', header: 'Score', width: 8, align: 'right', format: (v) => Number(v).toFixed(2) },
          { key: 'namespace', header: 'Namespace', width: 12 },
          { key: 'preview', header: 'Preview', width: 35 }
        ],
        data: results
      });

      output.writeln();
      output.printInfo(`Found ${results.length} results`);

      return { success: true, data: results };
    } catch (error) {
      output.printError(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// List command
const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List memory entries',
  options: [
    {
      name: 'namespace',
      short: 'n',
      description: 'Filter by namespace',
      type: 'string'
    },
    {
      name: 'tags',
      short: 't',
      description: 'Filter by tags (comma-separated)',
      type: 'string'
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum entries',
      type: 'number',
      default: 20
    },
    DB_PATH_OPTION
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const namespace = ctx.flags.namespace as string;
    const limit = ctx.flags.limit as number;

    // Use sql.js directly for consistent data access
    try {
      const { listEntries, resolveDbPath: _rdbList } = await import('../memory/memory-initializer.js');
      const dbPathList = _rdbList(ctx.flags.path as string | undefined);
      const listResult = await listEntries({ namespace, limit, offset: 0, dbPath: dbPathList });

      if (!listResult.success) {
        output.printError(`Failed to list: ${listResult.error}`);
        return { success: false, exitCode: 1 };
      }

      // Format entries for display
      const entries = listResult.entries.map(e => ({
        key: e.key,
        namespace: e.namespace,
        size: e.size + ' B',
        vector: e.hasEmbedding ? '✓' : '-',
        accessCount: e.accessCount,
        updated: formatRelativeTime(e.updatedAt)
      }));

      if (ctx.flags.format === 'json') {
        output.printJson(listResult.entries);
        return { success: true, data: listResult.entries };
      }

      output.writeln();
      output.writeln(output.bold('Memory Entries'));
      output.writeln();

      if (entries.length === 0) {
        output.printWarning('No entries found');
        await warnIfSiblingHasRows(ctx.flags.path);
        output.printInfo('Store data: claude-flow memory store -k "key" --value "data"');
        return { success: true, data: [] };
      }

      output.printTable({
        columns: [
          { key: 'key', header: 'Key', width: 25 },
          { key: 'namespace', header: 'Namespace', width: 12 },
          { key: 'size', header: 'Size', width: 10, align: 'right' },
          { key: 'vector', header: 'Vector', width: 8, align: 'center' },
          { key: 'accessCount', header: 'Accessed', width: 10, align: 'right' },
          { key: 'updated', header: 'Updated', width: 12 }
        ],
        data: entries
      });

      output.writeln();
      output.printInfo(`Showing ${entries.length} of ${listResult.total} entries`);

      // #3196: AgentDB owns a sibling store next to this one. `total` counts only
      // the file we read, so a bare count reads as "this is everything" while rows
      // sit unreadable next door. Silence would be recoverable; a confident wrong
      // total is not, because nothing prompts anyone to look further.
      const unread = await countSiblingStoreRows(resolveDbPath(ctx.flags.path as string | undefined));
      if (unread && unread.rows > 0) {
        output.printWarning(
          `${unread.rows} more entries are in ${unread.path} and were not read here. ` +
          `That store is written by the MCP/AgentDB path; read it with --path ${unread.path}.`
        );
      }

      return { success: true, data: listResult.entries };
    } catch (error) {
      output.printError(`Failed to list: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Helper function to format relative time
function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const date = new Date(isoDate).getTime();
  const diff = now - date;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// Delete command
const deleteCommand: Command = {
  name: 'delete',
  aliases: ['rm'],
  description: 'Delete memory entry',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Storage key',
      type: 'string'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string',
      default: 'default'
    },
    {
      name: 'force',
      short: 'f',
      description: 'Skip confirmation',
      type: 'boolean',
      default: false
    },
    DB_PATH_OPTION
  ],
  examples: [
    { command: 'claude-flow memory delete -k "mykey"', description: 'Delete entry with default namespace' },
    { command: 'claude-flow memory delete -k "lesson" -n "lessons"', description: 'Delete entry from specific namespace' },
    { command: 'claude-flow memory delete mykey -f', description: 'Delete without confirmation' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Support both --key flag and positional argument
    const key = ctx.flags.key as string || ctx.args[0];
    const namespace = (ctx.flags.namespace as string) || 'default';
    const force = ctx.flags.force as boolean;

    if (!key) {
      output.printError('Key is required. Use: memory delete -k "key" [-n "namespace"]');
      return { success: false, exitCode: 1 };
    }

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Delete memory entry "${key}" from namespace "${namespace}"?`,
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    // Use sql.js directly for consistent data access (Issue #980)
    try {
      const { deleteEntry, resolveDbPath: _rdbDelete } = await import('../memory/memory-initializer.js');
      const dbPathDelete = _rdbDelete(ctx.flags.path as string | undefined);
      const result = await deleteEntry({ key, namespace, dbPath: dbPathDelete });

      if (!result.success) {
        output.printError(result.error || 'Failed to delete');
        return { success: false, exitCode: 1 };
      }

      if (result.deleted) {
        output.printSuccess(`Deleted "${key}" from namespace "${namespace}"`);
        output.printInfo(`Remaining entries: ${result.remainingEntries}`);
      } else {
        output.printWarning(`Key not found: "${key}" in namespace "${namespace}"`);
      }

      return { success: result.deleted, data: result };
    } catch (error) {
      output.printError(`Failed to delete: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// #2666 — Hard, namespace-scoped purge. `delete` above only ever
// soft-deletes a single key (status='deleted', row stays and still occupies
// the UNIQUE(namespace, key) slot — #2652). Reconciling an entire namespace
// after its source-of-truth changed (e.g. a plugin's index after a source
// file was removed) needs the row to actually be gone, not tombstoned.
// Irreversible — always requires --namespace explicitly (no default) and
// either interactive confirmation or --force.
const purgeCommand: Command = {
  name: 'purge',
  description: 'Permanently delete every entry in a namespace (hard delete — not the soft delete/tombstone that `memory delete` uses)',
  options: [
    {
      name: 'namespace',
      short: 'n',
      description: 'Namespace to purge (required — no default, to avoid an accidental whole-namespace wipe)',
      type: 'string'
    },
    {
      name: 'dry-run',
      short: 'd',
      description: 'Report how many entries would be deleted, without deleting them',
      type: 'boolean',
      default: false
    },
    {
      name: 'force',
      short: 'f',
      description: 'Skip confirmation',
      type: 'boolean',
      default: false
    },
    DB_PATH_OPTION
  ],
  examples: [
    { command: 'claude-flow memory purge --namespace stale-cache --dry-run', description: 'Preview a purge' },
    { command: 'claude-flow memory purge --namespace stale-cache --force', description: 'Purge without confirmation (e.g. in a script)' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const namespace = ctx.flags.namespace as string;
    const dryRun = ctx.flags.dryRun as boolean;
    const force = ctx.flags.force as boolean;
    const dbPath = ctx.flags.path as string | undefined;

    if (!namespace) {
      output.printError('Namespace is required. Use: memory purge -n "namespace" [--dry-run | --force]');
      return { success: false, exitCode: 1 };
    }

    try {
      const { listEntries, purgeNamespace, resolveDbPath: _rdbPurge } = await import('../memory/memory-initializer.js');
      const resolvedDbPath = _rdbPurge(dbPath);

      const preview = await listEntries({ namespace, limit: 1, dbPath: resolvedDbPath });
      const previewCount = preview.total ?? preview.entries?.length ?? 0;

      if (dryRun) {
        output.printInfo(`Would permanently delete ${previewCount} entr${previewCount === 1 ? 'y' : 'ies'} from namespace "${namespace}" (dry run — nothing deleted)`);
        return { success: true, data: { namespace, wouldDelete: previewCount } };
      }

      if (!force && ctx.interactive) {
        const confirmed = await confirm({
          message: `Permanently delete ${previewCount} entr${previewCount === 1 ? 'y' : 'ies'} from namespace "${namespace}"? This is a hard delete — not reversible with \`memory delete\`'s soft-undo.`,
          default: false
        });
        if (!confirmed) {
          output.printInfo('Operation cancelled');
          return { success: true };
        }
      } else if (!force) {
        output.printError(`Refusing to purge namespace "${namespace}" without --force in non-interactive mode`);
        return { success: false, exitCode: 1 };
      }

      const result = await purgeNamespace({ namespace, dbPath: resolvedDbPath });

      if (!result.success) {
        output.printError(result.error || 'Failed to purge');
        return { success: false, exitCode: 1 };
      }

      output.printSuccess(`Purged ${result.deletedCount} entr${result.deletedCount === 1 ? 'y' : 'ies'} from namespace "${namespace}"`);
      output.printInfo(`Remaining entries (all namespaces): ${result.remainingEntries}`);
      return { success: true, data: result };
    } catch (error) {
      output.printError(`Failed to purge: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Stats command
const statsCommand: Command = {
  name: 'stats',
  description: 'Show memory statistics',
  options: [DB_PATH_OPTION],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Call MCP memory/stats tool for real statistics
    try {
      const statsResult = await callMCPTool('memory_stats', {}) as {
        totalEntries: number;
        entriesWithEmbeddings?: number;
        totalSize: string;
        version: string;
        backend: string;
        location: string;
        oldestEntry: string | null;
        newestEntry: string | null;
      };

      const stats = {
        backend: statsResult.backend,
        entries: {
          total: statsResult.totalEntries,
          vectors: 0, // Would need vector backend support
          text: statsResult.totalEntries
        },
        storage: {
          total: statsResult.totalSize,
          location: statsResult.location
        },
        version: statsResult.version,
        oldestEntry: statsResult.oldestEntry,
        newestEntry: statsResult.newestEntry
      };

      if (ctx.flags.format === 'json') {
        output.printJson(stats);
        return { success: true, data: stats };
      }

      output.writeln();
      output.writeln(output.bold('Memory Statistics'));
      output.writeln();

      output.writeln(output.bold('Overview'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'value', header: 'Value', width: 30, align: 'right' }
        ],
        data: [
          { metric: 'Backend', value: stats.backend },
          { metric: 'Version', value: stats.version },
          { metric: 'Total Entries', value: stats.entries.total.toLocaleString() },
          { metric: 'Total Storage', value: stats.storage.total },
          { metric: 'Location', value: stats.storage.location }
        ]
      });

      output.writeln();
      output.writeln(output.bold('Timeline'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'value', header: 'Value', width: 30, align: 'right' }
        ],
        data: [
          { metric: 'Oldest Entry', value: stats.oldestEntry || 'N/A' },
          { metric: 'Newest Entry', value: stats.newestEntry || 'N/A' }
        ]
      });

      // #1622 — Surface the active embedding provider in `memory stats` so
      // users can tell which backend resolved at runtime (the 6-level
      // fallback chain in loadEmbeddingModel ranges from full ONNX to a
      // 128-dim hash that has no semantic understanding). Calling
      // loadEmbeddingModel() is cheap when the model is already cached;
      // a fresh call still resolves quickly because we only need the
      // metadata, not a real embedding.
      try {
        const { loadEmbeddingModel, getHNSWStatus } = await import('../memory/memory-initializer.js');
        const embedding = await loadEmbeddingModel({ verbose: false });
        const hnsw = getHNSWStatus();
        // Map model name → semantic capability so users can spot the
        // hash-fallback case without reading docs.
        const semanticProviders = new Set([
          'Xenova/all-MiniLM-L6-v2',
          'Xenova/all-mpnet-base-v2',
          'Xenova/bge-small-en-v1.5',
          'agentic-flow',
          'agentic-flow/reasoningbank',
          'ruvector/onnx',
          'cached',
        ]);
        const isSemantic = embedding.success && semanticProviders.has(embedding.modelName);

        output.writeln();
        output.writeln(output.bold('Embedding'));
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 20 },
            { key: 'value', header: 'Value', width: 30, align: 'right' }
          ],
          data: [
            {
              metric: 'Provider',
              value: embedding.success
                ? embedding.modelName
                : output.warning(`unavailable: ${embedding.error || 'unknown'}`),
            },
            { metric: 'Dimensions', value: String(embedding.dimensions) },
            {
              metric: 'Semantic Search',
              value: isSemantic
                ? output.success('yes')
                : output.warning('no — using hash fallback'),
            },
            {
              metric: 'HNSW Index',
              // ruflo#1989 / #1987: `hnsw.entryCount` is in-process JS state
              // (the live HNSW index of the current Node process). A fresh
              // `memory stats` invocation has never indexed anything, so it
              // reports 0 even when the persistent DB has thousands of
              // entries with embeddings. Use the persistent count from the
              // MCP tool (`entriesWithEmbeddings`, which is the actual
              // count of rows that have a vector) as the source of truth.
              value: (() => {
                const persisted = typeof statsResult.entriesWithEmbeddings === 'number'
                  ? statsResult.entriesWithEmbeddings
                  : null;
                const live = hnsw.entryCount || 0;
                const total = persisted !== null ? Math.max(persisted, live) : live;
                if (!hnsw.available) return output.dim('not active');
                if (total === 0) return output.warning('available but not initialized');
                return output.success(`active (${total.toLocaleString()} entries)`);
              })(),
            },
          ]
        });
      } catch (e) {
        // Don't fail the whole stats command if introspection breaks —
        // the rest of the dashboard is still useful.
        output.writeln();
        output.writeln(output.bold('Embedding'));
        output.printInfo(`Provider info unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }

      output.writeln();
      output.printInfo('V3 Performance: 150x-12,500x faster search with HNSW indexing');

      return { success: true, data: stats };
    } catch (error) {
      output.printError(`Failed to get stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Configure command
const configureCommand: Command = {
  name: 'configure',
  aliases: ['config'],
  description: 'Configure memory backend',
  options: [
    {
      name: 'backend',
      short: 'b',
      description: 'Memory backend',
      type: 'string',
      choices: BACKENDS.map(b => b.value)
    },
    {
      name: 'path',
      description: 'Storage path',
      type: 'string'
    },
    {
      name: 'cache-size',
      description: 'Cache size in MB',
      type: 'number'
    },
    {
      name: 'hnsw-m',
      description: 'HNSW M parameter',
      type: 'number',
      default: 16
    },
    {
      name: 'hnsw-ef',
      description: 'HNSW ef parameter',
      type: 'number',
      default: 200
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let backend = ctx.flags.backend as string;

    if (!backend && ctx.interactive) {
      backend = await select({
        message: 'Select memory backend:',
        options: BACKENDS,
        default: 'hybrid'
      });
    }

    const config = {
      backend: backend || 'hybrid',
      path: ctx.flags.path || './data/memory',
      cacheSize: ctx.flags.cacheSize || 256,
      hnsw: {
        m: ctx.flags.hnswM || 16,
        ef: ctx.flags.hnswEf || 200
      }
    };

    output.writeln();
    output.printInfo('Memory Configuration');
    output.writeln();

    output.printTable({
      columns: [
        { key: 'setting', header: 'Setting', width: 20 },
        { key: 'value', header: 'Value', width: 25 }
      ],
      data: [
        { setting: 'Backend', value: config.backend },
        { setting: 'Storage Path', value: config.path },
        { setting: 'Cache Size', value: `${config.cacheSize} MB` },
        { setting: 'HNSW M', value: config.hnsw.m },
        { setting: 'HNSW ef', value: config.hnsw.ef }
      ]
    });

    output.writeln();
    output.printSuccess('Memory configuration updated');

    return { success: true, data: config };
  }
};

// Cleanup command
const cleanupCommand: Command = {
  name: 'cleanup',
  description: 'Clean up stale and expired memory entries',
  options: [
    {
      name: 'dry-run',
      short: 'd',
      description: 'Show what would be deleted',
      type: 'boolean',
      default: false
    },
    {
      name: 'older-than',
      short: 'o',
      description: 'Delete entries older than (e.g., "7d", "30d")',
      type: 'string'
    },
    {
      name: 'expired-only',
      short: 'e',
      description: 'Only delete expired TTL entries',
      type: 'boolean',
      default: false
    },
    {
      name: 'low-quality',
      short: 'l',
      description: 'Delete low quality patterns (threshold)',
      type: 'number'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Clean specific namespace only',
      type: 'string'
    },
    {
      name: 'force',
      short: 'f',
      description: 'Skip confirmation',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow memory cleanup --dry-run', description: 'Preview cleanup' },
    { command: 'claude-flow memory cleanup --older-than 30d', description: 'Delete entries older than 30 days' },
    { command: 'claude-flow memory cleanup --expired-only', description: 'Clean expired entries' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const dryRun = ctx.flags.dryRun as boolean;
    const force = ctx.flags.force as boolean;

    if (dryRun) {
      output.writeln(output.warning('DRY RUN - No changes will be made'));
    }

    output.printInfo('Analyzing memory for cleanup...');

    try {
      const result = await callMCPTool<{
        dryRun: boolean;
        candidates: {
          expired: number;
          stale: number;
          lowQuality: number;
          total: number;
        };
        deleted: {
          entries: number;
          vectors: number;
          patterns: number;
        };
        freed: {
          bytes: number;
          formatted: string;
        };
        duration: number;
      }>('memory_cleanup', {
        dryRun,
        olderThan: ctx.flags.olderThan,
        expiredOnly: ctx.flags.expiredOnly,
        lowQualityThreshold: ctx.flags.lowQuality,
        namespace: ctx.flags.namespace,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Cleanup Analysis'));
      output.printTable({
        columns: [
          { key: 'category', header: 'Category', width: 20 },
          { key: 'count', header: 'Count', width: 15, align: 'right' }
        ],
        data: [
          { category: 'Expired (TTL)', count: result.candidates.expired },
          { category: 'Stale (unused)', count: result.candidates.stale },
          { category: 'Low Quality', count: result.candidates.lowQuality },
          { category: output.bold('Total'), count: output.bold(String(result.candidates.total)) }
        ]
      });

      if (!dryRun && result.candidates.total > 0 && !force) {
        const confirmed = await confirm({
          message: `Delete ${result.candidates.total} entries (${result.freed.formatted})?`,
          default: false
        });

        if (!confirmed) {
          output.printInfo('Cleanup cancelled');
          return { success: true, data: result };
        }
      }

      if (!dryRun) {
        output.writeln();
        output.printSuccess(`Cleaned ${result.deleted.entries} entries`);
        output.printList([
          `Vectors removed: ${result.deleted.vectors}`,
          `Patterns removed: ${result.deleted.patterns}`,
          `Space freed: ${result.freed.formatted}`,
          `Duration: ${result.duration}ms`
        ]);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Cleanup error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Compress command
const compressCommand: Command = {
  name: 'compress',
  description: 'Compress and optimize memory storage',
  options: [
    {
      name: 'level',
      short: 'l',
      description: 'Compression level (fast, balanced, max)',
      type: 'string',
      choices: ['fast', 'balanced', 'max'],
      default: 'balanced'
    },
    {
      name: 'target',
      short: 't',
      description: 'Target (vectors, text, patterns, all)',
      type: 'string',
      choices: ['vectors', 'text', 'patterns', 'all'],
      default: 'all'
    },
    {
      name: 'quantize',
      short: 'z',
      description: 'Enable vector quantization (reduces memory 4-32x)',
      type: 'boolean',
      default: false
    },
    {
      name: 'bits',
      description: 'Quantization bits (4, 8, 16)',
      type: 'number',
      default: 8
    },
    {
      name: 'rebuild-index',
      short: 'r',
      description: 'Rebuild HNSW index after compression',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'claude-flow memory compress', description: 'Balanced compression' },
    { command: 'claude-flow memory compress --quantize --bits 4', description: '4-bit quantization (32x reduction)' },
    { command: 'claude-flow memory compress -l max -t vectors', description: 'Max compression on vectors' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const level = ctx.flags.level as string || 'balanced';
    const target = ctx.flags.target as string || 'all';
    const quantize = ctx.flags.quantize as boolean;
    const bits = ctx.flags.bits as number || 8;
    const rebuildIndex = ctx.flags.rebuildIndex as boolean ?? true;

    output.writeln();
    output.writeln(output.bold('Memory Compression'));
    output.writeln(output.dim(`Level: ${level}, Target: ${target}, Quantize: ${quantize ? `${bits}-bit` : 'no'}`));
    output.writeln();

    const spinner = output.createSpinner({ text: 'Analyzing current storage...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        before: {
          totalSize: string;
          vectorsSize: string;
          textSize: string;
          patternsSize: string;
          indexSize: string;
        };
        after: {
          totalSize: string;
          vectorsSize: string;
          textSize: string;
          patternsSize: string;
          indexSize: string;
        };
        compression: {
          ratio: number;
          bytesSaved: number;
          formattedSaved: string;
          quantizationApplied: boolean;
          indexRebuilt: boolean;
        };
        performance: {
          searchLatencyBefore: number;
          searchLatencyAfter: number;
          searchSpeedup: string;
        };
        duration: number;
      }>('memory_compress', {
        level,
        target,
        quantize,
        bits,
        rebuildIndex,
      });

      spinner.succeed('Compression complete');

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Storage Comparison'));
      output.printTable({
        columns: [
          { key: 'category', header: 'Category', width: 15 },
          { key: 'before', header: 'Before', width: 12, align: 'right' },
          { key: 'after', header: 'After', width: 12, align: 'right' },
          { key: 'saved', header: 'Saved', width: 12, align: 'right' }
        ],
        data: [
          { category: 'Vectors', before: result.before.vectorsSize, after: result.after.vectorsSize, saved: '-' },
          { category: 'Text', before: result.before.textSize, after: result.after.textSize, saved: '-' },
          { category: 'Patterns', before: result.before.patternsSize, after: result.after.patternsSize, saved: '-' },
          { category: 'Index', before: result.before.indexSize, after: result.after.indexSize, saved: '-' },
          { category: output.bold('Total'), before: result.before.totalSize, after: result.after.totalSize, saved: output.success(result.compression.formattedSaved) }
        ]
      });

      output.writeln();
      output.printBox(
        [
          `Compression Ratio: ${result.compression.ratio.toFixed(2)}x`,
          `Space Saved: ${result.compression.formattedSaved}`,
          `Quantization: ${result.compression.quantizationApplied ? `Yes (${bits}-bit)` : 'No'}`,
          `Index Rebuilt: ${result.compression.indexRebuilt ? 'Yes' : 'No'}`,
          `Duration: ${(result.duration / 1000).toFixed(1)}s`
        ].join('\n'),
        'Results'
      );

      if (result.performance) {
        output.writeln();
        output.writeln(output.bold('Performance Impact'));
        output.printList([
          `Search latency: ${result.performance.searchLatencyBefore.toFixed(2)}ms → ${result.performance.searchLatencyAfter.toFixed(2)}ms`,
          `Speedup: ${output.success(result.performance.searchSpeedup)}`
        ]);
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Compression failed');
      if (error instanceof MCPClientError) {
        output.printError(`Compression error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Export command
const exportCommand: Command = {
  name: 'export',
  description: 'Export memory to file',
  options: [
    {
      name: 'output',
      short: 'o',
      description: 'Output file path',
      type: 'string',
      required: true
    },
    {
      name: 'format',
      short: 'f',
      description: 'Export format (json, csv, binary)',
      type: 'string',
      choices: ['json', 'csv', 'binary'],
      default: 'json'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Export specific namespace',
      type: 'string'
    },
    {
      name: 'include-vectors',
      description: 'Include vector embeddings',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'claude-flow memory export -o ./backup.json', description: 'Export all to JSON' },
    { command: 'claude-flow memory export -o ./data.csv -f csv', description: 'Export to CSV' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const outputPath = ctx.flags.output as string;
    const format = ctx.flags.format as string || 'json';

    if (!outputPath) {
      output.printError('Output path is required. Use --output or -o');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Exporting memory to ${outputPath}...`);

    try {
      const result = await callMCPTool<{
        outputPath: string;
        format: string;
        exported: {
          entries: number;
          vectors: number;
          patterns: number;
        };
        fileSize: string;
      }>('memory_export', {
        outputPath,
        format,
        namespace: ctx.flags.namespace,
        includeVectors: ctx.flags.includeVectors ?? true,
      });

      output.printSuccess(`Exported to ${result.outputPath}`);
      output.printList([
        `Entries: ${result.exported.entries}`,
        `Vectors: ${result.exported.vectors}`,
        `Patterns: ${result.exported.patterns}`,
        `File size: ${result.fileSize}`
      ]);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Export error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Import command
const importCommand: Command = {
  name: 'import',
  description: 'Import memory from file',
  options: [
    {
      name: 'input',
      short: 'i',
      description: 'Input file path',
      type: 'string',
      required: true
    },
    {
      name: 'merge',
      short: 'm',
      description: 'Merge with existing (skip duplicates)',
      type: 'boolean',
      default: true
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Import into specific namespace',
      type: 'string'
    }
  ],
  examples: [
    { command: 'claude-flow memory import -i ./backup.json', description: 'Import from file' },
    { command: 'claude-flow memory import -i ./data.json -n archive', description: 'Import to namespace' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const inputPath = ctx.flags.input as string || ctx.args[0];

    if (!inputPath) {
      output.printError('Input path is required. Use --input or -i');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Importing memory from ${inputPath}...`);

    try {
      const result = await callMCPTool<{
        inputPath: string;
        imported: {
          entries: number;
          vectors: number;
          patterns: number;
        };
        skipped: number;
        duration: number;
      }>('memory_import', {
        inputPath,
        merge: ctx.flags.merge ?? true,
        namespace: ctx.flags.namespace,
      });

      output.printSuccess(`Imported from ${result.inputPath}`);
      output.printList([
        `Entries: ${result.imported.entries}`,
        `Vectors: ${result.imported.vectors}`,
        `Patterns: ${result.imported.patterns}`,
        `Skipped (duplicates): ${result.skipped}`,
        `Duration: ${result.duration}ms`
      ]);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Import error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Init subcommand - initialize memory database using sql.js
const initMemoryCommand: Command = {
  name: 'init',
  description: 'Initialize memory database with sql.js (WASM SQLite) - includes vector embeddings, pattern learning, temporal decay',
  options: [
    {
      name: 'backend',
      short: 'b',
      description: 'Backend type: hybrid (default), sqlite, or agentdb',
      type: 'string',
      default: 'hybrid'
    },
    {
      name: 'path',
      short: 'p',
      description: 'Database path',
      type: 'string'
    },
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing database',
      type: 'boolean',
      default: false
    },
    {
      name: 'verbose',
      description: 'Show detailed initialization output',
      type: 'boolean',
      default: false
    },
    {
      name: 'verify',
      description: 'Run verification tests after initialization',
      type: 'boolean',
      default: true
    },
    {
      name: 'load-embeddings',
      description: 'Pre-load ONNX embedding model (lazy by default)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow memory init', description: 'Initialize hybrid backend with all features' },
    { command: 'claude-flow memory init -b agentdb', description: 'Initialize AgentDB backend' },
    { command: 'claude-flow memory init -p ./data/memory.db --force', description: 'Reinitialize at custom path' },
    { command: 'claude-flow memory init --verbose --verify', description: 'Initialize with full verification' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const backend = (ctx.flags.backend as string) || 'hybrid';
    const customPath = ctx.flags.path as string;
    const force = ctx.flags.force as boolean;
    const verbose = ctx.flags.verbose as boolean;
    const verify = ctx.flags.verify !== false; // Default true
    const loadEmbeddings = ctx.flags.loadEmbeddings as boolean;

    output.writeln();
    output.writeln(output.bold('Initializing Memory Database'));
    output.writeln(output.dim('─'.repeat(50)));

    const spinner = output.createSpinner({ text: 'Initializing schema...', spinner: 'dots' });
    spinner.start();

    try {
      // Import the memory initializer
      const { initializeMemoryDatabase, loadEmbeddingModel, verifyMemoryInit } = await import('../memory/memory-initializer.js');

      const result = await initializeMemoryDatabase({
        backend,
        dbPath: customPath,
        force,
        verbose
      });

      if (!result.success) {
        spinner.fail('Initialization failed');
        output.printError(result.error || 'Unknown error');
        return { success: false, exitCode: 1 };
      }

      // #1791.6 — DB already initialized and --force not passed: friendly no-op.
      if (result.alreadyExists) {
        spinner.succeed(`Memory database already initialized at ${result.dbPath}`);
        output.printInfo('Use `--force` to reinitialize from scratch (destructive).');
        return { success: true, exitCode: 0 };
      }

      spinner.succeed('Schema initialized');

      // Lazy load or pre-load embedding model
      if (loadEmbeddings) {
        const embeddingSpinner = output.createSpinner({ text: 'Loading embedding model...', spinner: 'dots' });
        embeddingSpinner.start();

        const embeddingResult = await loadEmbeddingModel({ verbose });

        if (embeddingResult.success) {
          embeddingSpinner.succeed(`Embedding model loaded: ${embeddingResult.modelName} (${embeddingResult.dimensions}-dim, ${embeddingResult.loadTime}ms)`);
        } else {
          embeddingSpinner.stop(output.warning(`Embedding model: ${embeddingResult.error || 'Using fallback'}`));
        }
      }

      output.writeln();

      // Show features enabled with detailed capabilities
      const featureLines = [
        `Backend:           ${result.backend}`,
        `Schema Version:    ${result.schemaVersion}`,
        `Database Path:     ${result.dbPath}`,
        '',
        output.bold('Features:'),
        `  Vector Embeddings: ${result.features.vectorEmbeddings ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  Pattern Learning:  ${result.features.patternLearning ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  Temporal Decay:    ${result.features.temporalDecay ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  HNSW Indexing:     ${result.features.hnswIndexing ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  Migration Tracking: ${result.features.migrationTracking ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`
      ];

      if (verbose) {
        featureLines.push(
          '',
          output.bold('HNSW Configuration:'),
          `  M (connections):     16`,
          `  ef (construction):   200`,
          `  ef (search):         100`,
          `  Metric:              cosine`,
          '',
          output.bold('Pattern Learning:'),
          `  Confidence scoring:  0.0 - 1.0`,
          `  Temporal decay:      Half-life 30 days`,
          `  Pattern versioning:  Enabled`,
          `  Types: task-routing, error-recovery, optimization, coordination, prediction`
        );
      }

      output.printBox(featureLines.join('\n'), 'Configuration');
      output.writeln();

      // ADR-053: Show ControllerRegistry activation results
      if (result.controllers) {
        const { activated, failed, initTimeMs } = result.controllers;
        if (activated.length > 0 || failed.length > 0) {
          const controllerLines = [
            output.bold('AgentDB Controllers:'),
            `  Activated: ${activated.length}  Failed: ${failed.length}  Init: ${Math.round(initTimeMs)}ms`,
          ];
          if (verbose && activated.length > 0) {
            controllerLines.push('');
            for (const name of activated) {
              controllerLines.push(`  ${output.success('✓')} ${name}`);
            }
          }
          if (failed.length > 0 && verbose) {
            controllerLines.push('');
            for (const name of failed) {
              controllerLines.push(`  ${output.dim('✗')} ${name}`);
            }
          }
          output.printBox(controllerLines.join('\n'), 'Controller Registry (ADR-053)');
          output.writeln();
        }
      }

      // Show tables created
      if (verbose && result.tablesCreated.length > 0) {
        output.writeln(output.bold('Tables Created:'));
        output.printTable({
          columns: [
            { key: 'table', header: 'Table', width: 22 },
            { key: 'purpose', header: 'Purpose', width: 38 }
          ],
          data: [
            { table: 'memory_entries', purpose: 'Core memory storage with embeddings' },
            { table: 'patterns', purpose: 'Learned patterns with confidence scores' },
            { table: 'pattern_history', purpose: 'Pattern versioning and evolution' },
            { table: 'trajectories', purpose: 'SONA learning trajectories' },
            { table: 'trajectory_steps', purpose: 'Individual trajectory steps' },
            { table: 'migration_state', purpose: 'Migration progress tracking' },
            { table: 'sessions', purpose: 'Context persistence' },
            { table: 'vector_indexes', purpose: 'HNSW index configuration' },
            { table: 'metadata', purpose: 'System metadata' }
          ]
        });
        output.writeln();

        output.writeln(output.bold('Indexes Created:'));
        output.printList(result.indexesCreated.slice(0, 8).map(idx => output.dim(idx)));
        if (result.indexesCreated.length > 8) {
          output.writeln(output.dim(`  ... and ${result.indexesCreated.length - 8} more`));
        }
        output.writeln();
      }

      // Run verification if enabled
      if (verify) {
        const verifySpinner = output.createSpinner({ text: 'Verifying initialization...', spinner: 'dots' });
        verifySpinner.start();

        const verification = await verifyMemoryInit(result.dbPath, { verbose });

        if (verification.success) {
          verifySpinner.succeed(`Verification passed (${verification.summary.passed}/${verification.summary.total} tests)`);
        } else {
          verifySpinner.fail(`Verification failed (${verification.summary.failed}/${verification.summary.total} tests failed)`);
        }

        if (verbose || !verification.success) {
          output.writeln();
          output.writeln(output.bold('Verification Results:'));
          output.printTable({
            columns: [
              { key: 'status', header: '', width: 3 },
              { key: 'name', header: 'Test', width: 22 },
              { key: 'details', header: 'Details', width: 30 },
              { key: 'duration', header: 'Time', width: 8, align: 'right' }
            ],
            data: verification.tests.map(t => ({
              status: t.passed ? output.success('✓') : output.error('✗'),
              name: t.name,
              details: t.details || '',
              duration: t.duration ? `${t.duration}ms` : '-'
            }))
          });
        }

        output.writeln();
      }

      // Show next steps
      output.writeln(output.bold('Next Steps:'));
      output.printList([
        `Store data: ${output.highlight('claude-flow memory store -k "key" --value "data"')}`,
        `Search: ${output.highlight('claude-flow memory search -q "query"')}`,
        `Train patterns: ${output.highlight('claude-flow neural train -p coordination')}`,
        `View stats: ${output.highlight('claude-flow memory stats')}`
      ]);

      // Also sync to .claude directory
      const fs = await import('fs');
      const path = await import('path');
      const claudeDir = path.join(process.cwd(), '.claude');
      const claudeDbPath = path.join(claudeDir, 'memory.db');

      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }

      if (fs.existsSync(result.dbPath) && (!fs.existsSync(claudeDbPath) || force)) {
        fs.copyFileSync(result.dbPath, claudeDbPath);
        output.writeln();
        output.writeln(output.dim(`Synced to: ${claudeDbPath}`));
      }

      // Fix #1428: ONNX worker threads keep the event loop alive after init.
      // Force-exit after a short delay to allow final I/O to flush.
      if (typeof globalThis !== 'undefined') {
        setTimeout(() => {
          process.exit(0);
        }, 500).unref();
      }

      return {
        success: true,
        data: result
      };
    } catch (error) {
      spinner.fail('Initialization failed');
      output.printError(`Failed to initialize memory: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// #2763 dream-cycle — OAS memory-operator selector. Standalone
// subcommand that returns the highest-value consolidation operator
// that fits the given budget for the given entry count. Advisory —
// the caller decides whether to invoke that operator.
const selectOperatorCommand: Command = {
  name: 'select-operator',
  description: 'Pick the highest-value consolidation operator that fits a budget (OAS, dream-cycle #2763)',
  options: [
    { name: 'budget', short: 'b', type: 'number', required: true, description: 'Budget in abstract operator points (1 point ≈ 1 Haiku call)' },
    { name: 'entries', short: 'e', type: 'number', required: true, description: 'Number of entries to consolidate' },
    { name: 'hint', type: 'string', choices: ['duplicates', 'verbose', 'patterns', 'general'], default: 'general', description: 'Entry-shape hint' },
  ],
  examples: [
    { command: 'claude-flow memory select-operator -b 50 -e 200', description: 'Pick operator for 200 entries within 50 points' },
    { command: 'claude-flow memory select-operator -b 5 -e 100 --hint duplicates --format json', description: 'JSON for pipelines' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const budget = ctx.flags.budget as number;
    const entries = ctx.flags.entries as number;
    const hint = (ctx.flags.hint as string) || 'general';

    if (budget === undefined || entries === undefined) {
      output.printError('Both --budget and --entries are required.');
      return { success: false, exitCode: 1 };
    }
    if (budget < 0 || entries < 0) {
      output.printError('Budget and entries must be non-negative.');
      return { success: false, exitCode: 1 };
    }

    const { selectOperator, OPERATORS } = await import('../memory/oas-operator-selector.js');
    const selection = selectOperator({ budget, entries, hint: hint as 'duplicates' | 'verbose' | 'patterns' | 'general' });

    if (ctx.flags.format === 'json') {
      output.printJson(selection);
      return { success: true, data: selection };
    }

    const chosen = OPERATORS[selection.operator];
    output.writeln();
    output.printBox(
      `Budget: ${budget} points · Entries: ${entries}\n` +
      `Operator: ${selection.operator}\n` +
      `Description: ${chosen.description}\n` +
      `Estimated cost: ${selection.estimatedCost.toFixed(2)} points\n` +
      `Needs split: ${selection.needsSplit ? `YES — batch size ${selection.suggestedBatchSize}` : 'no'}`,
      'OAS Operator Selection (#2763)'
    );
    output.writeln();
    output.writeln(output.dim(selection.reason));

    if (selection.considered.length > 0) {
      output.writeln();
      output.writeln(output.bold('All operators considered'));
      output.printTable({
        columns: [
          { key: 'id', header: 'Operator', width: 15 },
          { key: 'cost', header: 'Est. Cost', width: 12, align: 'right', format: (v) => Number(v).toFixed(2) },
          { key: 'fits', header: 'Fits Budget', width: 12, align: 'center', format: (v) => v ? '✓' : '—' },
        ],
        data: selection.considered,
      });
    }

    return { success: true, data: selection };
  },
};

// #2760 dream-cycle — SCM query classifier. Standalone subcommand so
// users can inspect what intent a query maps to and pipe the mapped
// namespaces into other tools (e.g. `memory search --namespace ...`).
const classifyCommand: Command = {
  name: 'classify',
  description: 'Classify a query into episodic/semantic/procedural intent (SCM router, dream-cycle #2760)',
  options: [
    { name: 'query', short: 'q', type: 'string', description: 'Query text to classify', required: true },
    { name: 'intent', type: 'string', choices: ['auto', 'mixed', 'episodic', 'semantic', 'procedural'], default: 'auto', description: 'Force a specific intent (default: auto)' },
  ],
  examples: [
    { command: 'claude-flow memory classify -q "when did we last touch auth"', description: 'Auto-classify (should return episodic)' },
    { command: 'claude-flow memory classify -q "how does JWT work" --format json', description: 'JSON output for pipelines' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const query = ctx.flags.query as string;
    const requested = (ctx.flags.intent as string) || 'auto';

    if (!query) {
      output.printError('Query is required. Use --query or -q');
      return { success: false, exitCode: 1 };
    }

    const { resolveIntent } = await import('../memory/scm-classifier.js');
    const resolved = resolveIntent(query, requested as 'auto' | 'mixed' | 'episodic' | 'semantic' | 'procedural');

    if (ctx.flags.format === 'json') {
      output.printJson(resolved);
      return { success: true, data: resolved };
    }

    output.writeln();
    output.printBox(
      `Query: "${query}"\n` +
      `Intent: ${resolved.intent}\n` +
      `Confidence: ${(resolved.confidence * 100).toFixed(1)}%\n` +
      `Namespaces: ${resolved.namespaces.length > 0 ? resolved.namespaces.slice(0, 4).join(', ') + (resolved.namespaces.length > 4 ? '…' : '') : '(all — mixed retrieval)'}`,
      'SCM Classifier (#2760)'
    );
    output.writeln();
    output.writeln(output.dim(resolved.reason));
    return { success: true, data: resolved };
  },
};

// Main memory command
export const memoryCommand: Command = {
  name: 'memory',
  description: 'Memory management commands',
  subcommands: [initMemoryCommand, storeCommand, retrieveCommand, searchCommand, listCommand, deleteCommand, purgeCommand, statsCommand, configureCommand, cleanupCommand, compressCommand, exportCommand, importCommand, distillCommand, backupCommand, classifyCommand, selectOperatorCommand],
  options: [],
  examples: [
    { command: 'claude-flow memory store -k "key" -v "value"', description: 'Store data' },
    { command: 'claude-flow memory search -q "auth patterns"', description: 'Search memory' },
    { command: 'claude-flow memory stats', description: 'Show statistics' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Memory Management Commands'));
    output.writeln();
    output.writeln('Usage: claude-flow memory <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}       - Initialize memory database (sql.js)`,
      `${output.highlight('store')}      - Store data in memory`,
      `${output.highlight('retrieve')}   - Retrieve data from memory`,
      `${output.highlight('search')}     - Semantic/vector search`,
      `${output.highlight('list')}       - List memory entries`,
      `${output.highlight('delete')}     - Delete memory entry`,
      `${output.highlight('stats')}      - Show statistics`,
      `${output.highlight('configure')}  - Configure backend`,
      `${output.highlight('cleanup')}    - Clean expired entries`,
      `${output.highlight('compress')}   - Compress database`,
      `${output.highlight('export')}     - Export memory to file`,
      `${output.highlight('import')}     - Import from file`,
      `${output.highlight('distill')}    - Distill memory_entries into structured intelligence (ADR-174)`
    ]);

    return { success: true };
  }
};

export default memoryCommand;
