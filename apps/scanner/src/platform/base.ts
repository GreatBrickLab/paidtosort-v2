// The platform shell every section mounts into: request ids (#4), one JSON log line per request (#4), one error contract
// (#5), schema validation before handlers with `invalid_request` (#12), 404/405 in the error shape.
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Hook } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { ApiError, problem, problemResponse } from './problem';
import { newId } from './ids';
import { applyStandardHeaders } from './security';

export type AppVars = { Variables: { request_id: string; route: string; principal: unknown } };

/** zod validation failures → 400 invalid_request with errors[] (missing Idempotency-Key gets its own code). */
export const validationHook: Hook<any, any, any, any> = (result, c) => {
  if (result.success) return;
  const issues = (result as any).error?.issues ?? [];
  if ((result as any).target === 'header' && issues.some((i: any) => String(i.path?.[0]).toLowerCase() === 'idempotency-key')) {
    throw problem(400, 'idempotency_key_missing', { detail: 'Send an Idempotency-Key header (8–200 letters, digits, _ . : -).' });
  }
  throw problem(400, 'invalid_request', {
    errors: issues.slice(0, 20).map((i: any) => ({ field: [(result as any).target, ...(i.path ?? [])].join('.'), message: String(i.message) })),
  });
};

export function newSectionRouter() { return new OpenAPIHono<AppVars>({ defaultHook: validationHook }); }

export function createPlatformApp(opts: { log?: (line: Record<string, unknown>) => void; knownPaths?: () => string[] } = {}) {
  const app = new OpenAPIHono<AppVars>({ defaultHook: validationHook });
  const log = opts.log ?? ((l) => console.log(JSON.stringify(l)));
  app.use('*', async (c, next) => {
    const t0 = Date.now();
    const rid = newId('req');
    c.set('request_id', rid);
    try { await next(); } finally {
      c.res.headers.set('x-request-id', rid);
      applyStandardHeaders(c.res.headers);
      // never logs keys, bodies or crops
      log({ level: c.res.status >= 500 ? 'error' : 'info', service: 'pts-scanner', request_id: rid, method: c.req.method, path: new URL(c.req.url).pathname,
        route: c.req.routePath ?? 'unmatched', status: c.res.status, ms: Date.now() - t0 });
    }
  });
  app.onError((err, c) => toProblem(err, c));
  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    const sameShape = opts.knownPaths?.().some((tpl) => new RegExp(`^${tpl.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path));
    return toProblem(sameShape ? problem(405, 'method_not_allowed') : problem(404, 'not_found', { detail: 'No such API route' }), c);
  });
  return app;
}

export function toProblem(err: unknown, c: Context) {
  const rid = (c.get('request_id' as never) as string) || newId('req');
  const e = err instanceof ApiError ? err : problem(500, 'internal');
  if (!(err instanceof ApiError)) console.log(JSON.stringify({ level: 'error', request_id: rid, error: String((err as Error)?.message ?? err).slice(0, 300) }));
  return problemResponse(e, new URL(c.req.url).pathname, rid);
}
