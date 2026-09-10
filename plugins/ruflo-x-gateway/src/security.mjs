import { timingSafeEqual } from 'node:crypto';
export const MAX_BODY = 256 * 1024;
const buckets = new Map(); // ip -> {tokens, ts}
const MAX_BUCKETS = 10_000, IDLE_MS = 10 * 60_000;
// Evict idle buckets so IP churn cannot grow the map without bound (DoS/memory).
function pruneBuckets(now) {
  if (buckets.size < MAX_BUCKETS) { if (buckets.size % 500 !== 0) return; }
  for (const [ip, b] of buckets) if (now - b.ts > IDLE_MS) buckets.delete(ip);
  if (buckets.size >= MAX_BUCKETS) { const drop = buckets.size - MAX_BUCKETS + 100; let i = 0; for (const ip of buckets.keys()) { if (i++ >= drop) break; buckets.delete(ip); } }
}
export function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'; }
// Token bucket: `rate` req/min per IP.
export function rateLimited(req, rate = 60) {
  const ip = clientIp(req), now = Date.now(); pruneBuckets(now); const b = buckets.get(ip) || { tokens: rate, ts: now };
  b.tokens = Math.min(rate, b.tokens + ((now - b.ts) / 60000) * rate); b.ts = now;
  if (b.tokens < 1) { buckets.set(ip, b); return true; }
  b.tokens -= 1; buckets.set(ip, b); return false;
}
export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}
// Read body with a hard cap; rejects oversize before buffering it all.
export function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length'] || 0); if (cl > max) return reject(new Error('payload too large'));
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); return reject(new Error('payload too large')); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
}
// Constant-time admin token check. Returns false when no token is configured (fail closed).
export function checkAdmin(token, expected = process.env.RUFLO_ADMIN_TOKEN) {
  if (!expected || typeof token !== 'string') return false;
  const a = Buffer.from(token), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const _bucketsForTest = buckets;

/**
 * Spend guard for the one advisory tool that costs money.
 *
 * Seraphina reads and advises; it writes nothing and holds no authority. It was
 * admin-gated anyway, which put a bearer secret in front of a read — and a
 * browser cannot hold a bearer secret, so any published UI was locked out or,
 * worse, tempted to ship the admin token that also mints invites.
 *
 * The real exposure is model spend, and spend is bounded with a budget, not a
 * password. Anonymous callers get a small per-IP rate and share a daily ceiling;
 * an admin token lifts both. Counters are per-instance and reset daily — good
 * enough to stop a runaway, not a billing system.
 */
const seraphinaDay = { day: '', calls: 0 };
const seraphinaIp = new Map();
export const SERAPHINA_DAILY_CAP = Number(process.env.RUFLO_SERAPHINA_DAILY_CAP || 200);
export const SERAPHINA_IP_HOURLY_CAP = Number(process.env.RUFLO_SERAPHINA_IP_HOURLY_CAP || 10);

export function seraphinaAllowance(req, isAdmin, now = Date.now()) {
  if (isAdmin) return { allowed: true, admin: true };
  const day = new Date(now).toISOString().slice(0, 10);
  if (seraphinaDay.day !== day) { seraphinaDay.day = day; seraphinaDay.calls = 0; seraphinaIp.clear(); }
  if (seraphinaDay.calls >= SERAPHINA_DAILY_CAP) {
    return { allowed: false, reason: `Seraphina's shared daily budget (${SERAPHINA_DAILY_CAP} calls) is spent. It resets at 00:00 UTC. An admin token lifts the cap.` };
  }
  const ip = clientIp(req);
  const rec = seraphinaIp.get(ip) || { hour: -1, n: 0 };
  const hour = Math.floor(now / 3600000);
  if (rec.hour !== hour) { rec.hour = hour; rec.n = 0; }
  if (rec.n >= SERAPHINA_IP_HOURLY_CAP) {
    seraphinaIp.set(ip, rec);
    return { allowed: false, reason: `This client has used its ${SERAPHINA_IP_HOURLY_CAP} Seraphina calls for the hour. Try again next hour, or use an admin token.` };
  }
  rec.n += 1; seraphinaIp.set(ip, rec); seraphinaDay.calls += 1;
  return { allowed: true, admin: false, remainingToday: SERAPHINA_DAILY_CAP - seraphinaDay.calls };
}

/** Anonymous callers may not select the most expensive tiers. */
export const ANON_TIERS = ['cognitum-auto', 'cognitum-low', 'cognitum-mid'];

export function _resetSeraphinaBudgetForTest() { seraphinaDay.day = ''; seraphinaDay.calls = 0; seraphinaIp.clear(); }
