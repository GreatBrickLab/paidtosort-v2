// Shared conventions from the pts-v2 platform base (paidtosort/v2/README.md, 18 base requirements approved by Chris
// Nov 24 2026 11:29–11:33 AM CT). Everything platform-wide lives in src/platform/ so it can be swapped for
// Web Boss's shared base in one place. Scanner code imports from here and never re-invents these.
export const API_BASE = '/api/v1';          // #3 versioning in the URL; scanner routes live under /api/v1/scanner/…
export const CURRENCY = 'USD' as const;     // #18 money as integer cents plus an ISO 4217 currency
export const toCents = (usd: number | null | undefined): number | null => (typeof usd === 'number' && Number.isFinite(usd) ? Math.round(usd * 100) : null);
export const nowIso = (d = new Date()) => d.toISOString();  // #18 UTC ISO 8601 with Z
