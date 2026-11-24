// The contract file is generated from the zod schemas and must never drift; its shape must stay mergeable into pts-v2.
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { generateSpec } from '../src/app';
import { SPEC } from './helpers/harness';

const ops = () => Object.entries<any>(SPEC.paths).flatMap(([path, item]) => Object.entries<any>(item).map(([method, op]) => ({ path, method, op })));

test('LOCK spec-single-source: contract/openapi.json equals what the zod schemas generate (run `npm run spec`)', () => {
  expect(JSON.parse(JSON.stringify(generateSpec()))).toEqual(SPEC);
});
test('marked DRAFT 1, OpenAPI 3.1, platform server /api/v1, every path under /scanner/', () => {
  expect(SPEC.openapi).toBe('3.1.0');
  expect(SPEC.info.version).toMatch(/draft1/); expect(SPEC.info.description).toMatch(/DRAFT 1/);
  expect(SPEC.servers[0].url).toBe('/api/v1');
  for (const p of Object.keys(SPEC.paths)) expect(p.startsWith('/scanner/')).toBe(true);
});
test('mergeable: operationIds prefixed `scanner`, components prefixed `Scanner` (or shared platform names)', () => {
  for (const { op } of ops()) expect(op.operationId).toMatch(/^scanner[A-Z]/);
  for (const name of Object.keys(SPEC.components.schemas)) expect(name).toMatch(/^(Scanner[A-Z]|Problem$|Timestamp$|ApiKeyScope$)/);
});
test('every operation needs a key and documents 401; every write takes Idempotency-Key', () => {
  expect(SPEC.security).toEqual([{ api_key: [] }]);
  for (const { method, op, path } of ops()) {
    expect(op.responses['401'], `${method} ${path}`).toBeTruthy();
    if (['post', 'patch'].includes(method)) expect(op.parameters?.some((p: any) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key' && p.required), `${method} ${path}`).toBe(true);
  }
});
test('every error response is problem+json; money fields are integer cents', () => {
  for (const { op } of ops()) for (const [status, r] of Object.entries<any>(op.responses)) if (Number(status) >= 400) expect(Object.keys(r.content)).toEqual(['application/problem+json']);
  const text = JSON.stringify(SPEC.components.schemas);
  expect(text).not.toMatch(/"(estimated_value|value|fig_value|part_out_value)"/);
});
test.skipIf(!process.env.PTS_V2_SPEC || !existsSync(String(process.env.PTS_V2_SPEC)))('no collisions with the pts-v2 platform spec (set PTS_V2_SPEC to its path)', () => {
  const base = JSON.parse(readFileSync(String(process.env.PTS_V2_SPEC), 'utf8'));
  const basePaths = new Set(Object.keys(base.paths ?? {}));
  for (const p of Object.keys(SPEC.paths)) expect(basePaths.has(p)).toBe(false);
  const baseOps = new Set(Object.values<any>(base.paths ?? {}).flatMap((i) => Object.values<any>(i).map((o) => o.operationId)));
  for (const { op } of ops()) expect(baseOps.has(op.operationId)).toBe(false);
  for (const n of Object.keys(SPEC.components.schemas)) if (base.components?.schemas?.[n]) expect(['Problem', 'Timestamp']).toContain(n);
});
