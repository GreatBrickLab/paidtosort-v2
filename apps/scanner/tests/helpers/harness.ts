// Test harness: the real app + a real local D1 (Miniflare, in memory) + fake auth + stub recognizer + contract checks.
// Nothing here touches a network, a real database, or the real recognizer.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect } from 'vitest';
import { createApp } from '../../src/app';
import { FakeLocalVerifier, type Principal } from '../../src/platform/auth';
import { rand } from '../../src/platform/ids';
import { StubRecognizer } from '../../src/scanner/adapters/recognizer';

export const SPEC = JSON.parse(readFileSync(new URL('../../contract/openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'spec', components: SPEC.components });
export const covered = new Set<string>(); // "operationId status"

const P = (o: Partial<Principal> & Pick<Principal, 'user_id' | 'name' | 'role' | 'scopes'>): Principal => ({ key_id: `key_${rand(12)}`, mode: 'test', ...o });
// Stand-ins for what A&S's auth would return. Role → scopes here is a TEST FIXTURE, not a design for A&S.
export const PEOPLE = {
  sorterA: P({ user_id: 'usr_sam_test', name: 'Sam Sorter', role: 'sorter', scopes: ['scan:write', 'batches:read'] }),
  sorterB: P({ user_id: 'usr_pat_test', name: 'Pat Sorter', role: 'sorter', scopes: ['scan:write', 'batches:read'] }),
  team: P({ user_id: 'usr_terry_test', name: 'Terry Team', role: 'team', scopes: ['scan:write', 'batches:read', 'batches:read_all'] }),
  admin: P({ user_id: 'usr_alex_test', name: 'Alex Admin', role: 'admin', scopes: ['scan:write', 'batches:read', 'batches:read_all', 'exports:create', 'batches:process'] }),
  pending: P({ user_id: 'usr_pending_test', name: 'Penny Pending', role: 'pending', scopes: [] }), // pending/declined: no role, no scanner access
};
export type Who = keyof typeof PEOPLE;

const SCHEMA_SQL = readFileSync(new URL('../../proposed-schema/0001_scan_tables.sql', import.meta.url), 'utf8');

export async function setup(opts: { limit?: number; perMinute?: number; now?: () => Date; rateLimit?: import('../../src/platform/ratelimit').RateLimitHook } = {}) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null) } }', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  const stmts = SCHEMA_SQL.replace(/--[^\n]*/g, '').split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
  for (const s of stmts) await db.prepare(s).run();
  const tokens: Record<string, Principal> = {}; const tokenOf = {} as Record<Who, string>;
  for (const [k, v] of Object.entries(PEOPLE)) { const t = `pts_test_${rand(32).replace(/[^A-Za-z0-9]/g, 'x')}`; tokens[t] = v; tokenOf[k as Who] = t; }
  const recognizer = new StubRecognizer();
  const logs: Record<string, unknown>[] = [];
  const app = createApp({ verifier: new FakeLocalVerifier(tokens), deps: { recognizer, identifyHourlyLimit: opts.limit ?? 100, identifyPerMinuteLimit: opts.perMinute ?? 20, now: opts.now, rateLimit: opts.rateLimit }, log: (l) => logs.push(l) });
  const env = { DB: db };

  async function call(who: Who | null, method: string, path: string, o: { body?: unknown; form?: FormData; key?: string | null; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (who) headers.authorization = `Bearer ${tokenOf[who]}`;
    if (['POST', 'PATCH'].includes(method) && o.key !== null) headers['idempotency-key'] = o.key ?? `k-${rand(16)}`;
    let body: BodyInit | undefined;
    if (o.form) body = o.form; else if (o.body !== undefined) { body = JSON.stringify(o.body); headers['content-type'] = 'application/json'; }
    const res = await app.request(`/api/v1${path}`, { method, headers, body }, env);
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  }
  return { mf, db, app, env, call, recognizer, logs, tokenOf, close: () => mf.dispose() };
}
export type H = Awaited<ReturnType<typeof setup>>;

/** Asserts the answer matches contract/openapi.json for that operation and status, and records coverage. */
export function conforms(r: { status: number; headers: Headers; json: any; text: string }, method: string, template: string) {
  const op = SPEC.paths[template]?.[method.toLowerCase()];
  expect(op, `${method} ${template} is in the contract`).toBeTruthy();
  const resp = op.responses[String(r.status)];
  expect(resp, `${method} ${template} documents status ${r.status} (body: ${r.text.slice(0, 300)})`).toBeTruthy();
  const ctype = (r.headers.get('content-type') ?? '').split(';')[0];
  const media = resp.content?.[ctype];
  expect(media, `${method} ${template} ${r.status} documents ${ctype}`).toBeTruthy();
  if (media.schema && (ctype.includes('json'))) {
    const validate = ajv.compile(wrap(media.schema));
    const okv = validate(r.json);
    expect(okv, `${method} ${template} ${r.status} matches the contract: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
  expect(r.headers.get('x-request-id')).toMatch(/^req_/);
  covered.add(`${op.operationId} ${r.status}`);
  return r;
}
const wrap = (schema: any) => JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"spec#/components/'));

export const crop = (directive = '', size = 0) => {
  const fd = new FormData();
  const bytes = size ? new Uint8Array(size).fill(65) : new TextEncoder().encode(directive ? `STUB:${directive}` : 'jpegbytes');
  if (directive && size) bytes.set(new TextEncoder().encode(`STUB:${directive} `));
  fd.append('crop', new File([bytes], 'crop.jpg', { type: 'image/jpeg' }));
  return fd;
};
export const cardForm = (meta: Record<string, unknown> = {}, directive = '', size = 0) => { const fd = crop(directive, size); fd.append('meta', JSON.stringify(meta)); return fd; };

/** A sorter's open batch with one drawer and one photo of 5 boxes. */
export async function batchWithDrawer(h: H, who: Who = 'sorterA', condition: 'U' | 'N' = 'U') {
  const b = await h.call(who, 'POST', '/scanner/batches', { body: { condition } });
  expect(b.status, b.text).toBe(201);
  const d = await h.call(who, 'POST', `/scanner/batches/${b.json.id}/drawers`, { body: { code: 'test-a1' } });
  expect(d.status, d.text).toBe(201);
  const ph = await h.call(who, 'POST', `/scanner/batches/${b.json.id}/photos`, { body: { boxes: 5 } });
  expect(ph.status, ph.text).toBe(201);
  return { batch: b.json, photo: ph.json };
}
export async function addCard(h: H, batchId: string, directive = '', meta: Record<string, unknown> = {}, who: Who = 'sorterA') {
  return h.call(who, 'POST', `/scanner/batches/${batchId}/cards`, { form: cardForm(meta, directive) });
}
