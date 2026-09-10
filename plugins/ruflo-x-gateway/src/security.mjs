import { timingSafeEqual } from 'node:crypto';
export const MAX_BODY = 256 * 1024;
const buckets = new Map(); // ip -> {tokens, ts}
export function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'; }
// Token bucket: `rate` req/min per IP.
export function rateLimited(req, rate = 60) {
  const ip = clientIp(req), now = Date.now(); const b = buckets.get(ip) || { tokens: rate, ts: now };
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
