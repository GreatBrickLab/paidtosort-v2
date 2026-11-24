// A&S follow-ups (review of PR #1, Nov 24 2026): key length, constraint failures, concurrent writes, schema, rate-row and batch cleanup.
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError } from '../src/platform/problem';
import { KEY_MAX } from '../src/scanner/limits';
import { Conflict, Store, classifyDbError } from '../src/scanner/store';
import { type H, batchWithDrawer, cardForm, setup } from './helpers/harness';

let h: H;
afterEach(async () => { await h?.close(); h = undefined as unknown as H; });
const key = (n: number) => `k${'a'.repeat(n - 1)}`;
const count = async (sql: string, ...b: unknown[]) => (await h.db.prepare(sql).bind(...b).first<{ n: number }>())!.n;

describe('1. key length agrees with the schema', () => {
  test('a 128-char Idempotency-Key works on create batch, open drawer, a 2-event write and sync; 129 is a 400 on each', async () => {
    h = await setup();
    expect(KEY_MAX).toBe(128);
    const b = await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'U' }, key: key(128) });
    expect(b.status, b.text).toBe(201);
    expect((await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'U' }, key: key(129) })).status).toBe(400);
    const d = await h.call('sorterA', 'POST', `/scanner/batches/${b.json.id}/drawers`, { body: { code: 'test-a1' }, key: `d${'b'.repeat(127)}` });
    expect(d.status, d.text).toBe(201);
    const d2 = await h.call('sorterA', 'POST', `/scanner/batches/${b.json.id}/drawers`, { body: { code: 'test-a2' }, key: `d${'c'.repeat(128)}` });
    expect(d2.status).toBe(400);
    // rename + note in one PATCH = two events; the second gets a derived id that stays short
    const p = await h.call('sorterA', 'PATCH', `/scanner/batches/${b.json.id}`, { body: { name: 'Renamed', note: 'two events' }, key: `p${'d'.repeat(127)}` });
    expect(p.status, p.text).toBe(200);
    const ids = (await h.db.prepare('SELECT client_event_id FROM scan_events WHERE batch_id = ? ORDER BY seq').bind(b.json.id).all<{ client_event_id: string }>()).results.map((x) => x.client_event_id);
    expect(Math.max(...ids.map((x) => x.length))).toBeLessThanOrEqual(128);
    expect(ids.some((x) => /^#2#[0-9a-f]{40}$/.test(x))).toBe(true);
    const ev = (id: string) => ({ client_event_id: id, type: 'batch.noted', payload: { note: 'n' } });
    const s = await h.call('sorterA', 'POST', `/scanner/batches/${b.json.id}/events`, { body: { events: [ev(`s${'e'.repeat(127)}`)] } });
    expect(s.status, s.text).toBe(200); expect(s.json.acks).toHaveLength(1);
    const s2 = await h.call('sorterA', 'POST', `/scanner/batches/${b.json.id}/events`, { body: { events: [ev(`s${'e'.repeat(128)}`)] } });
    expect(s2.status).toBe(400);
  });
});

describe('2. constraint failures are a clear 4xx, never retried', () => {
  test('classifyDbError: CHECK / NOT NULL → 422 constraint_violation; UNIQUE → Conflict; anything else rethrown', () => {
    const run = (m: string) => { try { classifyDbError(new Error(m)); } catch (e) { return e; } };
    const chk = run('D1_ERROR: CHECK constraint failed: length(client_event_id) BETWEEN 1 AND 128: SQLITE_CONSTRAINT') as ApiError;
    expect(chk).toBeInstanceOf(ApiError); expect(chk.status).toBe(422); expect(chk.code).toBe('constraint_violation');
    expect((run('NOT NULL constraint failed: scan_events.at') as ApiError).status).toBe(422);
    expect(run('UNIQUE constraint failed: scan_events.batch_id, scan_events.client_event_id')).toBeInstanceOf(Conflict);
    const other = run('network down'); expect(other).not.toBeInstanceOf(ApiError); expect(other).not.toBeInstanceOf(Conflict);
  });
  test('a write that breaks a CHECK fails once with 422 and stores nothing (no seq retry loop)', async () => {
    h = await setup();
    const { batch } = await batchWithDrawer(h);
    const store = new Store(h.db);
    const before = await count('SELECT count(*) n FROM scan_events WHERE batch_id = ?', batch.id);
    const row = (await store.getBatch(batch.id))!;
    const bad = { client_event_id: 'x'.repeat(129), type: 'batch.noted', payload: { note: 'n' }, user_id: 'usr_a', key_id: null, request_id: null, device_id: null, at: new Date().toISOString() };
    const err = await store.append(batch.id, row.last_seq, [bad], { summary_json: row.summary_json, status: row.status, name: row.name, updated_at: row.updated_at, finished_at: null, processed_at: null }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError); expect(err.status).toBe(422); expect(err.code).toBe('constraint_violation');
    expect(await count('SELECT count(*) n FROM scan_events WHERE batch_id = ?', batch.id)).toBe(before);
    expect((await store.getBatch(batch.id))!.last_seq).toBe(row.last_seq);
  });
});

describe('3. concurrent writes to one batch', () => {
  test('25 concurrent card adds: all 201, 25 cards, distinct seqs, exactly one recognizer call each', async () => {
    h = await setup({ perMinute: 100 });
    const { batch } = await batchWithDrawer(h);
    const calls0 = h.recognizer.calls;
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}, `part=3001,n=${i}`) })));
    expect(rs.map((r) => r.status)).toEqual(Array(25).fill(201));
    expect(h.recognizer.calls - calls0).toBe(25);
    expect(await count("SELECT count(*) n FROM scan_events WHERE batch_id = ? AND type = 'card.added'", batch.id)).toBe(25);
    expect(await count('SELECT count(DISTINCT seq) n FROM scan_events WHERE batch_id = ?', batch.id)).toBe(await count('SELECT last_seq n FROM scan_batches WHERE id = ?', batch.id));
  });
  test('25 concurrent sync posts all land (acks, no 409)', async () => {
    h = await setup();
    const { batch } = await batchWithDrawer(h);
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/events`,
      { body: { events: [{ client_event_id: `sync-${String(i).padStart(4, '0')}`, type: 'batch.noted', payload: { note: `n${i}` } }] } })));
    expect(rs.map((r) => r.status)).toEqual(Array(25).fill(200));
    expect(rs.every((r) => r.json.acks.length === 1)).toBe(true);
  });
  test('cross-isolate race: losers get 409 write_conflict + Retry-After; a retry with the same key reuses the naming (no 2nd recognizer call, no 2nd slot)', async () => {
    h = await setup({ perMinute: 200, limit: 500, writeAttempts: 1 });
    const { batch } = await batchWithDrawer(h);
    const calls0 = h.recognizer.calls; const slots0 = await count('SELECT count(*) n FROM scan_identify_calls');
    let n = 0; const lost: { key: string; i: number }[] = [];
    for (let round = 0; round < 5 && lost.length === 0; round++) {
      const reqs = Array.from({ length: 12 }, (_, j) => { const i = n++; const k = `race-${String(i).padStart(4, '0')}`;
        return h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}, `part=3001,n=${i}`), key: k, app: (j % 2 ? 2 : 1) as 1 | 2 }).then((r) => ({ r, k, i })); });
      for (const { r, k, i } of await Promise.all(reqs)) {
        if (r.status === 409) { expect(r.json.code).toBe('write_conflict'); expect(r.headers.get('retry-after')).toBe('1'); lost.push({ key: k, i }); }
        else expect(r.status, r.text).toBe(201);
      }
    }
    expect(lost.length).toBeGreaterThan(0);
    expect(h.recognizer.calls - calls0).toBe(n); // one call per request, losers included
    for (const { key: k, i } of lost) {
      const again = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}, `part=3001,n=${i}`), key: k });
      expect(again.status, again.text).toBe(201);
    }
    expect(h.recognizer.calls - calls0).toBe(n); // retries reused the stored result
    expect(await count('SELECT count(*) n FROM scan_identify_calls') - slots0).toBe(n); // and spent no new slot
    expect(await count("SELECT count(*) n FROM scan_events WHERE batch_id = ? AND type = 'card.added'", batch.id)).toBe(n); // zero lost cards
  });
});

describe('4. schema', () => {
  test('summary_json is counts only; the finds list is rebuilt from events', async () => {
    h = await setup();
    const { batch } = await batchWithDrawer(h);
    const card = await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}, 'fig') });
    expect(card.status, card.text).toBe(201);
    const hold = await h.call('sorterA', 'POST', `/scanner/cards/${card.json.id}/hold`, { body: { reason: 'missing_piece' } });
    const sum = JSON.parse((await h.db.prepare('SELECT summary_json s FROM scan_batches WHERE id = ?').bind(batch.id).first<{ s: string }>())!.s);
    expect(sum).not.toHaveProperty('finds');
    expect(hold.status, hold.text).toBeLessThan(300);
    expect(sum.finds_count).toEqual({ held: 1, parts_we_need: 0 });
    expect(JSON.stringify(sum).length).toBeLessThan(4096);
    const list = await h.call('admin', 'GET', '/scanner/finds?type=held');
    expect(list.status, list.text).toBe(200); expect(list.json.data.map((f: any) => f.card_id)).toEqual([card.json.id]);
  });
  test('no scan_events_user_at index; timestamps must be real UTC ISO 8601 as the app writes them', async () => {
    h = await setup();
    expect(await count("SELECT count(*) n FROM sqlite_master WHERE name = 'scan_events_user_at'")).toBe(0);
    const ins = (at: string) => h.db.prepare('INSERT INTO scan_identify_calls (user_id, at) VALUES (?, ?)').bind('usr_t', at).run();
    await expect(ins('2026-11-24T18:00:00.000Z')).resolves.toBeTruthy();
    for (const bad of ['2026-11-24 18:00:00', '2026-11-24T18:00:00Z', 'yesterday', '2026-13-40T18:00:00.000Z']) await expect(ins(bad)).rejects.toThrow(/CHECK/);
  });
});

describe('5. cleanup', () => {
  test('rate rows older than 7 days are purged during a normal naming request', async () => {
    h = await setup({ purgeChance: 1 });
    const { batch } = await batchWithDrawer(h);
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await h.db.prepare('INSERT INTO scan_identify_calls (user_id, at) VALUES (?, ?)').bind('usr_old', old).run();
    expect((await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/cards`, { form: cardForm({}, '') })).status).toBe(201);
    expect(await count("SELECT count(*) n FROM scan_identify_calls WHERE user_id = 'usr_old'")).toBe(0);
    expect(await count('SELECT count(*) n FROM scan_identify_calls')).toBe(1);
  });
  test('batch retention deletes the events before the batch (foreign key holds), and only expired batches', async () => {
    h = await setup();
    const { batch } = await batchWithDrawer(h);
    const keep = await batchWithDrawer(h, 'sorterB');
    const old = new Date(Date.now() - 800 * 86_400_000).toISOString();
    await h.db.prepare('UPDATE scan_batches SET updated_at = ? WHERE id = ?').bind(old, batch.id).run();
    const cut = new Date(Date.now() - 730 * 86_400_000).toISOString();
    const gone = await new Store(h.db).purgeExpiredBatches({ processedBefore: cut, untouchedBefore: cut });
    expect(gone).toEqual([batch.id]);
    expect(await count('SELECT count(*) n FROM scan_events WHERE batch_id = ?', batch.id)).toBe(0);
    expect(await count('SELECT count(*) n FROM scan_batches WHERE id = ?', batch.id)).toBe(0);
    expect(await count('SELECT count(*) n FROM scan_batches WHERE id = ?', keep.batch.id)).toBe(1);
  });
});
