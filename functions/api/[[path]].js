// pts-v2 API router. Every /api/* request lands here.
// Rules: versioned URLs (/api/v1/...), one error shape, one JSON log line per request.
import spec from "../../spec/openapi.json";
import { handleScanner } from "../../apps/scanner/pages-bundle/scanner.mjs"; // Part Scanner v2 (apps/scanner), fail-closed auth

const SERVICE = "pts-v2";

function json(body, status, rid) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": rid,
    },
  });
}

function fail(status, code, message, rid) {
  return json({ error: { code, message, request_id: rid } }, status, rid);
}

async function health(env, rid) {
  const t0 = Date.now();
  try {
    const row = await env.DB.prepare("SELECT 1 AS one").first();
    const db = { ok: row && row.one === 1, select_1: row ? row.one : null, ms: Date.now() - t0 };
    if (!db.ok) return fail(503, "db_unavailable", "Database check failed", rid);
    return json({ ok: true, service: SERVICE, version: "v1", db, request_id: rid, time: new Date().toISOString() }, 200, rid);
  } catch (e) {
    return fail(503, "db_unavailable", "Database check failed", rid);
  }
}

const routes = {
  "GET /api/v1/health": (ctx, rid) => health(ctx.env, rid),
  "GET /api/v1/openapi.json": (ctx, rid) => json(spec, 200, rid),
};

export async function onRequest(ctx) {
  const t0 = Date.now();
  const rid = ctx.request.headers.get("cf-ray") || crypto.randomUUID();
  const url = new URL(ctx.request.url);
  const key = `${ctx.request.method} ${url.pathname}`;
  let res;
  let route = "unmatched";
  try {
    const handler = routes[key];
    if (url.pathname.startsWith("/api/v1/scanner/")) {
      route = "scanner";
      res = await handleScanner(ctx.request, ctx.env, ctx);
    } else if (handler) {
      route = key;
      res = await handler(ctx, rid);
    } else if (Object.keys(routes).some((k) => k.endsWith(" " + url.pathname))) {
      res = fail(405, "method_not_allowed", "Method not allowed", rid);
    } else {
      res = fail(404, "not_found", "No such API route", rid);
    }
  } catch (e) {
    res = fail(500, "internal", "Internal error", rid);
  }
  console.log(JSON.stringify({
    level: res.status >= 500 ? "error" : "info",
    service: SERVICE,
    request_id: res.headers.get("x-request-id") || rid,
    method: ctx.request.method,
    path: url.pathname,
    route,
    status: res.status,
    ms: Date.now() - t0,
  }));
  return res;
}
