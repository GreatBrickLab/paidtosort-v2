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

if (errors.length) { console.error("CONTRACT FAIL\n" + errors.join("\n")); process.exit(1); }
console.log(`CONTRACT PASS (${base}): /api/v1/health and 404 error shape match spec`);
