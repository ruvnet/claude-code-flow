/** Unexposed read primitive. A snapshot observes records; it grants no authority.
 * Uses only the registry's already-open native handle. No schema/init/cache work.
 */
import { createHash } from 'node:crypto';

export const SNAPSHOT_MAX_RECORDS = 12;
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_MS = 1000;
type ObjectValue = Record<string, unknown>;
type Tuple = { table: 'tiered_memory' | 'memory_entries'; namespace: string; key: string; optional: boolean; mirror?: string };
type SnapshotRecord = Tuple & { value: string | null; metadata: ObjectValue | null };
export type SnapshotError = 'invalid_request' | 'native_unavailable' | 'transaction_active' | 'durability_required'
  | 'missing_record' | 'ambiguous_record' | 'malformed_record' | 'expired_record' | 'mirror_conflict'
  | 'byte_limit' | 'deadline' | 'clock_unavailable' | 'storage_error';
export type SnapshotResult = {
  success: true; schema: 'cognitum.authority-snapshot.v1'; companyId: string; observedAt: number;
  digest: string; records: SnapshotRecord[];
  counts: { selectors: number; logicalRecords: number; rowsObserved: number; recordRowsRead: number; recordStatements: number; totalStatements: number; bytes: number };
  durable: true; cache: false; transaction: 'native-read';
} | { success: false; error: SnapshotError };

function fail(code: SnapshotError): never { throw new Error(code); }
function object(v: unknown): v is ObjectValue { return !!v && typeof v === 'object' && !Array.isArray(v); }
function fields(v: ObjectValue, names: string[]): boolean {
  return Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
}
function id(v: unknown): v is string { return typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v); }
function group(v: unknown): v is string { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(v); }
const digest = (v: string): string => createHash('sha256').update(v).digest('hex');

function plan(input: unknown): { companyId: string; count: number; tuples: Tuple[] } {
  if (!object(input) || !fields(input, ['companyId', 'selectors']) || !id(input.companyId)
    || !Array.isArray(input.selectors) || !input.selectors.length || input.selectors.length > SNAPSHOT_MAX_RECORDS) fail('invalid_request');
  const companyId = input.companyId;
  const tuples: Tuple[] = [];
  const add = (table: Tuple['table'], namespace: string, key: string, optional = false, mirror?: string) => {
    if (tuples.some(t => t.table === table && t.namespace === namespace && t.key === key)) fail('invalid_request');
    tuples.push({ table, namespace, key, optional, ...(mirror ? { mirror } : {}) });
  };
  for (const s of input.selectors) {
    if (!object(s)) fail('invalid_request');
    if (s.kind === 'company' && fields(s, ['kind'])) {
      add('tiered_memory', 'semantic', `ruclip:company:${companyId}`);
    } else if (['member', 'executive', 'settings'].includes(String(s.kind)) && fields(s, ['kind', 'memberId']) && id(s.memberId)) {
      if (s.kind === 'member') add('tiered_memory', 'semantic', `ruclip:company:${companyId}:org-member:${s.memberId}`);
      else if (s.kind === 'executive') add('memory_entries', 'ruclip-api-authority', `ruclip:executive:${companyId}:${s.memberId}`);
      else add('memory_entries', 'ruclip-api-agent-settings', `ruclip:agent-settings:${companyId}:${s.memberId}`);
    } else if (['assignment', 'spend'].includes(String(s.kind)) && fields(s, ['kind', 'groupId']) && group(s.groupId)) {
      const family = s.kind === 'assignment' ? 'assignment' : 'spend';
      add('memory_entries', `ruclip-api-whatsapp-group-${family === 'assignment' ? 'assignments' : 'spend'}`,
        `ruclip:whatsapp-group-${family}:${encodeURIComponent(companyId)}:${encodeURIComponent(s.groupId)}`);
    } else if (['request', 'approval'].includes(String(s.kind))
      && fields(s, s.kind === 'approval' ? ['kind', 'groupId', 'reservationId', 'allowAbsent'] : ['kind', 'groupId', 'reservationId'])
      && group(s.groupId) && group(s.reservationId) && (s.kind !== 'approval' || typeof s.allowAbsent === 'boolean')) {
      const family = s.kind === 'request' ? 'approval-request' : 'approval';
      add('memory_entries', `ruclip-api-whatsapp-group-send-${family}s`,
        `ruclip:whatsapp-group-send-${family}:${encodeURIComponent(companyId)}:${encodeURIComponent(s.groupId)}:${encodeURIComponent(s.reservationId)}`, s.allowAbsent === true);
    } else if (s.kind === 'jti' && fields(s, ['kind', 'jti', 'allowAbsent']) && id(s.jti) && typeof s.allowAbsent === 'boolean') {
      add('memory_entries', 'ruclip-api-whatsapp-human-approval-jti', `ruclip:whatsapp-human-approval:${encodeURIComponent(s.jti)}`, s.allowAbsent);
    } else if (s.kind === 'identity-locator' && fields(s, ['kind', 'identityRef'])
      && typeof s.identityRef === 'string' && /^slack:[A-Za-z0-9]{1,128}$/.test(s.identityRef)) {
      const h = digest(JSON.stringify([companyId, s.identityRef]));
      add('memory_entries', 'ruclip-identity-v1', `identity-${h}`, false, h);
      add('tiered_memory', 'semantic', `ruclip:company:${companyId}:identity-legacy:${h}`, false, h);
    } else fail('invalid_request');
  }
  if (tuples.length > SNAPSHOT_MAX_RECORDS) fail('invalid_request');
  return { companyId, count: input.selectors.length, tuples };
}

// These properties distinguish the already-open native file handle from sql.js
// and in-memory substitutes. Callers are internal; this is not a remote adapter API.
export function assertAuthorityNativeReady(db: any): void {
  if (!db || db.open !== true || db.memory !== false || db.readonly !== false
    || typeof db.inTransaction !== 'boolean' || typeof db.pragma !== 'function'
    || typeof db.prepare !== 'function' || typeof db.exec !== 'function') fail('native_unavailable');
  if (db.pragma('journal_mode', { simple: true }) !== 'wal' || db.pragma('synchronous', { simple: true }) !== 2
    || db.prepare('PRAGMA synchronous').get()?.synchronous !== 2) fail('durability_required');
  const version = db.prepare('SELECT sqlite_version() AS version').get()?.version;
  // Match the reviewed WAL-reset fixes, including later SQLite3 releases.
  const v = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
  if (!v || Number(v[1]) !== 3 || !((Number(v[2]) === 51 && Number(v[3]) >= 3)
    || (Number(v[2]) === 50 && Number(v[3]) >= 7) || (Number(v[2]) === 44 && Number(v[3]) >= 6)
    || Number(v[2]) > 51)) fail('durability_required');
}

export function authorityTimestamp(v: unknown): number {
  const parts = typeof v === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(v) : null;
  if (!parts) fail('malformed_record');
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59
    || Number(parts[7] ?? 0) > 23 || Number(parts[8] ?? 0) > 59 || !Number.isFinite(Date.parse(v as string))) fail('malformed_record');
  return Date.parse(v as string);
}
function value(row: ObjectValue, tuple: Tuple, observedAt: number): string {
  if (row.key !== tuple.key || (tuple.table === 'tiered_memory' ? row.tier : row.namespace) !== tuple.namespace
    || typeof row.id !== 'string' || !row.id) fail('malformed_record');
  if (tuple.table === 'tiered_memory') {
    if (row.archived !== 0 || row.superseded_by !== null) fail('expired_record');
    if (row.valid_from !== null && authorityTimestamp(row.valid_from) > observedAt) fail('expired_record');
    if (row.valid_until !== null && authorityTimestamp(row.valid_until) <= observedAt) fail('expired_record');
  } else {
    if (row.status !== null && row.status !== 'active') fail('expired_record');
    if (row.expires_at !== null && (!Number.isSafeInteger(row.expires_at) || Number(row.expires_at) <= 0)) fail('malformed_record');
    if (row.expires_at !== null && Number(row.expires_at) <= observedAt) fail('expired_record');
  }
  const text = tuple.table === 'tiered_memory' ? row.value : row.content;
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > MAX_VALUE_BYTES) fail('byte_limit');
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { fail('malformed_record'); }
  // Existing writers use compact JSON.stringify. Require an exact round trip
  // to reject duplicate fields and alternate numeric/string representations.
  // Historical noncompact data must be reconciled, never silently normalized.
  if (!object(decoded) || JSON.stringify(decoded) !== text) fail('malformed_record');
  return text;
}

/** @internal Read-only core for fixed native transactions. Caller owns transaction. */
export function readAuthorityRows(db: any, input: unknown, observedAt: number, checkTime: () => void) {
  if (db.inTransaction !== true) fail('transaction_active');
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) fail('clock_unavailable');
  const p = plan(input);
    const records: SnapshotRecord[] = [];
    let rowsObserved = 0; let bytes = 0;
    for (const tuple of p.tuples) {
      checkTime();
      // Preflight byte length in SQLite before transferring content into JS.
      // Same transaction: the subsequent exact row cannot grow/change underneath.
      const lengthColumn = tuple.table === 'tiered_memory' ? 'value' : 'content';
      const namespaceColumn = tuple.table === 'tiered_memory' ? 'tier' : 'namespace';
      const where = `key=? AND ${namespaceColumn}=?`;
      const extra = tuple.table === 'tiered_memory'
        ? "coalesce(length(CAST(superseded_by AS BLOB)),0)+coalesce(length(CAST(valid_from AS BLOB)),0)+coalesce(length(CAST(valid_until AS BLOB)),0)"
        : "coalesce(length(CAST(status AS BLOB)),0)+coalesce(length(CAST(expires_at AS BLOB)),0)";
      const sizes = db.prepare(`SELECT length(CAST(${lengthColumn} AS BLOB)) AS bytes, length(CAST(id AS BLOB)) AS idBytes, ${extra} AS metadataBytes FROM ${tuple.table} WHERE ${where} LIMIT 2`).all(tuple.key, tuple.namespace);
      rowsObserved += sizes.length;
      if (sizes.length > 1) fail('ambiguous_record');
      if (!sizes.length) {
        if (!tuple.optional) fail('missing_record');
        records.push({ ...tuple, value: null, metadata: null }); continue;
      }
      if (!Number.isSafeInteger(sizes[0].bytes) || sizes[0].bytes > MAX_VALUE_BYTES
        || !Number.isSafeInteger(sizes[0].idBytes) || sizes[0].idBytes > 256
        || !Number.isSafeInteger(sizes[0].metadataBytes) || sizes[0].metadataBytes > 512) fail('byte_limit');
      bytes += sizes[0].bytes;
      if (bytes > SNAPSHOT_MAX_BYTES) fail('byte_limit');
      const columns = tuple.table === 'tiered_memory'
        ? 'id,key,tier,value,archived,superseded_by,valid_from,valid_until'
        : 'id,key,namespace,content,status,expires_at';
      const rows = db.prepare(`SELECT ${columns} FROM ${tuple.table} WHERE ${where} LIMIT 2`).all(tuple.key, tuple.namespace);
      if (rows.length !== 1) fail('ambiguous_record');
      const row = rows[0];
      const content = value(row, tuple, observedAt);
      const metadata = tuple.table === 'tiered_memory'
        ? { id: row.id, archived: row.archived, supersededBy: row.superseded_by, validFrom: row.valid_from, validUntil: row.valid_until }
        : { id: row.id, status: row.status, expiresAt: row.expires_at };
      records.push({ ...tuple, value: content, metadata });
    }
    for (const r of records.filter(r => r.mirror)) {
      const mirrors = records.filter(x => x.mirror === r.mirror);
      if (mirrors.length !== 2 || mirrors[0].value !== mirrors[1].value) fail('mirror_conflict');
    }
  return { records, rowsObserved, tuples: p.tuples.length, bytes };
}

/** Does not initialize a registry, open a database, mutate schema or register a tool. */
export function readAuthoritySnapshot(registry: any, input: unknown): SnapshotResult {
  let db: any; let began = false;
  const started = performance.now();
  const checkTime = () => { if (performance.now() - started > MAX_MS) fail('deadline'); };
  try {
    const p = plan(input);
    db = registry?.getAgentDB?.()?.database;
    assertAuthorityNativeReady(db);
    if (db.inTransaction) fail('transaction_active');
    db.exec('BEGIN'); began = true;
    assertAuthorityNativeReady(db);
    const observedAt = Date.now();
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0) fail('clock_unavailable');
    const { records, rowsObserved } = readAuthorityRows(db, input, observedAt, checkTime);
    assertAuthorityNativeReady(db); checkTime();
    const encoded = JSON.stringify({ companyId: p.companyId, records });
    const recordStatements = p.tuples.length + rowsObserved;
    const counts = { selectors: p.count, logicalRecords: p.tuples.length, rowsObserved,
      recordRowsRead: rowsObserved * 2, recordStatements,
      totalStatements: recordStatements + 12 + 2, bytes: Buffer.byteLength(encoded) };
    const result = { success: true as const, schema: 'cognitum.authority-snapshot.v1' as const,
      companyId: p.companyId, observedAt, digest: digest(encoded), records, counts,
      durable: true as const, cache: false as const, transaction: 'native-read' as const };
    if (Buffer.byteLength(JSON.stringify(result)) > SNAPSHOT_MAX_BYTES) fail('byte_limit');
    db.exec('COMMIT'); began = false; checkTime();
    return result;
  } catch (error) {
    if (began) { try { db.exec('ROLLBACK'); } catch { return { success: false, error: 'storage_error' }; } }
    const code = error instanceof Error ? error.message : '';
    const errors: SnapshotError[] = ['invalid_request', 'native_unavailable', 'transaction_active', 'durability_required',
      'missing_record', 'ambiguous_record', 'malformed_record', 'expired_record', 'mirror_conflict', 'byte_limit', 'deadline', 'clock_unavailable'];
    return { success: false, error: errors.includes(code as SnapshotError) ? code as SnapshotError : 'storage_error' };
  }
}
