import type { MiddlewareHandler } from 'hono';
import { problem } from '../platform/problem';

// Limits for the naming (ID) routes, listed here for A&S review (A&S rules, Nov 24 2026, 12:01 PM CT).
// Each is a constant with an env override where noted; change them here only.
export const ID_LIMITS = {
  /** Max size of one crop file. Over → 413 `crop_too_large`. */
  maxCropBytes: 300 * 1024,
  /** Max size of the whole multipart request on an ID route. Over → 413 `body_too_large`. */
  maxIdBodyBytes: 400 * 1024,
  /** Crops (files) per request. More → 400 `too_many_crops`. */
  maxCropsPerRequest: 1,
  /** Per caller (user), rolling 60 s. Over → 429 `rate_limited` + Retry-After. Env IDENTIFY_PER_MINUTE_LIMIT. */
  perMinute: 20,
  /** Per caller (user), rolling hour. Over → 429 `rate_limited` + Retry-After. Env IDENTIFY_HOURLY_LIMIT. */
  perHour: 100,
  /** All callers together, rolling 60 s (one free recognizer tier behind every sorter). 429 `limit: "global_minute"`. */
  globalPerMinute: 60,
  /** All callers together, rolling hour. 429 `limit: "global_hourly"`. */
  globalPerHour: 600,
  /** Rate rows (scan_identify_calls) older than this are purged, a few hundred at a time, during normal naming requests. */
  rateRowRetentionDays: 7,
} as const;
/** Write path (ADR 0010). */
export const WRITE_LIMITS = {
  /** Optimistic attempts per write before 409 `write_conflict` (jittered backoff between attempts). */
  attempts: 8,
  /** Chance that a reserved naming also purges old rate rows (bounded delete). */
  identifyPurgeChance: 0.05,
} as const;
/** Idempotency-Key and sync client_event_id length (must agree with the scan_events CHECK). */
export const KEY_MAX = 128;
/** Max JSON body on every other route (no images allowed there). Over → 413 `body_too_large`. */
export const MAX_JSON_BODY_BYTES = 256 * 1024;
/** Events per batch (G8): bounds replay cost. Over → 409 `batch_event_limit` (routes) or rejected (sync). */
export const MAX_EVENTS_PER_BATCH = 5000;
/** Text field limits shared by the routes and the sync endpoint (G7). */
export const TEXT_LIMITS = { batchName: 60, batchNote: 500, cardNote: 200, drawerCode: 40, helpText: 500 } as const;

/** Crops-per-request cap, checked after auth and before schema validation so the caller gets a clear code. */
export function cropCountGuard(isIdRoute: (method: string, path: string) => boolean): MiddlewareHandler {
  return async (c, next) => {
    if (isIdRoute(c.req.method, new URL(c.req.url).pathname) && (c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/')) {
      let files = 0;
      try { for (const v of (await c.req.raw.clone().formData()).values()) if (typeof v !== 'string') files++; } catch { /* bad multipart: the validator answers 400 */ }
      if (files > ID_LIMITS.maxCropsPerRequest)
        throw problem(400, 'too_many_crops', { limit: ID_LIMITS.maxCropsPerRequest, detail: `Send ${ID_LIMITS.maxCropsPerRequest} crop per request (got ${files}).` });
    }
    await next();
  };
}
