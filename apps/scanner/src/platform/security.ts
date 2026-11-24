// Standard reply rules and request guards from A&S's V2-SECURITY-CONTRACT.md (DRAFT 1, Nov 24 2026).
// These are platform-wide; when A&S ships its shared middleware/test kit, this file is replaced by it.
import type { MiddlewareHandler } from 'hono';
import { problem, registerProblemTitles } from './problem';

registerProblemTitles({
  unsupported_media_type: 'Image data is not accepted here', image_data_refused: 'Image data is not accepted here',
  body_too_large: 'The request body is too large', cross_origin_refused: 'Cross-site writes are refused',
  ambiguous_credentials: 'Send a key or a session cookie, not both',
});

/** §4 standard headers (every reply, errors included) + API reply rules. */
export const STANDARD_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', // the API itself never needs the camera; the scanner page asks for camera=(self)
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  'X-Robots-Tag': 'noindex',
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
};
export function applyStandardHeaders(h: Headers) {
  for (const [k, v] of Object.entries(STANDARD_HEADERS)) h.set(k, v);
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A&S ID-route rule 1: a request carrying BOTH a session cookie and an API key is refused (400), before auth runs. */
export function oneCredentialOnly(applies: (method: string, path: string) => boolean): MiddlewareHandler {
  return async (c, next) => {
    if (applies(c.req.method, new URL(c.req.url).pathname) && c.req.header('cookie') && /^Bearer\s/i.test(c.req.header('authorization') ?? ''))
      throw problem(400, 'ambiguous_credentials', { detail: 'Use either an API key or a session cookie on this route.' });
    await next();
  };
}

/**
 * §5 test 8: writes need same-origin, but only for COOKIE auth (browser sessions, owned by A&S). Calls that carry a
 * Bearer key are allowed from anywhere (curl, servers): a browser cannot send them cross-site without a CORS preflight,
 * which this API never answers.
 */
export const sameOriginForCookieWrites: MiddlewareHandler = async (c, next) => {
  if (WRITE.has(c.req.method) && !/^Bearer\s/i.test(c.req.header('authorization') ?? '') && c.req.header('cookie')) {
    const origin = c.req.header('origin');
    const site = c.req.header('sec-fetch-site');
    if ((origin && origin !== new URL(c.req.url).origin) || site === 'cross-site') throw problem(403, 'cross_origin_refused');
  }
  await next();
};

/**
 * §5 test 6: no image data except on the approved naming routes. Image content-types, multipart, data URLs, long
 * base64 runs and too-large bodies are refused (415 / 413) everywhere else, before any handler runs.
 */
export function noImagesExcept(isIdRoute: (method: string, path: string) => boolean, limits = { body: 256 * 1024, idBody: 400 * 1024 }): MiddlewareHandler {
  return async (c, next) => {
    if (!WRITE.has(c.req.method)) return next();
    const path = new URL(c.req.url).pathname;
    const id = isIdRoute(c.req.method, path);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > (id ? limits.idBody : limits.body)) throw problem(413, 'body_too_large');
    if (id) return next();
    const ctype = (c.req.header('content-type') ?? '').toLowerCase();
    if (ctype.startsWith('image/') || ctype.startsWith('multipart/') || ctype.startsWith('application/octet-stream')) throw problem(415, 'unsupported_media_type', { detail: 'Only the naming routes take an image.' });
    const text = await c.req.raw.clone().text();
    if (text.length > limits.body) throw problem(413, 'body_too_large');
    if (/data:image\//i.test(text) || /[A-Za-z0-9+/]{2000,}={0,2}/.test(text)) throw problem(415, 'image_data_refused', { detail: 'Only the naming routes take an image.' });
    await next();
  };
}
