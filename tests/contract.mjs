// Contract test: live responses must match spec/openapi.json. Exit nonzero on any mismatch.
// Usage: node tests/contract.mjs https://pts-v2.pages.dev
import { readFileSync } from "node:fs";
const base = (process.argv[2] || "https://pts-v2.pages.dev").replace(/\/$/, "");
const spec = JSON.parse(readFileSync(new URL("../spec/openapi.json", import.meta.url)));
const schemas = spec.components.schemas;
const errors = [];

function resolve(s) { return s && s.$ref ? schemas[s.$ref.split("/").pop()] : s; }
function check(value, schema, path) {
  schema = resolve(schema);
  if (!schema) return;
  const t = schema.type;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (t === "integer") { if (!Number.isInteger(value)) errors.push(`${path}: expected integer, got ${actual}`); return; }
  if (t && t !== actual) { errors.push(`${path}: expected ${t}, got ${actual}`); return; }
  if (t === "string" && schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path}: not date-time`);
  if (t === "object") {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}.${k}: required, missing`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value) check(value[k], sub, `${path}.${k}`);
  }
}

async function call(path, expectStatus, schema) {
  const res = await fetch(base + path);
  if (res.status !== expectStatus) errors.push(`${path}: status ${res.status}, expected ${expectStatus}`);
  if (!(res.headers.get("content-type") || "").includes("application/json")) errors.push(`${path}: not JSON`);
  const body = await res.json();
  check(body, schema, path);
  const rid = res.headers.get("x-request-id");
  const bodyRid = body.request_id || (body.error && body.error.request_id);
  if (!rid || rid !== bodyRid) errors.push(`${path}: x-request-id header missing or != body request_id`);
  return body;
}

const healthSchema = spec.paths["/health"].get.responses["200"].content["application/json"].schema;
const h = await call("/api/v1/health", 200, healthSchema);
if (h.ok !== true || h.db?.select_1 !== 1) errors.push("/api/v1/health: ok/db check not true");
await call("/api/v1/does-not-exist", 404, { $ref: "#/components/schemas/Error" });

// Scanner section (/api/v1/scanner/...): fail-closed until Accounts and Security's auth ships (milestone 2).
// Every scanner operation in the spec, called signed out, must answer 401 application/problem+json that matches the
// spec's Problem schema, with request_id == x-request-id and the A&S standard headers (V2-SECURITY-CONTRACT.md §4).
const SCANNER_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "referrer-policy": "strict-origin-when-cross-origin",
};
let scannerOps = 0;
for (const [p, item] of Object.entries(spec.paths)) {
  if (!p.startsWith("/scanner/")) continue;
  for (const [method, op] of Object.entries(item)) {
    if (!op || !op.operationId) continue;
    scannerOps++;
    const path = "/api/v1" + p.replace(/\{batch_id\}/g, "bat_contracttest00000").replace(/\{card_id\}/g, "crd_contracttest00000").replace(/\{export_id\}/g, "exp_contracttest00000");
    const label = `${method.toUpperCase()} ${p}`;
    if (!op.responses || !op.responses["401"]) errors.push(`${label}: 401 not documented`);
    const res = await fetch(base + path, { method: method.toUpperCase() });
    if (res.status !== 401) errors.push(`${label}: status ${res.status}, expected 401 while signed out`);
    if ((res.headers.get("content-type") || "").split(";")[0] !== "application/problem+json") errors.push(`${label}: not application/problem+json`);
    for (const [h, v] of Object.entries(SCANNER_HEADERS)) if (res.headers.get(h) !== v) errors.push(`${label}: header ${h} = ${res.headers.get(h)}, expected ${v}`);
    const body = await res.json().catch(() => ({}));
    check(body, { $ref: "#/components/schemas/Problem" }, label);
    if (!res.headers.get("x-request-id") || res.headers.get("x-request-id") !== body.request_id) errors.push(`${label}: x-request-id header missing or != body request_id`);
    for (const k of ["data", "batch", "cards", "user"]) if (k in body) errors.push(`${label}: 401 body leaks "${k}"`);
  }
}
if (scannerOps === 0) errors.push("spec has no /scanner/ operations");

if (errors.length) { console.error("CONTRACT FAIL\n" + errors.join("\n")); process.exit(1); }
console.log(`CONTRACT PASS (${base}): /api/v1/health, 404 error shape and ${scannerOps} scanner operations (signed out → 401 problem+json) match spec`);
