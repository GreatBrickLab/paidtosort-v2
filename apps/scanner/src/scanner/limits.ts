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
} as const;
/** Max JSON body on every other route (no images allowed there). Over → 413 `body_too_large`. */
export const MAX_JSON_BODY_BYTES = 256 * 1024;

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
