/** Internal fixed-approval proof contract. Reviewed host config is not HTTP input. */
import { createHash, createPublicKey, verify } from 'node:crypto';
export type Obj = Record<string, any>;
export const ACTION = 'whatsapp.send.approve';
export const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export function requireThat(v: unknown, error = 'authority_denied'): asserts v { if (!v) throw Error(error); }
export const exact = (v: unknown, keys: string[]): v is Obj => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export const groupId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(v);
export const safe = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/.test(v);
export const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function clock(): number { const n = Date.now(); requireThat(integer(n) && n > 0, 'clock_unavailable'); return n; }
export function strict(text: string): Obj {
  requireThat(typeof text === 'string' && Buffer.byteLength(text) <= 256 * 1024, 'invalid_request');
  const v = JSON.parse(text); requireThat(object(v) && JSON.stringify(v) === text, 'invalid_request'); return v;
}
function b64(v: unknown, n: number): Buffer {
  requireThat(typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v), 'invalid_signature');
  const b = Buffer.from(v, 'base64url'); requireThat(b.length === n && b.toString('base64url') === v, 'invalid_signature'); return b;
}
const PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function publicKey(raw: unknown) { return createPublicKey({ key: Buffer.concat([PREFIX, b64(raw, 32)]), format: 'der', type: 'spki' }); }
export function canonicalHuman(a: Obj): Buffer {
  return Buffer.from(JSON.stringify(['cognitum.whatsapp.human-approval.v1', a.version, a.action, a.companyId, a.groupId,
    a.intentId, a.reservationId, a.agentMemberId, a.agentBbsEnvelopeId, a.payloadSha256,
    a.humanSubject.provider, a.humanSubject.userId, a.humanSubject.email, a.issuedAt, a.expiresAt, a.jti, a.keyId]));
}
export function assertion(a: unknown): asserts a is Obj {
  requireThat(exact(a, ['version','action','companyId','groupId','intentId','reservationId','agentMemberId','agentBbsEnvelopeId','payloadSha256','humanSubject','issuedAt','expiresAt','jti','keyId','signature']), 'invalid_assertion');
  requireThat(a.version === 1 && a.action === ACTION && identifier(a.companyId) && groupId(a.groupId)
    && groupId(a.intentId) && groupId(a.reservationId) && identifier(a.agentMemberId) && safe(a.agentBbsEnvelopeId)
    && hash(a.payloadSha256) && identifier(a.jti) && safe(a.keyId,128) && integer(a.issuedAt) && integer(a.expiresAt), 'invalid_assertion');
  requireThat(exact(a.humanSubject, ['provider','userId','email']) && a.humanSubject.provider === 'slack'
    && safe(a.humanSubject.userId,64) && typeof a.humanSubject.email === 'string' && a.humanSubject.email.length <= 254
    && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@cognitum\.one$/.test(a.humanSubject.email), 'invalid_assertion');
  b64(a.signature,64);
}
export type ReviewedConfig = Readonly<{ subject: string; epoch: string; revision: string; expiresAt: number;
  attesterPublicKey: string; humanPublicKeys: Readonly<Record<string,string>> }>;
/** Host supplies an independently owned loader, never request-selected configuration.
 * Snapshot is copied/frozen; every admission/finalization reloads and compares exact config.
 * This authenticates configured service seals, NOT transport/OIDC identity or operation nonce.
 */
export function reviewedConfig(raw: unknown): ReviewedConfig {
  requireThat(exact(raw,['subject','epoch','revision','expiresAt','attesterPublicKey','humanPublicKeys']), 'configuration_unavailable');
  requireThat(safe(raw.subject) && identifier(raw.epoch) && identifier(raw.revision) && integer(raw.expiresAt) && raw.expiresAt > clock()
    && object(raw.humanPublicKeys) && Object.keys(raw.humanPublicKeys).length >= 1 && Object.keys(raw.humanPublicKeys).length <= 16, 'configuration_unavailable');
  publicKey(raw.attesterPublicKey);
  const keys: Record<string,string> = Object.create(null);
  for (const [id,key] of Object.entries(raw.humanPublicKeys)) { requireThat(safe(id,128), 'configuration_unavailable'); publicKey(key); keys[id] = key as string; }
  return Object.freeze({ subject: raw.subject, epoch: raw.epoch, revision: raw.revision, expiresAt: raw.expiresAt,
    attesterPublicKey: raw.attesterPublicKey, humanPublicKeys: Object.freeze(keys) });
}
export function verifyHuman(a: Obj, c: ReviewedConfig, now: number): string {
  assertion(a);
  requireThat(a.expiresAt > a.issuedAt && a.expiresAt - a.issuedAt <= 300000 && a.issuedAt <= now + 30000 && a.expiresAt > now, 'assertion_expired');
  const key = c.humanPublicKeys[a.keyId]; requireThat(key, 'invalid_signature');
  const bytes = canonicalHuman(a); requireThat(verify(null, bytes, publicKey(key), b64(a.signature,64)), 'invalid_signature');
  // Match existing API: original signature-inclusive digest, not just payload bytes.
  return sha(Buffer.concat([bytes, Buffer.from([0]), b64(a.signature,64)]));
}
export const target = (d: Obj) => `ruclip:whatsapp-group-send-approval:${encodeURIComponent(d.companyId)}:${encodeURIComponent(d.groupId)}:${encodeURIComponent(d.assertion.reservationId)}`;
export function request(raw: string, prepare: boolean): Obj {
  const d = strict(raw);
  requireThat(exact(d,['version','kind','companyId','groupId','approvedByMemberId','assertion','expectedSnapshotDigest'])
    && d.version === 1 && d.kind === 'cognitum.whatsapp.approve.v1' && identifier(d.companyId) && groupId(d.groupId)
    && identifier(d.approvedByMemberId) && (prepare ? d.expectedSnapshotDigest === null : hash(d.expectedSnapshotDigest)), 'invalid_request');
  assertion(d.assertion); requireThat(d.assertion.companyId === d.companyId && d.assertion.groupId === d.groupId, 'invalid_request'); return d;
}
function service(raw: string, seal: string, d: Obj, c: ReviewedConfig, now: number, action: string, expectedTarget: string): void {
  requireThat(typeof seal === 'string' && seal.length <= 16384 && /^[a-f0-9]+\.[a-f0-9]{128}$/.test(seal), 'service_denied');
  const [hex,sig] = seal.split('.'); requireThat(hex.length % 2 === 0, 'service_denied');
  const bytes = Buffer.from(hex,'hex'); const op = strict(bytes.toString('utf8'));
  requireThat(verify(null, bytes, publicKey(c.attesterPublicKey), Buffer.from(sig,'hex')), 'service_denied');
  requireThat(exact(op,['version','domain','epoch','subject','action','companyId','target','bodySha256','nonce','issuedAt','expiresAt'])
    && op.version === 1 && op.domain === 'cognitum.protected-service-operation.v1' && op.epoch === c.epoch && op.subject === c.subject
    && op.action === action && op.companyId === d.companyId && op.target === expectedTarget && op.bodySha256 === sha(raw)
    && identifier(op.nonce) && integer(op.issuedAt) && integer(op.expiresAt) && op.issuedAt <= now && op.expiresAt > now
    && op.expiresAt > op.issuedAt && op.expiresAt - op.issuedAt <= 10000, 'service_denied');
}

/** Fixed verification entry points; action/target never come from caller authority. */
export function verifyService(raw: string, seal: string, d: Obj, c: ReviewedConfig, now: number): void {
  service(raw,seal,d,c,now,ACTION,target(d));
}
export function verifyConsumeService(raw: string, seal: string, d: Obj, c: ReviewedConfig, now: number): void {
  const key=`ruclip:whatsapp-group-send-approval:${encodeURIComponent(d.companyId)}:${encodeURIComponent(d.groupId)}:${encodeURIComponent(d.intent.reservationId)}`;
  service(raw,seal,d,c,now,'whatsapp.send.consume',key);
}
