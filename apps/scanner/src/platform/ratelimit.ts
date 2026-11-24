// Per-caller rate-limit HOOK (platform base #6). Placeholder (allows all): the real limiter (Cloudflare Rate Limiting binding or whatever
// Web Boss's base picks) plugs in here. The scanner calls it on every naming request, keyed by caller (user + key id).
// The scanner's own exact caps (src/scanner/limits.ts: per person per minute/hour plus a shared cap, reserved atomically in
// D1 table scan_identify_calls before each recognizer call) run in addition to this hook.
export interface RateLimitHook { check(caller: string, bucket: string): Promise<{ ok: true } | { ok: false; retry_after_s: number }> }
export const allowAll: RateLimitHook = { async check() { return { ok: true }; } };
