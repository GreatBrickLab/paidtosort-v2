// Every route, end to end, with every answer checked against contract/openapi.json. The last test asserts that every
// operation in the contract was exercised with its success status in this file.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SPEC, type H, addCard, batchWithDrawer, cardForm, conforms, covered, crop, setup } from './helpers/harness';

let h: H;
beforeAll(async () => { h = await setup({ now: () => new Date('2026-11-24T17:31:00Z') }); });
afterAll(async () => { await h.close(); });

const ids: Record<string, string> = {};

describe('sorter flow', () => {
  test('me', async () => {
    const r = conforms(await h.call('sorterA', 'GET', '/scanner/me'), 'GET', '/scanner/me');
    expect(r.json).toMatchObject({ object: 'me', user: { id: 'usr_sam_test', role: 'sorter' }, key: { mode: 'test' } });
  });
  test('create batch: server-made name, bat_ id, cents + currency', async () => {
    const r = conforms(await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'U', note: 'Smith lot' } }), 'POST', '/scanner/batches');
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^bat_/);
    expect(r.json.name).toBe('Sam 11-24-26');
    expect(r.json).toMatchObject({ status: 'open', condition: 'U', note: 'Smith lot', estimated_value_cents: 0, currency: 'USD' });
    ids.batch = r.json.id;
  });
  test('second open batch is refused with the open batch id', async () => {
    const r = conforms(await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'N' } }), 'POST', '/scanner/batches');
    expect(r.status).toBe(409);
    expect(r.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect(r.json).toMatchObject({ code: 'open_batch_exists', batch_id: ids.batch, status: 409 });
    expect(r.json.request_id).toBe(r.headers.get('x-request-id'));
  });
  test('rename + note', async () => {
    const r = conforms(await h.call('sorterA', 'PATCH', `/scanner/batches/${ids.batch}`, { body: { name: 'Sam 11-24-26 shelf 3' } }), 'PATCH', '/scanner/batches/{batch_id}');
    expect(r.json.name).toBe('Sam 11-24-26 shelf 3');
  });
  test('open drawer (any case → UPPER), reopen same drawer is 200', async () => {
    const a = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${ids.batch}/drawers`, { body: { code: ' test-a1 ' } }), 'POST', '/scanner/batches/{batch_id}/drawers');
    expect(a.status).toBe(201); expect(a.json).toMatchObject({ code: 'TEST-A1', is_current: true });
    const b = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${ids.batch}/drawers`, { body: { code: 'test-b2' } }), 'POST', '/scanner/batches/{batch_id}/drawers');
    expect(b.status).toBe(201);
    const c = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${ids.batch}/drawers`, { body: { code: 'TEST-A1' } }), 'POST', '/scanner/batches/{batch_id}/drawers');
    expect(c.status).toBe(200); expect(c.json.is_current).toBe(true);
  });
  test('list drawers', async () => {
    const r = conforms(await h.call('sorterA', 'GET', `/scanner/batches/${ids.batch}/drawers`), 'GET', '/scanner/batches/{batch_id}/drawers');
    expect(r.json.data.map((d: any) => d.code)).toEqual(['TEST-A1', 'TEST-B2']);
  });
  test('record photo (counts only)', async () => {
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${ids.batch}/photos`, { body: { boxes: 5 } }), 'POST', '/scanner/batches/{batch_id}/photos');
    expect(r.json).toMatchObject({ number: 1, drawer_code: 'TEST-A1', boxes: 5 }); ids.photo = r.json.id;
  });
  test('create card from a crop: named on the server, Photo 1 · box 4', async () => {
    const r = conforms(await addCard(h, ids.batch, '', { photo_id: ids.photo, box: 4 }), 'POST', '/scanner/batches/{batch_id}/cards');
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ state: 'pending', photo_number: 1, box: 4, drawer_code: 'TEST-A1', chosen: { part_no: '3023' }, color_id: 11, allowed_decisions: ['approved', 'dropped', 'set_aside', 'unknown'] });
    expect(r.json.colors.length).toBeLessThanOrEqual(3);
    expect(r.json).not.toHaveProperty('value_cents'); // per-part values are opt-in
    ids.card = r.json.id;
  });
  test('get card, with values opt-in', async () => {
    const a = conforms(await h.call('sorterA', 'GET', `/scanner/cards/${ids.card}`), 'GET', '/scanner/cards/{card_id}');
    expect(a.json).not.toHaveProperty('value_cents');
    const b = conforms(await h.call('sorterA', 'GET', `/scanner/cards/${ids.card}?include[]=values`), 'GET', '/scanner/cards/{card_id}');
    expect(b.json).toMatchObject({ value_cents: 4, currency: 'USD' });
  });
  test('update card: qty, color from the valid list, note', async () => {
    const r = conforms(await h.call('sorterA', 'PATCH', `/scanner/cards/${ids.card}`, { body: { qty: 3, color_id: 86, note: 'scuffed' } }), 'PATCH', '/scanner/cards/{card_id}');
    expect(r.json).toMatchObject({ qty: 3, color_id: 86, note: 'scuffed' });
    expect(r.json.badges).not.toContain('check_color');
    const bad = conforms(await h.call('sorterA', 'PATCH', `/scanner/cards/${ids.card}`, { body: { color_id: 5 } }), 'PATCH', '/scanner/cards/{card_id}');
    expect(bad.status).toBe(400); expect(bad.json.code).toBe('invalid_request');
  });
  test('approve', async () => {
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/cards/${ids.card}/decision`, { body: { state: 'approved' } }), 'POST', '/scanner/cards/{card_id}/decision');
    expect(r.json.state).toBe('approved');
  });
  test('drop + undo (reopen)', async () => {
    const c = await addCard(h, ids.batch, 'part=3001,score=0.9');
    await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/decision`, { body: { state: 'dropped' } });
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/reopen`), 'POST', '/scanner/cards/{card_id}/reopen');
    expect(r.json.state).toBe('pending');
    await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/decision`, { body: { state: 'approved' } });
  });
  test('recognizer error → real error, card saved, retry works', async () => {
    const r = conforms(await addCard(h, ids.batch, 'error'), 'POST', '/scanner/batches/{batch_id}/cards');
    expect(r.status).toBe(502); expect(r.json.code).toBe('id_service_error');
    const retry = conforms(await h.call('sorterA', 'POST', `/scanner/cards/${r.json.card_id}/identify`, { form: crop('part=3005,score=0.97') }), 'POST', '/scanner/cards/{card_id}/identify');
    expect(retry.status).toBe(200); expect(retry.json.state).toBe('pending');
    ids.wanted = retry.json.id; // 3005 in Yellow is a Parts We Need part in the fixture
  });
  test('Parts We Need find: only Set aside', async () => {
    const plain = conforms(await h.call('sorterA', 'GET', `/scanner/cards/${ids.wanted}`), 'GET', '/scanner/cards/{card_id}');
    expect(plain.json.badges).not.toContain('parts_we_need'); // White 1x1 is not wanted
    const c = await h.call('sorterA', 'PATCH', `/scanner/cards/${ids.wanted}`, { body: { color_id: 3 } }); // Yellow is
    expect(c.json.badges).toContain('parts_we_need'); expect(c.json.allowed_decisions).toEqual(['set_aside']);
    const no = conforms(await h.call('sorterA', 'POST', `/scanner/cards/${ids.wanted}/decision`, { body: { state: 'approved' } }), 'POST', '/scanner/cards/{card_id}/decision');
    expect(no.status).toBe(409); expect(no.json.code).toBe('decision_not_allowed');
    const ok = await h.call('sorterA', 'POST', `/scanner/cards/${ids.wanted}/decision`, { body: { state: 'set_aside' } });
    expect(ok.json.state).toBe('set_aside');
  });
  test('minifig: part out → pieces right under the fig', async () => {
    const fig = await addCard(h, ids.batch, 'fig');
    expect(fig.json).toMatchObject({ item_type: 'M', minifig: { fig_value_cents: 450, part_out_value_cents: 830, currency: 'USD', suggestion: 'part_out' } });
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/cards/${fig.json.id}/part-out`, { body: {} }), 'POST', '/scanner/cards/{card_id}/part-out');
    expect(r.status).toBe(201); expect(r.json.fig.state).toBe('parted_out'); expect(r.json.pieces).toHaveLength(3);
    for (const p of r.json.pieces) { expect(p.parent_card_id).toBe(fig.json.id); await h.call('sorterA', 'POST', `/scanner/cards/${p.id}/decision`, { body: { state: 'approved' } }); }
    const list = await h.call('sorterA', 'GET', `/scanner/batches/${ids.batch}/cards`);
    const order = list.json.data.map((c: any) => c.id);
    expect(order.indexOf(r.json.pieces[0].id)).toBe(order.indexOf(fig.json.id) + 1);
  });
  test('minifig: hold (missing piece) → held, admin list', async () => {
    const fig = await addCard(h, ids.batch, 'fig');
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/cards/${fig.json.id}/hold`, { body: { reason: 'missing_piece' } }), 'POST', '/scanner/cards/{card_id}/hold');
    expect(r.json).toMatchObject({ state: 'set_aside', held: true, hold_reason: 'missing_piece' });
  });
  test('unknown → need help', async () => {
    const c = await addCard(h, ids.batch, 'none');
    expect(c.json.state).toBe('no_match'); expect(c.json.allowed_decisions).toEqual(['dropped', 'unknown']);
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/need-help`, { body: { text: "Can't find this one" } }), 'POST', '/scanner/cards/{card_id}/need-help');
    expect(r.json).toMatchObject({ state: 'unknown', help_text: "Can't find this one" });
  });
  test('list cards with filters (drawer any case) and paging', async () => {
    const r = conforms(await h.call('sorterA', 'GET', `/scanner/batches/${ids.batch}/cards?drawer=test-a1&limit=2`), 'GET', '/scanner/batches/{batch_id}/cards');
    expect(r.json.data).toHaveLength(2); expect(r.json.has_more).toBe(true);
    const r2 = conforms(await h.call('sorterA', 'GET', `/scanner/batches/${ids.batch}/cards?drawer=TEST-A1&limit=2&cursor=${r.json.next_cursor}`), 'GET', '/scanner/batches/{batch_id}/cards');
    expect(r2.json.data[0].id).not.toBe(r.json.data[0].id);
  });
  test('get batch with expand', async () => {
    const r = conforms(await h.call('sorterA', 'GET', `/scanner/batches/${ids.batch}?expand[]=drawers&expand[]=cards`), 'GET', '/scanner/batches/{batch_id}');
    expect(r.json.drawers).toHaveLength(2); expect(r.json.cards.length).toBeGreaterThan(5);
    expect(r.json.counts.undecided).toBe(0);
    expect(r.json.estimated_value_cents).toBeGreaterThan(0);
  });
  test('events: list and offline outbox append', async () => {
    const card = await addCard(h, ids.batch, 'part=3001,score=0.9');
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${ids.batch}/events`, { body: { events: [
      { client_event_id: 'dev1-0001-aaaa', type: 'card.edited', device_id: 'dev_ph1', payload: { card_id: card.json.id, field: 'qty', to: 2 } },
      { client_event_id: 'dev1-0002-aaaa', type: 'card.decided', payload: { card_id: card.json.id, state: 'approved' } },
      { client_event_id: 'dev1-0003-aaaa', type: 'batch.finished', payload: {} },
    ] } }), 'POST', '/scanner/batches/{batch_id}/events');
    expect(r.json.acks.map((a: any) => a.replayed)).toEqual([false, false]);
    expect(r.json.rejected).toEqual([{ client_event_id: 'dev1-0003-aaaa', reason: 'route_only' }]);
    const l = conforms(await h.call('sorterA', 'GET', `/scanner/batches/${ids.batch}/events?after_seq=${r.json.last_seq - 2}`), 'GET', '/scanner/batches/{batch_id}/events');
    expect(l.json.data.map((e: any) => e.type)).toEqual(['card.edited', 'card.decided']);
    expect(l.json.data[0]).not.toHaveProperty('payload.request_hash');
    expect(l.json.data[0].key_id).toMatch(/^key_/); // audit: which key did it
  });
  test('list batches (mine)', async () => {
    const r = conforms(await h.call('sorterA', 'GET', '/scanner/batches'), 'GET', '/scanner/batches');
    expect(r.json.data.map((b: any) => b.id)).toEqual([ids.batch]);
  });
  test('finish → summary', async () => {
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${ids.batch}/finish`), 'POST', '/scanner/batches/{batch_id}/finish');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ object: 'finish_summary', held_figs: 1, currency: 'USD', batch: { status: 'finished' } });
  });
  test('reopen own finished batch, then finish again', async () => {
    const r = conforms(await h.call('sorterA', 'POST', `/scanner/batches/${ids.batch}/reopen`), 'POST', '/scanner/batches/{batch_id}/reopen');
    expect(r.json.status).toBe('open');
    expect((await h.call('sorterA', 'POST', `/scanner/batches/${ids.batch}/finish`)).status).toBe(200);
  });
});

describe('admin flow', () => {
  test('all batches + finds lists', async () => {
    const r = conforms(await h.call('admin', 'GET', '/scanner/batches?owner=all&status=finished'), 'GET', '/scanner/batches');
    expect(r.json.data.map((b: any) => b.id)).toContain(ids.batch);
    const held = conforms(await h.call('admin', 'GET', '/scanner/finds?type=held'), 'GET', '/scanner/finds');
    expect(held.json.data).toHaveLength(1);
    const pwn = conforms(await h.call('admin', 'GET', '/scanner/finds?type=parts_we_need'), 'GET', '/scanner/finds');
    expect(pwn.json.data[0]).toMatchObject({ part_no: '3005', color_id: 3, drawer_code: 'TEST-A1' });
  });
  test('export → get → download (bsx, csv, json)', async () => {
    for (const format of ['bsx', 'csv', 'json'] as const) {
      const r = conforms(await h.call('admin', 'POST', `/scanner/batches/${ids.batch}/exports`, { body: { format } }), 'POST', '/scanner/batches/{batch_id}/exports');
      expect(r.status).toBe(201); expect(r.json.file_name).toMatch(new RegExp(`^scan-sam-11-24-26-shelf-3-20261124-1131\\.${format}$`));
      const g = conforms(await h.call('admin', 'GET', `/scanner/exports/${r.json.id}`), 'GET', '/scanner/exports/{export_id}');
      expect(g.json.id).toBe(r.json.id);
      const f = conforms(await h.call('admin', 'GET', `/scanner/exports/${r.json.id}/file`), 'GET', '/scanner/exports/{export_id}/file');
      expect(f.headers.get('content-disposition')).toContain(r.json.file_name);
      ids[`exp_${format}`] = r.json.id;
    }
  });
  test('a second export the same minute never overwrites the file name', async () => {
    const r = await h.call('admin', 'POST', `/scanner/batches/${ids.batch}/exports`, { body: { format: 'bsx' } });
    expect(r.json.file_name).toMatch(/-1131-2\.bsx$/);
  });
  test('mark processed', async () => {
    const r = conforms(await h.call('admin', 'POST', `/scanner/batches/${ids.batch}/processed`), 'POST', '/scanner/batches/{batch_id}/processed');
    expect(r.json.status).toBe('processed'); expect(r.json.processed_at).toBeTruthy();
  });
  test('openapi.json is served from the generated contract', async () => {
    const r = conforms(await h.call('sorterA', 'GET', '/scanner/openapi.json'), 'GET', '/scanner/openapi.json');
    expect(r.json.info.version).toBe(SPEC.info.version);
  });
});

test('every operation in the contract was exercised with a success status', () => {
  const missing: string[] = [];
  for (const [, item] of Object.entries<any>(SPEC.paths)) for (const [, op] of Object.entries<any>(item)) {
    const ok = Object.keys(op.responses).filter((s) => s.startsWith('2'));
    if (!ok.some((s) => covered.has(`${op.operationId} ${s}`))) missing.push(op.operationId);
  }
  expect(missing).toEqual([]);
});
