// Locks the fixes from the A&S review (M1, M1b, G1–G8, Nov 24 12:17 PM CT) and the Web Boss review (12:19 PM CT).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SESSION_COOKIE } from '../src/platform/security';
import { ID_LIMITS, MAX_JSON_BODY_BYTES } from '../src/scanner/limits';
import { type H, SPEC, addCard, batchWithDrawer, cardForm, conforms, setup } from './helpers/harness';

const SESSION = `${SESSION_COOKIE}=sess-test-value`;
const CF_ACCESS = 'CF_Authorization=edge-gate-jwt; __cf_bm=abc';
let h: H | null = null;
afterEach(async () => { await h?.close(); h = null; });

/** A body of `total` bytes streamed in 64 KB chunks with no Content-Length; `pulled()` says how much was read. */
function stream(total: number) {
  let sent = 0; const chunk = new Uint8Array(64 * 1024).fill(120);
  const s = new ReadableStream<Uint8Array>({
    pull(ctl) { if (sent >= total) return ctl.close(); const n = Math.min(chunk.byteLength, total - sent); sent += n; ctl.enqueue(chunk.slice(0, n)); },
  });
  return { body: s, pulled: () => sent };
}
const MB = 1024 * 1024;

describe('M1: auth runs before anything reads the body', () => {
  test('signed-out 5 MB streamed POST (no Content-Length) → 401, body not read', async () => {
    h = await setup();
    for (const path of ['/scanner/batches', '/scanner/batches/bat_xxxxxxxxxxxxxxxx/cards', '/scanner/batches/bat_xxxxxxxxxxxxxxxx/events']) {
      const s = stream(5 * MB);
      const r = await h.call(null, 'POST', path, { raw: s.body, headers: { 'content-type': 'application/octet-stream' } });
      expect(r.status, path).toBe(401); expect(r.json.code).toBe('api_key_missing');
      expect(s.pulled(), path).toBeLessThan(MB);
    }
  });
  test('signed-out image / multipart content-types → 401, not 415', async () => {
    h = await setup();
    for (const ct of ['image/jpeg', 'multipart/form-data; boundary=x']) {
      const r = await h.call(null, 'POST', '/scanner/batches', { raw: 'x', headers: { 'content-type': ct } });
      expect(r.status).toBe(401);
    }
  });
});

describe('G1: the size cap counts streamed bytes, not Content-Length', () => {
  test('JSON route: streamed body over 256 KB with no Content-Length → 413 body_too_large, reading stops at the cap', async () => {
    h = await setup();
    const s = stream(2 * MB);
    const r = conforms(await h.call('sorterA', 'POST', '/scanner/batches', { raw: s.body, headers: { 'content-type': 'application/json' } }), 'POST', '/scanner/batches');
    expect(r.status).toBe(413); expect(r.json).toMatchObject({ code: 'body_too_large', limit_bytes: MAX_JSON_BODY_BYTES });
    expect(s.pulled()).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES + 128 * 1024);
  });
  test('naming route: streamed body over 400 KB with no Content-Length → 413 before parsing, namer not called', async () => {
    h = await setup();
    const { batch } = await batchWithDrawer(h);
    const s = stream(3 * MB);
    const r = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { raw: s.body, headers: { 'content-type': 'multipart/form-data; boundary=zzz' } });
    expect(r.status).toBe(413); expect(r.json).toMatchObject({ code: 'body_too_large', limit_bytes: ID_LIMITS.maxIdBodyBytes });
    expect(s.pulled()).toBeLessThanOrEqual(ID_LIMITS.maxIdBodyBytes + 128 * 1024);
    expect(h.recognizer.calls).toBe(0);
  });
  test('a body under the cap still works after being counted (re-buffered for the parsers)', async () => {
    h = await setup();
    const r = await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'U', note: 'x'.repeat(400) } });
    expect(r.status).toBe(201);
  });
});

describe('G2: atomic reservation before the recognizer, failed calls count, shared cap', () => {
  test('6 concurrent namings with a cap of 3 → exactly 3 recognizer calls', async () => {
    h = await setup({ perMinute: 3 });
    const { batch } = await batchWithDrawer(h);
    const rs = await Promise.all(Array.from({ length: 6 }, () => addCard(h!, batch.id)));
    const limited = rs.filter((r) => r.status === 429);
    expect(h.recognizer.calls).toBe(3);
    expect(limited.length).toBeGreaterThanOrEqual(3);
    for (const r of limited) expect(r.json.code).toBe('rate_limited');
    const rows = await h.db.prepare('SELECT COUNT(*) AS n FROM scan_identify_calls').first<{ n: number }>();
    expect(rows!.n).toBe(3);
  });
  test('failed recognizer calls still use up the cap', async () => {
    h = await setup({ perMinute: 2 });
    const { batch } = await batchWithDrawer(h);
    expect((await addCard(h, batch.id, 'error')).status).toBe(502);
    expect((await addCard(h, batch.id, 'timeout')).status).toBe(504);
    const r = await addCard(h, batch.id);
    expect(r.status).toBe(429); expect(r.json.limit).toBe('minute'); expect(h.recognizer.calls).toBe(2);
  });
  test('shared (all-sorters) hourly cap → 429 limit global_hourly with Retry-After', async () => {
    h = await setup({ globalPerHour: 2 });
    const a = await batchWithDrawer(h, 'sorterA'); const b = await batchWithDrawer(h, 'sorterB');
    expect((await addCard(h, a.batch.id)).status).toBe(201);
    expect((await addCard(h, b.batch.id, '', {}, 'sorterB')).status).toBe(201);
    const r = await addCard(h, b.batch.id, '', {}, 'sorterB');
    expect(r.status).toBe(429); expect(r.json.limit).toBe('global_hourly'); expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('G3: only our session cookie counts as a cookie credential', () => {
  test('edge access-gate cookies + API key → treated as a key call (works), on naming and other routes', async () => {
    h = await setup();
    const { batch } = await batchWithDrawer(h);
    expect((await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}), headers: { cookie: CF_ACCESS } })).status).toBe(201);
    expect((await h.call('sorterA', 'GET', '/scanner/me', { headers: { cookie: CF_ACCESS, origin: 'https://evil.example' } })).status).toBe(200);
    expect((await h.call('sorterA', 'PATCH', `/scanner/batches/${batch.id}`, { body: { note: 'x' }, headers: { cookie: CF_ACCESS, origin: 'https://evil.example' } })).status).toBe(200);
  });
  test('a cookie whose name only contains the session name is ignored', async () => {
    h = await setup();
    const r = await h.call('sorterA', 'GET', '/scanner/me', { headers: { cookie: `x${SESSION_COOKIE}=v; ${SESSION_COOKIE}x=v` } });
    expect(r.status).toBe(200);
  });
});

describe('G4: session cookie + API key is refused on every route', () => {
  test.each([
    ['GET', '/scanner/me'], ['GET', '/scanner/batches'], ['POST', '/scanner/batches'], ['GET', '/scanner/openapi.json'], ['GET', '/scanner/finds?type=held'],
  ])('%s %s → 400 ambiguous_credentials', async (method, path) => {
    h = await setup();
    const r = conforms(await h.call('admin', method, path, { body: method === 'POST' ? { condition: 'U' } : undefined, headers: { cookie: SESSION } }), method, path.split('?')[0]);
    expect(r.status).toBe(400); expect(r.json.code).toBe('ambiguous_credentials');
  });
});

describe('G5: cookie-auth writes must prove same-origin', () => {
  test('session cookie write with neither Origin nor Sec-Fetch-Site → 403 cross_origin_refused', async () => {
    h = await setup();
    const r = await h.call(null, 'POST', '/scanner/batches', { body: { condition: 'U' }, headers: { cookie: SESSION } });
    expect(r.status).toBe(403); expect(r.json.code).toBe('cross_origin_refused');
  });
  test('Sec-Fetch-Site: same-site (sibling subdomain) → 403', async () => {
    h = await setup();
    expect((await h.call(null, 'POST', '/scanner/batches', { body: { condition: 'U' }, headers: { cookie: SESSION, 'sec-fetch-site': 'same-site' } })).status).toBe(403);
  });
  test('same-origin proof passes the guard (then auth decides: 401 until A&S cookie auth exists)', async () => {
    h = await setup();
    for (const extra of [{ origin: 'http://localhost' }, { 'sec-fetch-site': 'same-origin' }] as Record<string, string>[]) {
      const r = await h.call(null, 'POST', '/scanner/batches', { body: { condition: 'U' }, headers: { cookie: SESSION, ...extra } });
      expect(r.status).toBe(401);
    }
  });
});

describe('G6 + Web Boss #2: shipped defaults are fail-closed, fakes only via test injection', () => {
  test('createApp() with nothing injected: every key is refused (401)', async () => {
    h = await setup({ defaults: true });
    for (const who of ['admin', 'sorterA'] as const) {
      const r = await h.call(who, 'GET', '/scanner/me', { host: 'localhost' });
      expect(r.status).toBe(401); expect(r.json.code).toBe('api_key_invalid');
    }
  });
  test('no recognizer injected → 503 recognizer_not_configured, nothing saved, no slot used, on any host', async () => {
    h = await setup({ defaultRecognizer: true });
    const { batch } = await batchWithDrawer(h);
    for (const host of [undefined, 'v2.example.test']) {
      const r = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}), host });
      expect(r.status).toBe(503); expect(r.json.code).toBe('recognizer_not_configured');
    }
    expect((await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}/cards`)).json.data).toHaveLength(0);
    expect((await h.db.prepare('SELECT COUNT(*) AS n FROM scan_identify_calls').first<{ n: number }>())!.n).toBe(0);
  });
  test('no local-test switch or test fakes in shipped source or in the Pages bundle', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk('src');
    const banned = /SCANNER_LOCAL_TEST|DEV_AUTH_TOKENS|FakeLocalVerifier|StubRecognizer|STUB:/;
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(banned);
    expect(readFileSync('pages-bundle/scanner.mjs', 'utf8')).not.toMatch(banned);
  });
});

describe('G7: sync payloads are allow-listed and use the route limits', () => {
  test('unknown payload keys and over-long notes are rejected; good events still land', async () => {
    h = await setup();
    const { batch } = await batchWithDrawer(h);
    const c = await addCard(h, batch.id);
    const r = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/events`, { body: { events: [
      { client_event_id: 'g7-extra-key-01', type: 'batch.noted', payload: { note: 'ok', smuggled: 'plain words '.repeat(300) } },
      { client_event_id: 'g7-long-note-01', type: 'batch.noted', payload: { note: 'x'.repeat(501) } },
      { client_event_id: 'g7-card-note-01', type: 'card.edited', payload: { card_id: c.json.id, field: 'note', to: 'y'.repeat(201) } },
      { client_event_id: 'g7-card-xtra-01', type: 'card.reopened', payload: { card_id: c.json.id, extra: 1 } },
      { client_event_id: 'g7-good-note-01', type: 'batch.noted', payload: { note: 'fine' } },
    ] } });
    expect(r.status).toBe(200);
    expect(Object.fromEntries(r.json.rejected.map((x: any) => [x.client_event_id, x.reason]))).toEqual({
      'g7-extra-key-01': 'unknown_payload_key', 'g7-long-note-01': 'bad_note', 'g7-card-note-01': 'bad_note', 'g7-card-xtra-01': 'unknown_payload_key' });
    expect(r.json.acks.map((x: any) => x.client_event_id)).toEqual(['g7-good-note-01']);
  });
});

describe('G8: events per batch are capped', () => {
  test('routes → 409 batch_event_limit (before any recognizer call); sync → rejected', async () => {
    h = await setup({ eventsPerBatch: 5 });
    const { batch } = await batchWithDrawer(h); // created, drawer, photo = 3 events
    expect((await addCard(h, batch.id)).status).toBe(201); // 4
    expect((await addCard(h, batch.id)).status).toBe(201); // 5
    const calls = h.recognizer.calls;
    const r = await addCard(h, batch.id);
    expect(r.status).toBe(409); expect(r.json).toMatchObject({ code: 'batch_event_limit', limit: 5 }); expect(h.recognizer.calls).toBe(calls);
    expect((await h.call('sorterA', 'PATCH', `/scanner/batches/${batch.id}`, { body: { note: 'x' } })).status).toBe(409);
    const s = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/events`, { body: { events: [{ client_event_id: 'g8-over-cap-01', type: 'batch.noted', payload: { note: 'x' } }] } });
    expect(s.json.rejected).toEqual([{ client_event_id: 'g8-over-cap-01', reason: 'batch_event_limit' }]);
  });
});

describe('Web Boss #3, #4 and M1b', () => {
  test('license MIT, esbuild pinned as a direct devDependency, third-party notices for the bundled packages', () => {
    const pj = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pj.license).toBe('MIT');
    expect(pj.devDependencies.esbuild).toMatch(/^\d+\.\d+\.\d+$/);
    const notices = readFileSync('pages-bundle/THIRD_PARTY_NOTICES.md', 'utf8');
    for (const name of ['hono', 'zod', '@hono/zod-openapi']) expect(notices).toContain(`## ${name} `);
  });
  test('no vendor or tool names in the public spec', () => {
    expect(JSON.stringify(SPEC)).not.toMatch(/bricqer|brickognize|bricklink|brickstore|cloudflare|better.?auth|wrangler|pts-v2/i);
  });
});
