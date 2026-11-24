// Per-caller rate-limit HOOK (platform base #6). STUB: the real limiter (Cloudflare Rate Limiting binding or whatever
// Web Boss's base picks) plugs in here. The scanner calls it on every naming request, keyed by caller (user + key id).
// The scanner's own exact caps (src/scanner/limits.ts: per minute and per hour, per person, counted in D1) run in addition to this hook.
export interface RateLimitHook { check(caller: string, bucket: string): Promise<{ ok: true } | { ok: false; retry_after_s: number }> }
export const allowAll: RateLimitHook = { async check() { return { ok: true }; } };
