// Standard reply rules and request guards from A&S's V2-SECURITY-CONTRACT.md (DRAFT 1, Nov 24 2026) and the A&S review
// of the v0 slice (12:17 PM CT). Platform-wide; replaced by A&S's shared middleware when it ships.
//
// ORDER (src/app.ts): header-only guards first (same-origin, one credential), then auth, and only then anything that
// reads the body (byte cap, no-image scan, crop count). A signed-out caller never makes us read its body.
import type { MiddlewareHandler } from 'hono';
import { problem, registerProblemTitles } from './problem';

registerProblemTitles({
  unsupported_media_type: 'Image data is not accepted here', image_data_refused: 'Image data is not accepted here',
  body_too_large: 'The request body is too large', cross_origin_refused: 'Cross-site writes are refused',
  ambiguous_credentials: 'Send a key or a session cookie, not both',
});

/** The ONLY cookie that counts as a session (A&S's sign-in). Other cookies (for example an edge access-gate cookie) are ignored. */
export const SESSION_COOKIE = '__Secure-better-auth.session_token';

export function hasSessionCookie(cookieHeader: string | undefined | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(';').some((part) => {
    const eq = part.indexOf('=');
    return eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE && part.slice(eq + 1).trim() !== '';
  });
}
const hasBearer = (h: string | undefined) => /^Bearer\s/i.test(h ?? '');

/** §4 standard headers (every reply, errors included) + API reply rules. */
export const STANDARD_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', // the API itself never needs the camera; the scanner page asks for camera=(self)
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex',
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Authorization',
};
export function applyStandardHeaders(h: Headers) {
  for (const [k, v] of Object.entries(STANDARD_HEADERS)) h.set(k, v);
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** G4: a request carrying BOTH our session cookie and an API key is refused (400) on every route, before auth. */
export const oneCredentialOnly: MiddlewareHandler = async (c, next) => {
  if (hasSessionCookie(c.req.header('cookie')) && hasBearer(c.req.header('authorization')))
    throw problem(400, 'ambiguous_credentials', { detail: 'Use either an API key or a session cookie, not both.' });
  await next();
};

/**
 * §5 test 8 + G5: cookie-auth writes must be provably same-origin: `Origin` equal to this origin, or (when the browser
 * sent no Origin) `Sec-Fetch-Site: same-origin`. Missing both → refused. Key-auth calls (curl, servers) carry no session
 * cookie and are not affected; browsers can't send a Bearer header cross-site without a CORS preflight we never answer.
 */
export const sameOriginForCookieWrites: MiddlewareHandler = async (c, next) => {
  if (WRITE.has(c.req.method) && hasSessionCookie(c.req.header('cookie')) && !hasBearer(c.req.header('authorization'))) {
    const origin = c.req.header('origin');
    const site = c.req.header('sec-fetch-site');
    const self = new URL(c.req.url).origin;
    const ok = origin ? origin === self && site !== 'cross-site' && site !== 'same-site' : site === 'same-origin';
    if (!ok) throw problem(403, 'cross_origin_refused');
  }
  await next();
};

/**
 * M1 / G1: counts the bytes actually received (not Content-Length) and stops reading at the cap (413). Runs AFTER auth.
 * The capped body is buffered once and handed on, so later parsers never see more than `limit` bytes.
 */
export function bodyCap(limitFor: (method: string, path: string) => number): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    if (!WRITE.has(c.req.method) || !raw.body) return next();
    const limit = limitFor(c.req.method, new URL(c.req.url).pathname);
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > limit) throw problem(413, 'body_too_large', { limit_bytes: limit });
    const reader = raw.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => {}); throw problem(413, 'body_too_large', { limit_bytes: limit }); }
      chunks.push(value);
    }
    const buf = new Uint8Array(total); let off = 0;
    for (const ch of chunks) { buf.set(ch, off); off += ch.byteLength; }
    const headers = new Headers(raw.headers); headers.set('content-length', String(total));
    (c.req as { raw: Request }).raw = new Request(raw.url, { method: raw.method, headers, body: buf });
    await next();
  };
}

/**
 * §5 test 6: no image data except on the approved naming routes. Image content-types, multipart, data URLs and long
 * base64 runs are refused (415). Runs after auth and after bodyCap, on the already-capped body.
 */
export function noImagesExcept(isIdRoute: (method: string, path: string) => boolean): MiddlewareHandler {
  return async (c, next) => {
    if (!WRITE.has(c.req.method) || isIdRoute(c.req.method, new URL(c.req.url).pathname)) return next();
    const ctype = (c.req.header('content-type') ?? '').toLowerCase();
    if (ctype.startsWith('image/') || ctype.startsWith('multipart/') || ctype.startsWith('application/octet-stream')) throw problem(415, 'unsupported_media_type', { detail: 'Only the naming routes take an image.' });
    const text = await c.req.raw.clone().text();
    if (/data:image\//i.test(text) || /[A-Za-z0-9+/]{2000,}={0,2}/.test(text)) throw problem(415, 'image_data_refused', { detail: 'Only the naming routes take an image.' });
    await next();
  };
}
