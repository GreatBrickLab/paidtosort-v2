// Guarded behaviors (see LOCKED.md). Each test names the rule it locks.
import { ID_LIMITS } from '../src/scanner/limits';
import { SESSION_COOKIE } from '../src/platform/security';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type H, addCard, batchWithDrawer, cardForm, conforms, crop, setup } from './helpers/harness';

let h: H;
beforeEach(async () => { h = await setup(); });
afterEach(async () => { await h.close(); });
const T = '/scanner/batches/{batch_id}/cards';

describe('Finish', () => {
  test('LOCK finish-refused-while-undecided: 409 cards_undecided with count + first_card_id, nothing auto-dropped', async () => {
    const { batch } = await batchWithDrawer(h);
    const a = await addCard(h, batch.id); const b = await addCard(h, batch.id, 'low');
    await h.call('sorterA', 'POST', `/scanner/cards/${a.json.id}/decision`, { body: { state: 'approved' } });
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/finish`), 'POST', '/scanner/batches/{batch_id}/finish');
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'cards_undecided', count: 1, first_card_id: b.json.id });
    const after = await h.call('sorterA', 'GET', `/scanner/cards/${b.json.id}`);
    expect(after.json.state).toBe('check_by_hand');
    expect((await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}`)).json.status).toBe('open');
  });
  test('LOCK finish-no-cards: empty batch → 409 no_cards', async () => {
    const { batch } = await batchWithDrawer(h);
    const r = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/finish`);
    expect(r.status).toBe(409); expect(r.json.code).toBe('no_cards');
  });
  test('LOCK finished-batch-is-read-only: card writes → 409 batch_finished; rename allowed until processed', async () => {
    const { batch } = await batchWithDrawer(h);
    const a = await addCard(h, batch.id);
    await h.call('sorterA', 'POST', `/scanner/cards/${a.json.id}/decision`, { body: { state: 'approved' } });
    await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/finish`);
    expect((await h.call('sorterA', 'POST', `/scanner/cards/${a.json.id}/reopen`)).json.code).toBe('batch_finished');
    expect((await addCard(h, batch.id)).json.code).toBe('batch_finished');
    expect((await h.call('sorterA', 'PATCH', `/scanner/batches/${batch.id}`, { body: { name: 'renamed' } })).status).toBe(200);
    await h.call('admin', 'POST', `/scanner/batches/${batch.id}/processed`);
    expect((await h.call('sorterA', 'PATCH', `/scanner/batches/${batch.id}`, { body: { name: 'again' } })).json.code).toBe('batch_processed');
    expect((await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/reopen`)).json.code).toBe('batch_processed');
  });
  test('LOCK reopen-needs-no-other-open-batch', async () => {
    const { batch } = await batchWithDrawer(h);
    const a = await addCard(h, batch.id);
    await h.call('sorterA', 'POST', `/scanner/cards/${a.json.id}/decision`, { body: { state: 'dropped' } });
    await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/finish`);
    const b2 = await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'U' } });
    expect(b2.json.name).toMatch(/ B$/); // second batch the same day gets " B"
    const r = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/reopen`);
    expect(r.status).toBe(409); expect(r.json).toMatchObject({ code: 'open_batch_exists', batch_id: b2.json.id });
  });
});

describe('Idempotency (stored in D1 with the event rows)', () => {
  test('LOCK idempotent-retry: same key + same body → same result, one write, Idempotent-Replayed', async () => {
    const { batch } = await batchWithDrawer(h);
    const calls0 = h.recognizer.calls;
    const fd = () => cardForm({}, 'part=3001,score=0.9');
    const a = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: fd(), key: 'retry-key-0001' });
    const b = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: fd(), key: 'retry-key-0001' }), 'POST', T);
    expect(b.status).toBe(201); expect(b.json.id).toBe(a.json.id); expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect(h.recognizer.calls - calls0).toBe(1); // the namer is not called again on a retry
    expect((await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}/cards`)).json.data).toHaveLength(1);
  });
  test('LOCK idempotency-mismatch: same key + different body → 422', async () => {
    const { batch } = await batchWithDrawer(h);
    await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/drawers`, { body: { code: 'test-x1' }, key: 'mismatch-0001' });
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/drawers`, { body: { code: 'test-x2' }, key: 'mismatch-0001' }), 'POST', '/scanner/batches/{batch_id}/drawers');
    expect(r.status).toBe(422); expect(r.json.code).toBe('idempotency_mismatch');
  });
  test('LOCK idempotent-create-batch: retrying the create returns the same batch, not 409', async () => {
    const a = await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'U' }, key: 'create-0001' });
    const b = await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'U' }, key: 'create-0001' });
    expect(b.status).toBe(201); expect(b.json.id).toBe(a.json.id); expect(b.headers.get('idempotent-replayed')).toBe('true');
  });
  test('LOCK idempotency-key-required on every write: 400 idempotency_key_missing', async () => {
    const r = conforms(await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'U' }, key: null }), 'POST', '/scanner/batches');
    expect(r.status).toBe(400); expect(r.json.code).toBe('idempotency_key_missing');
  });
  test('LOCK outbox-replay: a resent event is acked with its first seq, never written twice', async () => {
    const { batch } = await batchWithDrawer(h);
    const c = await addCard(h, batch.id);
    const body = { events: [{ client_event_id: 'outbox-0001-aa', type: 'card.decided', payload: { card_id: c.json.id, state: 'dropped' } }] };
    const a = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/events`, { body });
    const b = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/events`, { body });
    expect(b.json.acks[0]).toEqual({ client_event_id: 'outbox-0001-aa', seq: a.json.acks[0].seq, replayed: true });
    expect(b.json.last_seq).toBe(a.json.last_seq);
  });
  test('LOCK outbox-validates-like-the-routes: a not-allowed decision is rejected', async () => {
    const { batch } = await batchWithDrawer(h);
    const c = await addCard(h, batch.id, 'none');
    const r = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/events`, { body: { events: [{ client_event_id: 'outbox-0002-aa', type: 'card.decided', payload: { card_id: c.json.id, state: 'approved' } }] } });
    expect(r.json.rejected[0].reason).toBe('decision_not_allowed');
  });
});

describe('Drawers', () => {
  test('LOCK drawers-case-insensitive-shown-upper: test-a1, TEST-A1 and " Test-A1 " are one drawer', async () => {
    const { batch } = await batchWithDrawer(h); // opened as "test-a1"
    for (const code of ['TEST-A1', ' Test-A1 ']) {
      const r = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/drawers`, { body: { code } });
      expect(r.status).toBe(200); expect(r.json.code).toBe('TEST-A1');
    }
    expect((await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}/drawers`)).json.data).toHaveLength(1);
    await addCard(h, batch.id);
    expect((await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}/cards?drawer=test-A1`)).json.data).toHaveLength(1);
    const bad = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/drawers`, { body: { code: '***' } });
    expect(bad.status).toBe(400); expect(bad.json.code).toBe('invalid_request');
  });
  test('LOCK label-first: no photos or cards before a drawer is open (409 no_drawer_open)', async () => {
    const b = await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'U' } });
    expect((await h.call('sorterA', 'POST', `/scanner/batches/${b.json.id}/photos`, { body: { boxes: 1 } })).json.code).toBe('no_drawer_open');
    const c = await addCard(h, b.json.id);
    expect(c.json.code).toBe('no_drawer_open'); expect(h.recognizer.calls).toBe(0);
  });
});

describe('Naming (server side, stub recognizer)', () => {
  test('LOCK check-by-hand-below-0.70: no pre-pick, Approve blocked until a pick', async () => {
    const { batch } = await batchWithDrawer(h);
    const r = await addCard(h, batch.id, 'low');
    expect(r.json).toMatchObject({ state: 'check_by_hand', chosen: null, allowed_decisions: ['dropped', 'unknown'] });
    const close = await addCard(h, batch.id, 'close');
    expect(close.json.state).toBe('check_by_hand'); // top two within 0.05
    const picked = await h.call('sorterA', 'PATCH', `/scanner/cards/${r.json.id}`, { body: { pick: 1 } });
    expect(picked.json).toMatchObject({ state: 'pending', chosen: { part_no: '3005' } });
  });
  test('LOCK id-service-429-is-a-real-error: 429 + Retry-After + card_id; card saved as error', async () => {
    const { batch } = await batchWithDrawer(h);
    const r = conforms(await addCard(h, batch.id, 'busy=42'), 'POST', T);
    expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('42');
    expect(r.json).toMatchObject({ code: 'id_service_busy', retry_after_s: 42 });
    const card = await h.call('sorterA', 'GET', `/scanner/cards/${r.json.card_id}`);
    expect(card.json).toMatchObject({ state: 'error', identify: { status: 'error', error_code: 'id_service_busy' }, allowed_decisions: ['dropped', 'unknown'] });
  });
  test('LOCK id-service-502-504-are-real-errors, never "no match"', async () => {
    const { batch } = await batchWithDrawer(h);
    const a = conforms(await addCard(h, batch.id, 'error'), 'POST', T);
    expect(a.status).toBe(502); expect(a.json.code).toBe('id_service_error');
    const b = conforms(await addCard(h, batch.id, 'timeout'), 'POST', T);
    expect(b.status).toBe(504); expect(b.json.code).toBe('id_service_timeout');
    const card = await h.call('sorterA', 'GET', `/scanner/cards/${b.json.card_id}`);
    expect(card.json.state).toBe('error'); expect(card.json.state).not.toBe('no_match');
    const again = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}, 'timeout'), key: 'k-same-0001' });
    const replay = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}, 'timeout'), key: 'k-same-0001' });
    expect(replay.status).toBe(again.status); expect(replay.json.card_id).toBe(again.json.card_id);
  });
  test('LOCK retry-only-for-errors: 409 retry_not_needed on a named card', async () => {
    const { batch } = await batchWithDrawer(h);
    const c = await addCard(h, batch.id);
    const r = await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/identify`, { form: crop() });
    expect(r.status).toBe(409); expect(r.json.code).toBe('retry_not_needed');
  });
  test('LOCK own-hourly-cap: over the cap → 429 rate_limited, no card made, namer not called', async () => {
    await h.close(); h = await setup({ limit: 2 });
    const { batch } = await batchWithDrawer(h);
    await addCard(h, batch.id); await addCard(h, batch.id);
    const r = conforms(await addCard(h, batch.id), 'POST', T);
    expect(r.status).toBe(429); expect(r.json).toMatchObject({ code: 'rate_limited', limit: 'hourly' }); expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(h.recognizer.calls).toBe(2);
    expect((await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}/cards`)).json.data).toHaveLength(2);
  });
  test('LOCK per-caller-rate-limit-hook: a denying hook blocks naming before the namer is called', async () => {
    await h.close(); h = await setup({ rateLimit: { async check() { return { ok: false, retry_after_s: 7 }; } } });
    const { batch } = await batchWithDrawer(h);
    const r = await addCard(h, batch.id);
    expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('7'); expect(h.recognizer.calls).toBe(0);
  });
  describe('A&S ID-route rules (12:01 PM CT)', () => {
    const ID = (b: string) => `/scanner/batches/${b}/cards`;
    test('LOCK id-auth-required: no credentials → 401 problem+json, namer not called', async () => {
      const { batch } = await batchWithDrawer(h); const before = h.recognizer.calls;
      for (const path of [ID(batch.id), `/scanner/cards/crd_doesnotexist0000/identify`]) {
        const r = await h.call(null, 'POST', path, { form: cardForm({}) });
        expect(r.status).toBe(401); expect(r.headers.get('content-type')).toBe('application/problem+json');
      }
      expect(h.recognizer.calls).toBe(before);
    });
    test('LOCK id-one-credential: cookie AND API key together → 400 ambiguous_credentials, namer not called', async () => {
      const { batch } = await batchWithDrawer(h); const before = h.recognizer.calls;
      const r = conforms(await h.call('sorterA', 'POST', ID(batch.id), { form: cardForm({}), headers: { cookie: `${SESSION_COOKIE}=sess-test-value` } }), 'POST', T);
      expect(r.status).toBe(400); expect(r.json.code).toBe('ambiguous_credentials'); expect(h.recognizer.calls).toBe(before);
      const c = await addCard(h, batch.id);
      const r2 = await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/identify`, { form: crop(), headers: { cookie: `${SESSION_COOKIE}=sess-test-value` } });
      expect(r2.status).toBe(400); expect(r2.json.code).toBe('ambiguous_credentials');
    });
    test('LOCK id-per-minute-cap: over the per-minute cap → 429 rate_limited limit=minute + Retry-After ≤ 60', async () => {
      await h.close(); h = await setup({ perMinute: 3 });
      const { batch } = await batchWithDrawer(h);
      for (let i = 0; i < 3; i++) expect((await addCard(h, batch.id)).status).toBe(201);
      const r = conforms(await addCard(h, batch.id), 'POST', T);
      expect(r.status).toBe(429); expect(r.json).toMatchObject({ code: 'rate_limited', limit: 'minute' });
      const ra = Number(r.headers.get('retry-after')); expect(ra).toBeGreaterThan(0); expect(ra).toBeLessThanOrEqual(60);
      expect(h.recognizer.calls).toBe(3);
      // another caller is not affected
      const other = await batchWithDrawer(h, 'sorterB');
      expect((await addCard(h, other.batch.id, '', {}, 'sorterB')).status).toBe(201);
    });
    test('LOCK id-body-cap: request body over the ID cap → 413 body_too_large before parsing', async () => {
      const { batch } = await batchWithDrawer(h); const before = h.recognizer.calls;
      const r = conforms(await h.call('sorterA', 'POST', ID(batch.id), { form: cardForm({}), headers: { 'content-length': String(ID_LIMITS.maxIdBodyBytes + 1) } }), 'POST', T);
      expect(r.status).toBe(413); expect(r.json.code).toBe('body_too_large'); expect(h.recognizer.calls).toBe(before);
    });
    test('LOCK id-one-crop-per-request: two crops → 400 too_many_crops, nothing saved', async () => {
      const { batch } = await batchWithDrawer(h); const before = h.recognizer.calls;
      const fd = cardForm({}); fd.append('crop2', new File([new Uint8Array(10)], 'b.jpg', { type: 'image/jpeg' }));
      const r = conforms(await h.call('sorterA', 'POST', ID(batch.id), { form: fd }), 'POST', T);
      expect(r.status).toBe(400); expect(r.json).toMatchObject({ code: 'too_many_crops', limit: ID_LIMITS.maxCropsPerRequest });
      const fd2 = cardForm({}); fd2.append('crop', new File([new Uint8Array(10)], 'c.jpg', { type: 'image/jpeg' }));
      expect((await h.call('sorterA', 'POST', ID(batch.id), { form: fd2 })).json.code).toBe('too_many_crops');
      expect(h.recognizer.calls).toBe(before);
      expect((await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}/cards`)).json.data).toHaveLength(0);
    });
  });
  test('LOCK crop-max-300KB: bigger → 413 crop_too_large, namer not called', async () => {
    const { batch } = await batchWithDrawer(h);
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}, '', 300 * 1024 + 1) }), 'POST', T);
    expect(r.status).toBe(413); expect(r.json.code).toBe('crop_too_large'); expect(h.recognizer.calls).toBe(0);
  });
  test('LOCK photos-never-stored: no event or summary holds image bytes', async () => {
    const { batch } = await batchWithDrawer(h);
    await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}, 'part=3001') });
    const rows = await h.db.prepare('SELECT payload_json FROM scan_events').all<{ payload_json: string }>();
    for (const r of rows.results) expect(r.payload_json).not.toMatch(/STUB:|jpegbytes|base64|data:image/);
    const tables = await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'scan%'").all<{ name: string }>();
    expect(tables.results.map((t) => t.name).sort()).toEqual(['scan_batches', 'scan_events', 'scan_identify_calls']); // no key, photo or file tables (the rate table holds user id, time, request id only)
  });
});

describe('Cards', () => {
  test('LOCK drop-then-undo restores the card', async () => {
    const { batch } = await batchWithDrawer(h);
    const c = await addCard(h, batch.id);
    await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/decision`, { body: { state: 'dropped' } });
    const u = await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/reopen`);
    expect(u.json.state).toBe('pending');
  });
  test('LOCK top-3-colors-valid-only: colors list ≤3 from the part’s colors; invalid color refused; corrections logged', async () => {
    const { batch } = await batchWithDrawer(h);
    const c = await addCard(h, batch.id, 'part=3001,score=0.9');
    expect(c.json.colors.map((x: any) => x.color_id)).toEqual([5, 11, 1]);
    expect((await h.call('sorterA', 'PATCH', `/scanner/cards/${c.json.id}`, { body: { color_id: 3 } })).status).toBe(400);
    await h.call('sorterA', 'PATCH', `/scanner/cards/${c.json.id}`, { body: { color_id: 7 } }); // "More colors"
    const ev = await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}/events`);
    expect(ev.json.data.find((e: any) => e.type === 'card.edited').payload).toMatchObject({ field: 'color_id', to: 7 });
  });
  test('LOCK alternate-part-numbers-map-to-main', async () => {
    const { batch } = await batchWithDrawer(h);
    const c = await addCard(h, batch.id, 'none');
    const r = await h.call('sorterA', 'PATCH', `/scanner/cards/${c.json.id}`, { body: { part_no: '3794' } });
    expect(r.json).toMatchObject({ state: 'pending', chosen: { part_no: '15573' } });
    expect(r.json.badges).toContain('check_mold');
  });
  test('LOCK same-part-color-drawer-merges-into-one-lot', async () => {
    const { batch } = await batchWithDrawer(h);
    const a = await addCard(h, batch.id); const b = await addCard(h, batch.id);
    await h.call('sorterA', 'POST', `/scanner/cards/${a.json.id}/decision`, { body: { state: 'approved' } });
    const bb = await h.call('sorterA', 'GET', `/scanner/cards/${b.json.id}`);
    expect(bb.json.merges_into).toBe(a.json.id);
    await h.call('sorterA', 'POST', `/scanner/cards/${b.json.id}/decision`, { body: { state: 'approved' } });
    expect((await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}`)).json.counts).toMatchObject({ lots: 1, parts: 2 });
  });
  test('LOCK values: batch value in cents for everyone; per-part value only when asked', async () => {
    const { batch } = await batchWithDrawer(h);
    const c = await addCard(h, batch.id, 'part=15573');
    await h.call('sorterA', 'PATCH', `/scanner/cards/${c.json.id}`, { body: { qty: 2 } });
    await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/decision`, { body: { state: 'approved' } });
    const b = await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}`);
    expect(b.json).toMatchObject({ estimated_value_cents: 240, currency: 'USD' });
    expect((await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}/cards`)).json.data[0]).not.toHaveProperty('value_cents');
    expect((await h.call('sorterA', 'GET', `/scanner/batches/${batch.id}/cards?include[]=values`)).json.data[0]).toMatchObject({ value_cents: 120 });
    expect(c.json.badges).toContain('rare_1');
  });
  test('LOCK hold-and-part-out-only-for-minifigs', async () => {
    const { batch } = await batchWithDrawer(h);
    const c = await addCard(h, batch.id);
    expect((await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/hold`, { body: { reason: 'other' } })).json.code).toBe('not_a_minifig');
    expect((await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/part-out`, { body: {} })).json.code).toBe('not_a_minifig');
  });
});

describe('Export', () => {
  async function finishedMixed() {
    const { batch } = await batchWithDrawer(h);
    const keep = await addCard(h, batch.id, 'part=3001,score=0.9');
    const drop = await addCard(h, batch.id, 'part=3023,score=0.9');
    const pwn = await addCard(h, batch.id, 'part=3005,score=0.9');
    const unk = await addCard(h, batch.id, 'none');
    const fig = await addCard(h, batch.id, 'fig');
    const fig2 = await addCard(h, batch.id, 'fig');
    await h.call('sorterA', 'POST', `/scanner/cards/${keep.json.id}/decision`, { body: { state: 'approved' } });
    await h.call('sorterA', 'POST', `/scanner/cards/${drop.json.id}/decision`, { body: { state: 'dropped' } });
    await h.call('sorterA', 'PATCH', `/scanner/cards/${pwn.json.id}`, { body: { color_id: 3 } });
    await h.call('sorterA', 'POST', `/scanner/cards/${pwn.json.id}/decision`, { body: { state: 'set_aside' } });
    await h.call('sorterA', 'POST', `/scanner/cards/${unk.json.id}/decision`, { body: { state: 'unknown' } });
    await h.call('sorterA', 'POST', `/scanner/cards/${fig.json.id}/hold`, { body: { reason: 'missing_piece' } });
    await h.call('sorterA', 'POST', `/scanner/cards/${fig2.json.id}/decision`, { body: { state: 'approved' } }); // keep as fig
    expect((await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/finish`)).status).toBe(200);
    return batch.id;
  }
  test('LOCK export-excludes-parts-we-need-and-everything-not-approved', async () => {
    const id = await finishedMixed();
    const ex = await h.call('admin', 'POST', `/scanner/batches/${id}/exports`, { body: { format: 'json' } });
    expect(ex.json.lots).toBe(2);
    const file = await h.call('admin', 'GET', `/scanner/exports/${ex.json.id}/file`);
    expect(file.json.lots.map((l: any) => l.part_no).sort()).toEqual(['3001', 'cty0001']);
    const bsx = await h.call('admin', 'GET', `/scanner/exports/${(await h.call('admin', 'POST', `/scanner/batches/${id}/exports`, { body: { format: 'bsx' } })).json.id}/file`);
    expect(bsx.text).not.toContain('<ItemID>3005</ItemID>'); expect(bsx.text).not.toContain('<ItemID>3023</ItemID>');
  });
  test('LOCK export-admin-only and only when finished', async () => {
    const { batch } = await batchWithDrawer(h);
    expect((await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/exports`, { body: { format: 'bsx' } })).status).toBe(403);
    const r = await h.call('admin', 'POST', `/scanner/batches/${batch.id}/exports`, { body: { format: 'bsx' } });
    expect(r.status).toBe(409); expect(r.json.code).toBe('not_finished');
    const p = await h.call('admin', 'POST', `/scanner/batches/${batch.id}/processed`);
    expect(p.status).toBe(409); expect(p.json.code).toBe('not_finished');
  });
  test('LOCK export-file-is-frozen-at-its-seq: later changes never alter an earlier export', async () => {
    const id = await finishedMixed();
    const ex = await h.call('admin', 'POST', `/scanner/batches/${id}/exports`, { body: { format: 'csv' } });
    const before = (await h.call('admin', 'GET', `/scanner/exports/${ex.json.id}/file`)).text;
    await h.call('sorterA', 'POST', `/scanner/batches/${id}/reopen`);
    const c = await addCard(h, id, 'part=3024,score=0.9');
    await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/decision`, { body: { state: 'approved' } });
    await h.call('sorterA', 'POST', `/scanner/batches/${id}/finish`);
    expect((await h.call('admin', 'GET', `/scanner/exports/${ex.json.id}/file`)).text).toBe(before);
  });
});
