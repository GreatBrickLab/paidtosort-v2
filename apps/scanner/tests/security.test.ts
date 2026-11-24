// Mirrors the 9 tests of A&S's security kit (V2-SECURITY-CONTRACT.md §5, DRAFT 1) for every scanner route, so they can be
// swapped for A&S's shared helper later. Differences from the kit's literal text are listed in README (error shape).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { STANDARD_HEADERS } from '../src/platform/security';
import { SPEC, type H, type Who, addCard, batchWithDrawer, cardForm, conforms, crop, setup } from './helpers/harness';

let h: H;
const f: Record<string, string> = {};
beforeAll(async () => {
  h = await setup();
  // A finished batch of sorter A with an export, then an open one with a card.
  const done = await batchWithDrawer(h, 'sorterA');
  const c1 = await addCard(h, done.batch.id);
  await h.call('sorterA', 'POST', `/scanner/cards/${c1.json.id}/decision`, { body: { state: 'approved' } });
  await h.call('sorterA', 'POST', `/scanner/batches/${done.batch.id}/finish`);
  const ex = await h.call('admin', 'POST', `/scanner/batches/${done.batch.id}/exports`, { body: { format: 'bsx' } });
  f.finished = done.batch.id; f.export = ex.json.id; f.finishedCard = c1.json.id;
  const open = await batchWithDrawer(h, 'sorterA');
  f.open = open.batch.id; f.photo = open.photo.id;
  f.card = (await addCard(h, open.batch.id)).json.id;
  f.fig = (await addCard(h, open.batch.id, 'fig')).json.id;
});
afterAll(async () => { await h.close(); });

type Req = { method: string; path: () => string; body?: () => unknown; form?: () => FormData; tpl: string };
const ROUTES: Record<string, Req> = {
  scannerGetMe: { method: 'GET', tpl: '/scanner/me', path: () => '/scanner/me' },
  scannerListBatches: { method: 'GET', tpl: '/scanner/batches', path: () => '/scanner/batches' },
  scannerCreateBatch: { method: 'POST', tpl: '/scanner/batches', path: () => '/scanner/batches', body: () => ({ condition: 'U' }) },
  scannerGetBatch: { method: 'GET', tpl: '/scanner/batches/{batch_id}', path: () => `/scanner/batches/${f.open}` },
  scannerUpdateBatch: { method: 'PATCH', tpl: '/scanner/batches/{batch_id}', path: () => `/scanner/batches/${f.open}`, body: () => ({ note: 'x' }) },
  scannerFinishBatch: { method: 'POST', tpl: '/scanner/batches/{batch_id}/finish', path: () => `/scanner/batches/${f.open}/finish` },
  scannerReopenBatch: { method: 'POST', tpl: '/scanner/batches/{batch_id}/reopen', path: () => `/scanner/batches/${f.finished}/reopen` },
  scannerMarkBatchProcessed: { method: 'POST', tpl: '/scanner/batches/{batch_id}/processed', path: () => `/scanner/batches/${f.finished}/processed` },
  scannerListBatchEvents: { method: 'GET', tpl: '/scanner/batches/{batch_id}/events', path: () => `/scanner/batches/${f.open}/events` },
  scannerAppendBatchEvents: { method: 'POST', tpl: '/scanner/batches/{batch_id}/events', path: () => `/scanner/batches/${f.open}/events`, body: () => ({ events: [{ client_event_id: 'sec-0001-xxxx', type: 'batch.noted', payload: { note: 'x' } }] }) },
  scannerListDrawers: { method: 'GET', tpl: '/scanner/batches/{batch_id}/drawers', path: () => `/scanner/batches/${f.open}/drawers` },
  scannerOpenDrawer: { method: 'POST', tpl: '/scanner/batches/{batch_id}/drawers', path: () => `/scanner/batches/${f.open}/drawers`, body: () => ({ code: 'test-c3' }) },
  scannerRecordPhoto: { method: 'POST', tpl: '/scanner/batches/{batch_id}/photos', path: () => `/scanner/batches/${f.open}/photos`, body: () => ({ boxes: 2 }) },
  scannerListCards: { method: 'GET', tpl: '/scanner/batches/{batch_id}/cards', path: () => `/scanner/batches/${f.open}/cards` },
  scannerCreateCard: { method: 'POST', tpl: '/scanner/batches/{batch_id}/cards', path: () => `/scanner/batches/${f.open}/cards`, form: () => cardForm({}) },
  scannerGetCard: { method: 'GET', tpl: '/scanner/cards/{card_id}', path: () => `/scanner/cards/${f.card}` },
  scannerUpdateCard: { method: 'PATCH', tpl: '/scanner/cards/{card_id}', path: () => `/scanner/cards/${f.card}`, body: () => ({ qty: 2 }) },
  scannerRetryIdentify: { method: 'POST', tpl: '/scanner/cards/{card_id}/identify', path: () => `/scanner/cards/${f.card}/identify`, form: () => crop() },
  scannerDecideCard: { method: 'POST', tpl: '/scanner/cards/{card_id}/decision', path: () => `/scanner/cards/${f.card}/decision`, body: () => ({ state: 'dropped' }) },
  scannerReopenCard: { method: 'POST', tpl: '/scanner/cards/{card_id}/reopen', path: () => `/scanner/cards/${f.card}/reopen` },
  scannerPartOutFig: { method: 'POST', tpl: '/scanner/cards/{card_id}/part-out', path: () => `/scanner/cards/${f.fig}/part-out`, body: () => ({}) },
  scannerHoldFig: { method: 'POST', tpl: '/scanner/cards/{card_id}/hold', path: () => `/scanner/cards/${f.fig}/hold`, body: () => ({ reason: 'other' }) },
  scannerNeedHelp: { method: 'POST', tpl: '/scanner/cards/{card_id}/need-help', path: () => `/scanner/cards/${f.card}/need-help`, body: () => ({ text: 'help' }) },
  scannerCreateExport: { method: 'POST', tpl: '/scanner/batches/{batch_id}/exports', path: () => `/scanner/batches/${f.finished}/exports`, body: () => ({ format: 'json' }) },
  scannerGetExport: { method: 'GET', tpl: '/scanner/exports/{export_id}', path: () => `/scanner/exports/${f.export}` },
  scannerDownloadExport: { method: 'GET', tpl: '/scanner/exports/{export_id}/file', path: () => `/scanner/exports/${f.export}/file` },
  scannerListFinds: { method: 'GET', tpl: '/scanner/finds', path: () => '/scanner/finds?type=held' },
  scannerGetSpec: { method: 'GET', tpl: '/scanner/openapi.json', path: () => '/scanner/openapi.json' },
};
const send = (who: Who | null, r: Req, headers?: Record<string, string>) => h.call(who, r.method, r.path(), { body: r.body?.(), form: r.form?.(), headers });
const ID_ROUTES = ['scannerCreateCard', 'scannerRetryIdentify'];
const NO_DATA = (j: any) => { for (const k of ['data', 'id', 'name', 'batch', 'cards', 'user']) expect(j).not.toHaveProperty(k); };

test('the security table covers every operation in the contract', () => {
  const ops = Object.values<any>(SPEC.paths).flatMap((item) => Object.values<any>(item).map((op) => op.operationId));
  expect(Object.keys(ROUTES).sort()).toEqual(ops.sort());
});

describe.each(Object.entries(ROUTES))('%s', (op, r) => {
  test('kit #1 signed out → 401, no data (also for an unknown or live-looking key)', async () => {
    const res = conforms(await send(null, r), r.method, r.tpl);
    expect(res.status).toBe(401); expect(res.json.code).toBe('api_key_missing'); NO_DATA(res.json);
    // fake keys built at runtime so the secrets scan stays clean
    for (const bad of ['test', 'live'].map((m) => `pts_${m}_${'A'.repeat(32)}`)) {
      const b = conforms(await send(null, r, { authorization: `Bearer ${bad}` }), r.method, r.tpl);
      expect(b.status).toBe(401); expect(b.json.code).toBe('api_key_invalid'); NO_DATA(b.json);
    }
  });
  test('kit #2 wrong role: a pending user (no role) → 403, no data', async () => {
    const res = conforms(await send('pending', r), r.method, r.tpl);
    expect(res.status).toBe(403); expect(res.json.code).toBe('forbidden'); NO_DATA(res.json);
  });
  if (/batch_id|card_id|export_id/.test(r.tpl)) {
    test("kit #3 across sorters: sorter B can't reach sorter A's object (guessed id → 404; admin-only routes → 403 first)", async () => {
      const res = conforms(await send('sorterB', r), r.method, r.tpl);
      const adminOnly = /export|processed/.test(r.tpl);
      expect(res.status).toBe(adminOnly ? 403 : 404); NO_DATA(res.json);
    });
  }
  test('kit #4 + #5 no caching and the standard headers, on success and on errors', async () => {
    for (const who of ['sorterA', null] as const) {
      const res = await send(who, r);
      for (const [k, v] of Object.entries(STANDARD_HEADERS)) expect(res.headers.get(k), `${k} (${res.status})`).toBe(v);
    }
  });
  if (r.method !== 'GET' && !ID_ROUTES.includes(op)) {
    test('kit #6 no photos: image content-type, multipart, data URL, base64 blob → 415; too large → 413', async () => {
      const path = r.path();
      const img = await h.call('sorterA', r.method, path, { headers: { 'content-type': 'image/jpeg' } });
      expect(img.status).toBe(415);
      const mp = await h.call('sorterA', r.method, path, { form: crop() });
      expect(mp.status).toBe(415);
      const dataUrl = await h.call('sorterA', r.method, path, { body: { note: 'data:image/png;base64,iVBORw0KGgo=' } });
      expect(dataUrl.status).toBe(415);
      const b64 = await h.call('sorterA', r.method, path, { body: { note: 'A'.repeat(3000) } });
      expect(b64.status).toBe(415);
      const big = await h.call('sorterA', r.method, path, { body: { note: 'word '.repeat(60000) } });
      expect(big.status).toBe(413);
      for (const x of [img, mp, dataUrl, b64, big]) expect(x.headers.get('content-type')).toBe('application/problem+json');
    });
  }
  if (r.body) {
    test('kit #7 bad input: unknown fields and wrong types → 400, never 500', async () => {
      const unknown = await h.call('sorterA', r.method, r.path(), { body: { ...(r.body!() as object), sneaky_extra: 1 } });
      expect(unknown.status).toBe(400); expect(unknown.json.code).toBe('invalid_request');
      const wrong = await h.call('sorterA', r.method, r.path(), { body: Object.keys(r.body!() as object).length ? Object.fromEntries(Object.keys(r.body!() as object).map((k) => [k, { nested: true }])) : 'not-an-object' });
      expect([400]).toContain(wrong.status); expect(wrong.text).not.toMatch(/at .*\.ts:\d+/);
    });
  }
  if (r.method !== 'GET') {
    test('kit #8 cookie writes from another origin are refused; key-auth from curl (no Origin) works', async () => {
      const res = conforms(await send(null, r, { cookie: 'session=abc', origin: 'https://evil.example' }), r.method, r.tpl);
      expect(res.status).toBe(403); expect(res.json.code).toBe('cross_origin_refused');
      const site = await send(null, r, { cookie: 'session=abc', 'sec-fetch-site': 'cross-site' });
      expect(site.status).toBe(403);
      const curl = await send('pending', r); // a bearer key, no Origin header: passes the origin guard, then the scope check
      expect(curl.json.code).not.toBe('cross_origin_refused');
    });
  }
});

describe('kit #2 wrong role (more)', () => {
  const ADMIN_ONLY = ['scannerCreateExport', 'scannerGetExport', 'scannerDownloadExport', 'scannerMarkBatchProcessed', 'scannerListFinds'];
  test.each(ADMIN_ONLY)('sorter (even the owner) is refused %s', async (op) => {
    const res = await send('sorterA', ROUTES[op]);
    expect(res.status).toBe(403); expect(res.json.code).toBe('forbidden');
  });
  test('sorter asking for all batches → 403 need batches:read_all', async () => {
    const res = await h.call('sorterA', 'GET', '/scanner/batches?owner=all');
    expect(res.status).toBe(403); expect(res.json.need).toBe('batches:read_all');
  });
  test('team can read anyone’s batch but never write it (403 need owner)', async () => {
    expect((await h.call('team', 'GET', `/scanner/batches/${f.open}`)).status).toBe(200);
    for (const op of ['scannerUpdateBatch', 'scannerOpenDrawer', 'scannerUpdateCard', 'scannerDecideCard', 'scannerAppendBatchEvents', 'scannerCreateCard']) {
      const res = await send('team', ROUTES[op]);
      expect(res.status, op).toBe(403); expect(res.json.need).toBe('owner');
    }
  });
});

describe('kit #3 across sorters (lists)', () => {
  test("sorter B's list never contains sorter A's batches; B's own batch is invisible to A", async () => {
    const mine = await h.call('sorterB', 'POST', '/scanner/batches', { body: { condition: 'U' } });
    const listB = await h.call('sorterB', 'GET', '/scanner/batches');
    expect(listB.json.data.map((b: any) => b.owner.id)).toEqual(['usr_pat_test']);
    const listA = await h.call('sorterA', 'GET', '/scanner/batches');
    expect(listA.json.data.every((b: any) => b.owner.id === 'usr_sam_test')).toBe(true);
    expect((await h.call('sorterA', 'GET', `/scanner/batches/${mine.json.id}`)).status).toBe(404);
    expect((await h.call('sorterB', 'GET', `/scanner/batches?status=finished`)).json.data).toEqual([]);
  });
});

test.skipIf(!existsSync('/home/box/.local/bin/gitleaks') && !process.env.CI)('kit #9 secrets scan: gitleaks finds nothing in the repo folder', () => {
  const bin = existsSync('/home/box/.local/bin/gitleaks') ? '/home/box/.local/bin/gitleaks' : 'gitleaks';
  // dir scan, redacted, gitignored files excluded via .gitleaksignore paths in .gitleaks.toml
  execFileSync(bin, ['dir', '.', '--redact', '--no-banner', '--config', '.gitleaks.toml', '--exit-code', '1'], { stdio: 'pipe' });
});
