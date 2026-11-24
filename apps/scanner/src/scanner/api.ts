// Scanner handlers. Every route: auth (platform stub) → scope check → object-level check → state rule → append events.
import type { Context } from 'hono';
import { type Principal, hasScope, principalOf, requireScope } from '../platform/auth';
import { nowIso } from '../platform/conventions';
import { newId } from '../platform/ids';
import { REPLAY_HEADER, requestHash } from '../platform/idempotency';
import { decodeCursor, encodeCursor } from '../platform/paging';
import { problem, registerProblemTitles } from '../platform/problem';
import { newSectionRouter } from '../platform/base';
import { type RateLimitHook, allowAll } from '../platform/ratelimit';
import type { Catalog } from './adapters/catalog';
import type { Recognizer, RecognizerResult } from './adapters/recognizer';
import { canRead, ownedBatch, readableBatch, scopedBatch } from './access';
import { toBSX, toCSV, toJSON } from './bsx';
import { exportFileName, nextBatchName, normDrawer } from './names';
import {
  type BatchState, type Card, type Identify, type StoredEvent, CLIENT_EVENT_TYPES, allowedDecisions, cardState, chosen, counts, exportable,
  firstUndecided, isUndecided, itemType, lots, orderedCards, reduce, rejectReason, validColor,
} from './reducer';
import { Conflict, type NewEvent, Store } from './store';
import { type BatchRow, batchView, cardView, drawerViews, finishSummary, summaryOf } from './views';
import { R } from './routes';

registerProblemTitles({
  open_batch_exists: 'You already have an open batch', no_cards: 'This batch has no cards', cards_undecided: 'Some cards are not decided yet',
  batch_finished: 'This batch is finished', batch_processed: 'This batch is processed', not_finished: 'This batch is not finished',
  decision_not_allowed: 'That choice is not allowed for this card', not_a_minifig: 'This card is not a minifig', retry_not_needed: 'This card does not need a retry',
  card_decided: 'Reopen this card before changing it', no_drawer_open: 'Scan a drawer label first', crop_too_large: 'The crop is too large (max 300 KB)',
  rate_limited: 'Naming limit reached', recognizer_not_configured: 'Part naming is not switched on here', batch_event_limit: 'This batch is full; finish it and start a new one', too_many_crops: 'Send one crop per request', id_service_busy: 'The part namer is busy', id_service_error: 'The part namer had an error', id_service_timeout: 'The part namer timed out',
});

export interface ScannerDeps { db: D1Database; catalog: Catalog; recognizer: Recognizer; now?: () => Date; identifyHourlyLimit?: number; identifyPerMinuteLimit?: number; identifyGlobalPerMinute?: number; identifyGlobalPerHour?: number; eventsPerBatch?: number; spec: unknown; rateLimit?: RateLimitHook }
import { ID_LIMITS, MAX_EVENTS_PER_BATCH } from './limits';
const MAX_CROP = ID_LIMITS.maxCropBytes;

type Draft = { type: string; payload: Record<string, unknown> };
type Ctx = Context;

export function createScannerRouter(getDeps: (c: Ctx) => ScannerDeps) {
  const r = newSectionRouter();
  const env = (c: Ctx) => { const d = getDeps(c); return { ...d, store: new Store(d.db), now: d.now ?? (() => new Date()), limit: d.identifyHourlyLimit ?? ID_LIMITS.perHour, perMinute: d.identifyPerMinuteLimit ?? ID_LIMITS.perMinute,
    globalPerMinute: d.identifyGlobalPerMinute ?? ID_LIMITS.globalPerMinute, globalPerHour: d.identifyGlobalPerHour ?? ID_LIMITS.globalPerHour, maxEvents: d.eventsPerBatch ?? MAX_EVENTS_PER_BATCH }; };
  const add = (route: any, h: (c: Ctx) => Promise<Response>) => r.openapi(route, h as never);
  const valid = (c: Ctx, t: 'json' | 'query' | 'param' | 'form' | 'header') => (c.req as any).valid(t);
  const json = (c: Ctx, body: unknown, status = 200, replay = false) => {
    const res = c.json(body as object, status as 200);
    if (replay) res.headers.set(REPLAY_HEADER, 'true');
    return res;
  };

  // ---------- core write path: idempotent append with optimistic concurrency ----------
  async function write(c: Ctx, batchId: string, o: {
    run: (s: BatchState, row: BatchRow, events: StoredEvent[]) => Draft[];
    respond: (s: BatchState, row: BatchRow, first: Record<string, any>, replay: boolean) => Response;
    status: number | ((s: BatchState, drafts: Draft[]) => number);
    body?: unknown;
  }) {
    const e = env(c); const p = principalOf(c);
    const key = valid(c, 'header')['idempotency-key'] as string;
    const hash = await requestHash(c.req.method, new URL(c.req.url).pathname, o.body ?? null);
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await e.store.getBatch(batchId);
      if (!row) throw problem(404, 'not_found');
      const events = await e.store.events(batchId);
      const s = reduce(batchId, events);
      const prior = events.find((x) => x.client_event_id === key);
      if (prior) {
        if (prior.payload.request_hash !== hash) throw problem(422, 'idempotency_mismatch');
        return o.respond(s, row, prior.payload, true);
      }
      const drafts = o.run(s, row, events);
      if (row.last_seq + drafts.length > e.maxEvents) throw problem(409, 'batch_event_limit', { limit: e.maxEvents, detail: `A batch holds at most ${e.maxEvents} events.` });
      const status = typeof o.status === 'function' ? o.status(s, drafts) : o.status;
      const at = nowIso(e.now());
      const fresh: NewEvent[] = drafts.map((d, i) => ({
        client_event_id: i === 0 ? key : `${key}#${i + 1}`, type: d.type,
        payload: i === 0 ? { ...d.payload, request_hash: hash, response_status: status } : d.payload,
        user_id: p.user_id, key_id: p.key_id, request_id: c.get('request_id' as never) as string, device_id: c.req.header('x-device-id')?.slice(0, 64) ?? null, at,
      }));
      const all: StoredEvent[] = [...events, ...fresh.map((f, i) => ({ ...f, seq: row.last_seq + 1 + i }))];
      const s2 = reduce(batchId, all);
      const patch = { summary_json: JSON.stringify(summaryOf(s2, e.catalog)), status: s2.batch.status, name: s2.batch.name, updated_at: at,
        finished_at: s2.batch.finished_at, processed_at: s2.batch.processed_at, processed_by: s2.batch.status === 'processed' && row.status !== 'processed' ? p.user_id : null };
      try { await e.store.append(batchId, row.last_seq, fresh, patch); } catch (err) { if (err instanceof Conflict) continue; throw err; }
      const row2: BatchRow = { ...row, ...patch, processed_by: patch.processed_by ?? row.processed_by, last_seq: row.last_seq + fresh.length } as BatchRow;
      return o.respond(s2, row2, fresh[0].payload, false);
    }
    throw problem(409, 'internal', { detail: 'Too many writes at once; try again.' });
  }

  const openOnly = (s: BatchState) => { if (s.batch.status !== 'open') throw problem(409, s.batch.status === 'finished' ? 'batch_finished' : 'batch_processed'); };
  const findCard = (s: BatchState, id: string) => { const card = s.cards.find((x) => x.id === id); if (!card) throw problem(404, 'not_found'); return card; };

  async function cardBatch(c: Ctx, cardId: string, mode: 'read' | 'write') {
    const e = env(c);
    const batchId = await e.store.cardBatch(cardId);
    if (mode === 'write') requireScope(c, 'scan:write');
    if (!batchId) throw problem(404, 'not_found', { detail: 'No such card' });
    return mode === 'write' ? ownedBatch(c, e.store, batchId) : readableBatch(c, e.store, batchId);
  }
  const includeValues = (c: Ctx) => (valid(c, 'query')?.['include[]'] ?? []).includes('values');
  const cardOut = (c: Ctx, s: BatchState, card: Card) => cardView(s, card, env(c).catalog, { values: includeValues(c) });

  // ---------- me ----------
  const gate = (c: Ctx) => { const p = principalOf(c); if (!hasScope(p, 'batches:read')) throw problem(403, 'forbidden', { need: 'batches:read' }); return p; };
  add(R.getMe, async (c) => {
    const p = gate(c);
    return json(c, { object: 'me', user: { id: p.user_id, name: p.name, role: p.role }, key: { id: p.key_id, mode: p.mode, scopes: p.scopes } });
  });

  // ---------- batches ----------
  add(R.listBatches, async (c) => {
    const e = env(c); const p = principalOf(c); const q = valid(c, 'query');
    if (q.owner === 'all') requireScope(c, 'batches:read_all'); else if (!hasScope(p, 'batches:read')) throw problem(403, 'forbidden', { need: 'batches:read' });
    const cur = decodeCursor(q.cursor);
    const rows = await e.store.listBatches({ owner: q.owner === 'me' ? p.user_id : undefined, status: q.status, limit: q.limit,
      startingAfter: cur ? { created_at: String(cur.c), id: String(cur.i) } : null });
    const page = rows.slice(0, q.limit).filter((row) => canRead(p, row));
    const last = rows.length > q.limit ? rows[q.limit - 1] : null;
    return json(c, { object: 'list', data: page.map(batchView), has_more: !!last, next_cursor: last ? encodeCursor({ c: last.created_at, i: last.id }) : null });
  });

  add(R.createBatch, async (c) => {
    const e = env(c); const p = requireScope(c, 'scan:write'); const body = valid(c, 'json');
    const key = valid(c, 'header')['idempotency-key'];
    const hash = await requestHash('POST', new URL(c.req.url).pathname, body);
    const prior = await e.store.findCreateByKey(p.user_id, key);
    if (prior) {
      if (JSON.parse(prior.payload_json).request_hash !== hash) throw problem(422, 'idempotency_mismatch');
      return json(c, batchView((await e.store.getBatch(prior.batch_id))!), 201, true);
    }
    const open = await e.store.findOpenBatch(p.user_id);
    if (open) throw problem(409, 'open_batch_exists', { batch_id: open.id, detail: 'Resume it, or finish it and start a new one.' });
    const now = e.now(); const at = nowIso(now);
    const id = newId('bat');
    const name = nextBatchName(p.name, now, await e.store.namesLike(p.user_id, nextBatchName(p.name, now, [])));
    const ev: NewEvent = { client_event_id: key, type: 'batch.created', payload: { name, condition: body.condition, note: body.note ?? '', owner_name: p.name.split(/\s+/)[0], request_hash: hash, response_status: 201 },
      user_id: p.user_id, key_id: p.key_id, request_id: c.get('request_id' as never) as string, device_id: c.req.header('x-device-id')?.slice(0, 64) ?? null, at };
    const s = reduce(id, [{ ...ev, seq: 1 }]);
    const row: BatchRow = { id, owner_user_id: p.user_id, name, condition: body.condition, status: 'open', last_seq: 1, summary_json: JSON.stringify(summaryOf(s, e.catalog)),
      created_at: at, updated_at: at, finished_at: null, processed_at: null, processed_by: null };
    try { await e.store.createBatch(row, ev); } catch (err) {
      const again = await e.store.findOpenBatch(p.user_id); // lost a race with another device
      if (again) throw problem(409, 'open_batch_exists', { batch_id: again.id });
      throw err;
    }
    return json(c, batchView(row), 201);
  });

  add(R.getBatch, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param'); const q = valid(c, 'query');
    const { row } = await readableBatch(c, e.store, batch_id);
    const out: Record<string, unknown> = batchView(row);
    const exp: string[] = q['expand[]'] ?? [];
    if (exp.length) {
      const s = reduce(batch_id, await e.store.events(batch_id));
      if (exp.includes('drawers')) out.drawers = drawerViews(s);
      if (exp.includes('cards')) out.cards = orderedCards(s).map((card) => cardOut(c, s, card));
    }
    return json(c, out);
  });

  add(R.updateBatch, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param'); const body = valid(c, 'json');
    await ownedBatch(c, e.store, batch_id);
    return write(c, batch_id, { body, status: 200,
      run: (s) => {
        if (s.batch.status === 'processed') throw problem(409, 'batch_processed');
        const d: Draft[] = [];
        if (body.name !== undefined) d.push({ type: 'batch.renamed', payload: { name: body.name.trim() } });
        if (body.note !== undefined) d.push({ type: 'batch.noted', payload: { note: body.note } });
        return d;
      },
      respond: (_s, row, _f, replay) => json(c, batchView(row), 200, replay) });
  });

  add(R.finishBatch, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param');
    await ownedBatch(c, e.store, batch_id);
    return write(c, batch_id, { status: 200,
      run: (s) => {
        openOnly(s);
        if (!s.cards.length) throw problem(409, 'no_cards');
        const k = counts(s, e.catalog);
        if (k.undecided > 0) throw problem(409, 'cards_undecided', { count: k.undecided, first_card_id: firstUndecided(s)!.id, detail: `${k.undecided} card(s) still need Approve, Drop, Set aside or Unknown.` });
        return [{ type: 'batch.finished', payload: {} }];
      },
      respond: (s, row, _f, replay) => json(c, finishSummary(s, e.catalog, row), 200, replay) });
  });

  add(R.reopenBatch, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param');
    const { p } = await ownedBatch(c, e.store, batch_id);
    const open = await e.store.findOpenBatch(p.user_id);
    return write(c, batch_id, { status: 200,
      run: (s) => {
        if (s.batch.status === 'open') throw problem(409, 'not_finished');
        if (s.batch.status === 'processed') throw problem(409, 'batch_processed');
        if (open && open.id !== batch_id) throw problem(409, 'open_batch_exists', { batch_id: open.id });
        return [{ type: 'batch.reopened', payload: {} }];
      },
      respond: (_s, row, _f, replay) => json(c, batchView(row), 200, replay) });
  });

  add(R.markBatchProcessed, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param');
    await scopedBatch(c, e.store, batch_id, 'batches:process');
    return write(c, batch_id, { status: 200,
      run: (s) => {
        if (s.batch.status === 'open') throw problem(409, 'not_finished');
        if (s.batch.status === 'processed') throw problem(409, 'batch_processed');
        return [{ type: 'batch.processed', payload: {} }];
      },
      respond: (_s, row, _f, replay) => json(c, batchView(row), 200, replay) });
  });

  // ---------- sync ----------
  add(R.listBatchEvents, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param'); const q = valid(c, 'query');
    const { row } = await readableBatch(c, e.store, batch_id);
    const cur = decodeCursor(q.cursor);
    const after = Math.max(q.after_seq, cur ? Number(cur.s) || 0 : 0);
    const evs = await e.store.events(batch_id, after, q.limit + 1);
    const page = evs.slice(0, q.limit);
    const more = evs.length > q.limit;
    return json(c, { object: 'list', data: page.map((x) => ({ id: `evt_${batch_id.slice(4)}${String(x.seq).padStart(6, '0')}`, seq: x.seq, type: x.type,
      payload: stripInternal(x.payload), user_id: x.user_id, key_id: x.key_id ?? null, device_id: x.device_id, at: x.at })),
      last_seq: row.last_seq, has_more: more, next_cursor: more ? encodeCursor({ s: page[page.length - 1].seq }) : null });
  });

  add(R.appendBatchEvents, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param'); const body = valid(c, 'json'); const p = principalOf(c);
    await ownedBatch(c, e.store, batch_id);
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = (await e.store.getBatch(batch_id))!;
      const events = await e.store.events(batch_id);
      const known = new Map(events.map((x) => [x.client_event_id, x.seq]));
      let s = reduce(batch_id, events);
      const acks: { client_event_id: string; seq: number; replayed: boolean }[] = []; const rejected: { client_event_id: string; reason: string }[] = [];
      const fresh: NewEvent[] = []; const at = nowIso(e.now());
      const all = [...events];
      for (const ev of body.events) {
        if (known.has(ev.client_event_id)) { acks.push({ client_event_id: ev.client_event_id, seq: known.get(ev.client_event_id)!, replayed: true }); continue; }
        const payload = stripInternal(ev.payload as Record<string, any>);
        if (ev.type === 'drawer.opened' && normDrawer(payload.code)) payload.code = normDrawer(payload.code);
        if (JSON.stringify(payload).length > 7000) { rejected.push({ client_event_id: ev.client_event_id, reason: 'payload_too_large' }); continue; }
        if (row.last_seq + fresh.length + 1 > e.maxEvents) { rejected.push({ client_event_id: ev.client_event_id, reason: 'batch_event_limit' }); continue; }
        const why = CLIENT_EVENT_TYPES.has(ev.type) || ['batch.created', 'batch.finished', 'batch.reopened', 'batch.exported', 'batch.processed', 'card.added', 'card.updated'].includes(ev.type) ? rejectReason(s, { type: ev.type, payload }, e.catalog) : 'unknown_event_type';
        if (why) { rejected.push({ client_event_id: ev.client_event_id, reason: why }); continue; }
        const seq = row.last_seq + fresh.length + 1;
        const ne: NewEvent = { client_event_id: ev.client_event_id, type: ev.type, payload, user_id: p.user_id, key_id: p.key_id, request_id: c.get('request_id' as never) as string, device_id: ev.device_id ?? null, at };
        fresh.push(ne); all.push({ ...ne, seq }); known.set(ev.client_event_id, seq);
        s = reduce(batch_id, all);
        acks.push({ client_event_id: ev.client_event_id, seq, replayed: false });
      }
      if (fresh.length) {
        const patch = { summary_json: JSON.stringify(summaryOf(s, e.catalog)), status: s.batch.status, name: s.batch.name, updated_at: at, finished_at: s.batch.finished_at, processed_at: s.batch.processed_at };
        try { await e.store.append(batch_id, row.last_seq, fresh, patch); } catch (err) { if (err instanceof Conflict) continue; throw err; }
      }
      return json(c, { acks, rejected, last_seq: row.last_seq + fresh.length });
    }
    throw problem(409, 'internal', { detail: 'Too many writes at once; try again.' });
  });

  // ---------- drawers ----------
  add(R.listDrawers, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param'); const q = valid(c, 'query');
    await readableBatch(c, e.store, batch_id);
    const all = drawerViews(reduce(batch_id, await e.store.events(batch_id)));
    const start = Number(decodeCursor(q.cursor)?.o ?? 0);
    const page = all.slice(start, start + q.limit);
    const more = start + q.limit < all.length;
    return json(c, { object: 'list', data: page, has_more: more, next_cursor: more ? encodeCursor({ o: start + q.limit }) : null });
  });

  add(R.openDrawer, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param'); const body = valid(c, 'json');
    await ownedBatch(c, e.store, batch_id);
    const code = normDrawer(body.code);
    if (!code) throw problem(400, 'invalid_request', { errors: [{ field: 'json.code', message: 'Not a drawer code (letters, digits, space . _ -, max 24)' }] });
    return write(c, batch_id, { body, status: (s) => (s.drawers.some((d) => d.code === code) ? 200 : 201),
      run: (s) => { openOnly(s); return [{ type: 'drawer.opened', payload: { code } }]; },
      respond: (s, _row, f, replay) => json(c, drawerViews(s).find((d) => d.code === code), f.response_status, replay) });
  });

  // ---------- photos ----------
  add(R.recordPhoto, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param'); const body = valid(c, 'json');
    await ownedBatch(c, e.store, batch_id);
    return write(c, batch_id, { body, status: 201,
      run: (s) => {
        openOnly(s);
        const drawer = body.drawer_code !== undefined ? normDrawer(body.drawer_code) : s.current_drawer;
        if (!drawer || !s.drawers.some((d) => d.code === drawer)) throw problem(409, 'no_drawer_open', { detail: 'Scan the drawer label before taking photos.' });
        return [{ type: 'photo.taken', payload: { photo_id: newId('pho'), drawer_code: drawer, boxes: body.boxes } }];
      },
      respond: (s, _r, f, replay) => { const ph = s.photos.find((x) => x.id === f.photo_id)!; return json(c, { id: ph.id, object: 'photo', number: ph.number, drawer_code: ph.drawer, boxes: ph.boxes }, 201, replay); } });
  });

  // ---------- cards ----------
  add(R.listCards, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param'); const q = valid(c, 'query');
    await readableBatch(c, e.store, batch_id);
    const s = reduce(batch_id, await e.store.events(batch_id));
    const drawer = q.drawer !== undefined ? normDrawer(q.drawer) : undefined;
    let list = orderedCards(s).filter((card) => {
      const st = cardState(card);
      if (q.state === 'undecided' && !isUndecided(card)) return false;
      if (q.state === 'decided' && isUndecided(card)) return false;
      if (q.state && !['undecided', 'decided'].includes(q.state) && st !== q.state) return false;
      return drawer === undefined || card.drawer === drawer;
    });
    const cur = decodeCursor(q.cursor);
    if (cur) { const i = list.findIndex((x) => x.id === cur.i); list = i >= 0 ? list.slice(i + 1) : []; }
    const page = list.slice(0, q.limit);
    const more = list.length > q.limit;
    return json(c, { object: 'list', data: page.map((card) => cardOut(c, s, card)), has_more: more, next_cursor: more ? encodeCursor({ i: page[page.length - 1].id }) : null });
  });

  function identifyFrom(res: RecognizerResult, cat: Catalog): Identify {
    if (res.status === 'ok') return { status: 'ok', source: 'recognizer', candidates: res.candidates.map((x) => { const no = cat.mainNumber(x.part_no); return { ...x, part_no: no, name: x.name || cat.part(no)?.name || '' }; }) };
    if (res.status === 'none') return { status: 'none' };
    const code = res.kind === 'busy' ? 'id_service_busy' : res.kind === 'timeout' ? 'id_service_timeout' : 'id_service_error';
    return { status: 'error', error_code: code, ...(res.retry_after_s !== undefined ? { retry_after_s: res.retry_after_s } : {}) };
  }
  function identifyProblem(card: Card) {
    const code = card.identify.error_code ?? 'id_service_error';
    const status = code === 'id_service_busy' ? 429 : code === 'id_service_timeout' ? 504 : 502;
    const ra = card.identify.retry_after_s ?? 30;
    return problem(status, code, { card_id: card.id, ...(status === 429 ? { retry_after_s: ra } : {}), detail: 'The card is saved; use Retry when ready.' }, status === 429 ? { 'Retry-After': String(ra) } : {});
  }
  async function cropFrom(c: Ctx): Promise<File> {
    const form = valid(c, 'form');
    const crop = form.crop as File;
    if (crop.size > MAX_CROP) throw problem(413, 'crop_too_large', { detail: `Crops must be 300 KB or smaller (this one is ${Math.ceil(crop.size / 1024)} KB).` });
    if (crop.size === 0) throw problem(400, 'invalid_request', { errors: [{ field: 'form.crop', message: 'Empty file' }] });
    return crop;
  }
  async function rateCap(c: Ctx, p: Principal) {
    const e = env(c); const now = e.now();
    const hook = await (e.rateLimit ?? allowAll).check(`${p.user_id}:${p.key_id ?? '-'}`, 'scanner.identify');
    if (!hook.ok) throw problem(429, 'rate_limited', { retry_after_s: hook.retry_after_s, detail: 'Too many naming requests from this caller.' }, { 'Retry-After': String(hook.retry_after_s) });
    const minuteAgo = nowIso(new Date(now.getTime() - 60_000)); const hourAgo = nowIso(new Date(now.getTime() - 3600_000));
    const ok = await e.store.reserveIdentify({ user: p.user_id, at: nowIso(now), requestId: c.get('request_id' as never) as string, minuteAgo, hourAgo,
      perMinute: e.perMinute, perHour: e.limit, globalPerMinute: e.globalPerMinute, globalPerHour: e.globalPerHour });
    if (ok) return; // slot reserved before the call; it stays counted even if the call or the write fails
    const windows = [
      { limit: 'minute', user: p.user_id, since: minuteAgo, ms: 60_000, cap: e.perMinute, detail: `${e.perMinute} namings per minute per person.` },
      { limit: 'hourly', user: p.user_id, since: hourAgo, ms: 3600_000, cap: e.limit, detail: `${e.limit} namings per hour per person.` },
      { limit: 'global_minute', user: null, since: minuteAgo, ms: 60_000, cap: e.globalPerMinute, detail: 'The shared naming limit for everyone is reached; try again shortly.' },
      { limit: 'global_hourly', user: null, since: hourAgo, ms: 3600_000, cap: e.globalPerHour, detail: 'The shared hourly naming limit for everyone is reached.' },
    ] as const;
    for (const w of windows) {
      const { n, oldest } = await e.store.identifyWindow(w.user, w.since);
      if (n >= w.cap) {
        const wait = Math.max(1, Math.ceil(((oldest ? Date.parse(oldest) : now.getTime()) + w.ms - now.getTime()) / 1000));
        throw problem(429, 'rate_limited', { limit: w.limit, retry_after_s: wait, detail: w.detail }, { 'Retry-After': String(wait) });
      }
    }
    throw problem(429, 'rate_limited', { retry_after_s: 1, detail: 'Naming limit reached; try again.' }, { 'Retry-After': '1' });
  }
  /** G8 before spending a recognizer call: refuse early when the batch is full. */
  const roomFor = (c: Ctx, s: BatchState, n: number) => {
    const max = env(c).maxEvents;
    if (s.last_seq + n > max) throw problem(409, 'batch_event_limit', { limit: max, detail: `A batch holds at most ${max} events.` });
  };
  const recognizerReady = (c: Ctx) => {
    if ((env(c).recognizer as { notConfigured?: boolean }).notConfigured) throw problem(503, 'recognizer_not_configured', { detail: 'Part naming is not switched on in this environment.' });
  };

  add(R.createCard, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param');
    const { p } = await ownedBatch(c, e.store, batch_id);
    const crop = await cropFrom(c);
    let meta: any;
    try { meta = JSON.parse(valid(c, 'form').meta); } catch { throw problem(400, 'invalid_request', { errors: [{ field: 'form.meta', message: 'meta must be JSON text' }] }); }
    const { CardMeta } = await import('./schemas');
    const m = CardMeta.safeParse(meta);
    if (!m.success) throw problem(400, 'invalid_request', { errors: m.error.issues.map((i) => ({ field: ['form', 'meta', ...i.path].join('.'), message: i.message })) });
    const key = valid(c, 'header')['idempotency-key'];
    const body = { meta: m.data, crop_sha256: await (await import('../platform/ids')).sha256Hex(await crop.arrayBuffer()) };
    // Pre-checks before spending a recognizer call. Replays never call the recognizer again.
    const pre = reduce(batch_id, await e.store.events(batch_id));
    const drawerOf = (s: BatchState) => {
      openOnly(s);
      const photo = m.data.photo_id ? s.photos.find((x) => x.id === m.data.photo_id) : undefined;
      if (m.data.photo_id && !photo) throw problem(400, 'invalid_request', { errors: [{ field: 'form.meta.photo_id', message: 'No such photo in this batch' }] });
      if (photo && m.data.box !== undefined && m.data.box > photo.boxes) throw problem(400, 'invalid_request', { errors: [{ field: 'form.meta.box', message: `Photo ${photo.number} has ${photo.boxes} boxes` }] });
      const drawer = m.data.drawer_code !== undefined ? normDrawer(m.data.drawer_code) : photo?.drawer ?? s.current_drawer;
      if (!drawer || !s.drawers.some((d) => d.code === drawer)) throw problem(409, 'no_drawer_open');
      return drawer;
    };
    const already = (await e.store.events(batch_id)).some((x) => x.client_event_id === key);
    let ident: Identify | null = null;
    if (!already) { drawerOf(pre); roomFor(c, pre, 1); recognizerReady(c); await rateCap(c, p); ident = identifyFrom(await e.recognizer.identify(crop, { kind: m.data.kind ?? 'part' }), e.catalog); }
    return write(c, batch_id, { body, status: () => (ident?.status === 'error' ? identifyProblem({ identify: ident } as Card).status : 201),
      run: (s) => [{ type: 'card.added', payload: { card_id: newId('crd'), photo_id: m.data.photo_id ?? null, box: m.data.box ?? null, drawer_code: drawerOf(s), kind: m.data.kind ?? 'part', identify: ident, identify_call: 1 } }],
      respond: (s, _r, f, replay) => {
        const card = findCard(s, f.card_id);
        if (f.response_status >= 400 && cardState(card) === 'error') throw identifyProblem(card);
        return json(c, cardOut(c, s, card), 201, replay);
      } });
  });

  add(R.getCard, async (c) => {
    const e = env(c); const { card_id } = valid(c, 'param');
    const { row } = await cardBatch(c, card_id, 'read');
    const s = reduce(row.id, await e.store.events(row.id));
    return json(c, cardOut(c, s, findCard(s, card_id)));
  });

  add(R.updateCard, async (c) => {
    const e = env(c); const { card_id } = valid(c, 'param'); const body = valid(c, 'json');
    const { row } = await cardBatch(c, card_id, 'write');
    return write(c, row.id, { body, status: 200,
      run: (s, _row, events) => {
        openOnly(s);
        const card = findCard(s, card_id);
        if (!isUndecided(card)) throw problem(409, 'card_decided');
        const d: Draft[] = []; let tmp = card;
        const step = (field: string, to: unknown, extra: Record<string, unknown> = {}) => {
          const ev: Draft = { type: 'card.edited', payload: { card_id, field, from: (tmp as any)[field === 'part_no' ? 'override' : field] ?? null, to, ...extra } };
          d.push(ev);
          tmp = reduce(row.id, [...events, ...d.map((x, i) => ({ ...x, seq: 1e9 + i, user_id: '', device_id: null, at: card.updated_at }))]).cards.find((x) => x.id === card_id)!;
        };
        if (body.part_no !== undefined) {
          const no = e.catalog.mainNumber(body.part_no); const cp = e.catalog.part(no);
          step('part_no', no, { name: cp?.name ?? '', item_type: cp?.pieces?.length ? 'M' : 'P' });
        }
        if (body.pick !== undefined) {
          if (!card.identify.candidates?.[body.pick]) throw problem(400, 'invalid_request', { errors: [{ field: 'json.pick', message: 'No such candidate' }] });
          step('pick', body.pick);
        }
        if (body.color_id !== undefined) {
          if (!validColor(tmp, body.color_id, e.catalog)) throw problem(400, 'invalid_request', { errors: [{ field: 'json.color_id', message: chosen(tmp) ? 'That color does not exist for this part' : 'Pick the part first' }] });
          step('color_id', body.color_id);
        }
        if (body.qty !== undefined) step('qty', body.qty);
        if (body.note !== undefined) step('note', body.note);
        return d;
      },
      respond: (s, _r, _f, replay) => json(c, cardOut(c, s, findCard(s, card_id)), 200, replay) });
  });

  add(R.retryIdentify, async (c) => {
    const e = env(c); const { card_id } = valid(c, 'param');
    const { row, p } = await cardBatch(c, card_id, 'write');
    const crop = await cropFrom(c);
    const key = valid(c, 'header')['idempotency-key'];
    const body = { crop_sha256: await (await import('../platform/ids')).sha256Hex(await crop.arrayBuffer()) };
    const events = await e.store.events(row.id);
    let ident: Identify | null = null;
    if (!events.some((x) => x.client_event_id === key)) {
      const s = reduce(row.id, events); openOnly(s);
      const card = findCard(s, card_id);
      if (!['error', 'identifying'].includes(cardState(card))) throw problem(409, 'retry_not_needed');
      roomFor(c, s, 1);
      recognizerReady(c);
      await rateCap(c, p);
      ident = identifyFrom(await e.recognizer.identify(crop, { kind: card.kind }), e.catalog);
    }
    return write(c, row.id, { body, status: () => (ident?.status === 'error' ? identifyProblem({ identify: ident } as Card).status : 200),
      run: (s) => { openOnly(s); findCard(s, card_id); return [{ type: 'card.updated', payload: { card_id, identify: ident, identify_call: 1 } }]; },
      respond: (s, _r, f, replay) => {
        const card = findCard(s, card_id);
        if (f.response_status >= 400 && cardState(card) === 'error') throw identifyProblem(card);
        return json(c, cardOut(c, s, card), 200, replay);
      } });
  });

  add(R.decideCard, async (c) => {
    const e = env(c); const { card_id } = valid(c, 'param'); const body = valid(c, 'json');
    const { row } = await cardBatch(c, card_id, 'write');
    return write(c, row.id, { body, status: 200,
      run: (s) => {
        openOnly(s);
        const card = findCard(s, card_id); const allowed = allowedDecisions(card, e.catalog);
        if (!(allowed as string[]).includes(body.state)) throw problem(409, 'decision_not_allowed', { card_id, detail: allowed.length ? `Allowed now: ${allowed.join(', ')}.` : 'This card is already decided; reopen it first.' });
        return [{ type: 'card.decided', payload: { card_id, state: body.state } }];
      },
      respond: (s, _r, _f, replay) => json(c, cardOut(c, s, findCard(s, card_id)), 200, replay) });
  });

  add(R.reopenCard, async (c) => {
    const e = env(c); const { card_id } = valid(c, 'param');
    const { row } = await cardBatch(c, card_id, 'write');
    return write(c, row.id, { status: 200,
      run: (s) => {
        openOnly(s);
        const card = findCard(s, card_id);
        if (isUndecided(card)) throw problem(409, 'decision_not_allowed', { card_id, detail: 'This card is not decided.' });
        if (card.decision === 'parted_out') throw problem(409, 'decision_not_allowed', { card_id, detail: 'A parted-out fig stays parted out; drop its piece cards instead.' });
        return [{ type: 'card.reopened', payload: { card_id } }];
      },
      respond: (s, _r, _f, replay) => json(c, cardOut(c, s, findCard(s, card_id)), 200, replay) });
  });

  add(R.partOutFig, async (c) => {
    const e = env(c); const { card_id } = valid(c, 'param'); const body = (valid(c, 'json') ?? {}) as { pieces?: { part_no: string; color_id: number; qty?: number; name?: string }[] };
    const { row } = await cardBatch(c, card_id, 'write');
    return write(c, row.id, { body, status: 201,
      run: (s) => {
        openOnly(s);
        const fig = findCard(s, card_id); const pick = chosen(fig);
        if (itemType(fig) !== 'M' || !pick) throw problem(409, 'not_a_minifig', { card_id });
        if (!isUndecided(fig)) throw problem(409, 'decision_not_allowed', { card_id, detail: 'Reopen the fig first.' });
        const pieces = body.pieces ?? e.catalog.figPieces(pick.part_no);
        if (!pieces.length) throw problem(400, 'invalid_request', { errors: [{ field: 'json.pieces', message: 'This fig has no known pieces; send them' }] });
        const d: Draft[] = pieces.map((pc) => {
          const no = e.catalog.mainNumber(pc.part_no);
          return { type: 'card.added', payload: { card_id: newId('crd'), parent_card_id: card_id, photo_id: fig.photo_id, box: fig.box, drawer_code: fig.drawer, kind: 'part',
            qty: pc.qty ?? 1, color_id: pc.color_id, identify: { status: 'ok', source: 'part_out', candidates: [{ part_no: no, name: ('name' in pc && pc.name) || e.catalog.part(no)?.name || '', item_type: 'P', score: 1 }] } } };
        });
        d.push({ type: 'card.decided', payload: { card_id, state: 'parted_out' } });
        return [d[d.length - 1], ...d.slice(0, -1)]; // the fig's decision first so the request hash rides on it
      },
      respond: (s, _r, _f, replay) => {
        const fig = findCard(s, card_id);
        return json(c, { object: 'part_out', fig: cardOut(c, s, fig), pieces: orderedCards(s).filter((x) => x.parent_card_id === card_id).map((x) => cardOut(c, s, x)) }, 201, replay);
      } });
  });

  add(R.holdFig, async (c) => {
    const e = env(c); const { card_id } = valid(c, 'param'); const body = valid(c, 'json');
    const { row } = await cardBatch(c, card_id, 'write');
    return write(c, row.id, { body, status: 200,
      run: (s) => {
        openOnly(s);
        const fig = findCard(s, card_id);
        if (itemType(fig) !== 'M') throw problem(409, 'not_a_minifig', { card_id });
        if (!isUndecided(fig)) throw problem(409, 'decision_not_allowed', { card_id, detail: 'Reopen the fig first.' });
        return [{ type: 'card.decided', payload: { card_id, state: 'set_aside', held: true, hold_reason: body.reason } }];
      },
      respond: (s, _r, _f, replay) => json(c, cardOut(c, s, findCard(s, card_id)), 200, replay) });
  });

  add(R.needHelp, async (c) => {
    const e = env(c); const { card_id } = valid(c, 'param'); const body = valid(c, 'json');
    const { row } = await cardBatch(c, card_id, 'write');
    return write(c, row.id, { body, status: 200,
      run: (s) => {
        openOnly(s);
        const card = findCard(s, card_id);
        if (!allowedDecisions(card, e.catalog).includes('unknown')) throw problem(409, 'decision_not_allowed', { card_id });
        return [{ type: 'card.decided', payload: { card_id, state: 'unknown', help_text: body.text } }];
      },
      respond: (s, _r, _f, replay) => json(c, cardOut(c, s, findCard(s, card_id)), 200, replay) });
  });

  // ---------- exports (admin) ----------
  const exportView = (batchId: string, x: Record<string, any>, at: string) => ({ id: x.export_id, object: 'export', batch_id: batchId, format: x.format, file_name: x.file_name,
    lots: x.lots, left_out: x.left_out, at_seq: x.at_seq, download_url: `/api/v1/scanner/exports/${x.export_id}/file`, created_at: at });

  add(R.createExport, async (c) => {
    const e = env(c); const { batch_id } = valid(c, 'param'); const body = valid(c, 'json');
    await scopedBatch(c, e.store, batch_id, 'exports:create');
    let createdAt = '';
    return write(c, batch_id, { body, status: 201,
      run: (s) => {
        if (s.batch.status === 'open') throw problem(409, 'not_finished', { detail: 'Finish the batch before exporting.' });
        const ls = lots(s, e.catalog);
        const first = exportFileName(s.batch.name, e.now(), body.format);
        const taken = new Set(s.exports.map((x) => x.file_name));
        let name = first;
        for (let n = 2; taken.has(name); n++) name = first.replace(/\.(bsx|csv|json)$/, `-${n}.$1`); // never overwrite
        createdAt = nowIso(e.now());
        return [{ type: 'batch.exported', payload: { export_id: newId('exp'), format: body.format, file_name: name, at_seq: s.last_seq, lots: ls.filter(exportable).length, left_out: ls.filter((l) => !exportable(l)).length } }];
      },
      respond: (s, _r, f, replay) => json(c, exportView(batch_id, f, s.exports.find((x) => x.export_id === f.export_id)?.created_at ?? createdAt), 201, replay) });
  });

  async function loadExport(c: Ctx, exportId: string) {
    const e = env(c);
    requireScope(c, 'exports:create');
    const ev = await e.store.exportEvent(exportId);
    if (!ev) throw problem(404, 'not_found');
    await readableBatch(c, e.store, ev.batch_id);
    return { batchId: ev.batch_id, payload: JSON.parse(ev.payload_json), at: ev.at };
  }

  add(R.getExport, async (c) => {
    const { export_id } = valid(c, 'param');
    const x = await loadExport(c, export_id);
    return json(c, exportView(x.batchId, x.payload, x.at));
  });

  add(R.downloadExport, async (c) => {
    const e = env(c); const { export_id } = valid(c, 'param');
    const x = await loadExport(c, export_id);
    const s = reduce(x.batchId, (await e.store.events(x.batchId)).filter((ev) => ev.seq <= x.payload.at_seq));
    const ls = lots(s, e.catalog);
    const disp = { 'Content-Disposition': `attachment; filename="${x.payload.file_name}"`, 'Cache-Control': 'no-store' };
    if (x.payload.format === 'bsx') return c.body(toBSX(ls), 200, { 'Content-Type': 'application/xml; charset=utf-8', ...disp });
    if (x.payload.format === 'csv') return c.body(toCSV(ls), 200, { 'Content-Type': 'text/csv; charset=utf-8', ...disp });
    return c.body(JSON.stringify(toJSON({ id: s.batch.id, name: s.batch.name, condition: s.batch.condition }, ls)), 200, { 'Content-Type': 'application/json', ...disp });
  });

  // ---------- finds (admin lists) ----------
  add(R.listFinds, async (c) => {
    const e = env(c); const q = valid(c, 'query');
    const p = requireScope(c, 'batches:read_all');
    const rows = (await e.store.allBatchesWithFinds()).filter((row) => canRead(p, row));
    let all = rows.flatMap((row) => (JSON.parse(row.summary_json).finds ?? []).filter((f: any) => f.type === q.type).map((f: any) => ({ object: 'find', ...f, batch_id: row.id, batch_name: row.name })))
      .sort((a: any, b: any) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.card_id < b.card_id ? 1 : -1));
    const cur = decodeCursor(q.cursor);
    if (cur) { const i = all.findIndex((f: any) => f.card_id === cur.i); all = i >= 0 ? all.slice(i + 1) : []; }
    const page = all.slice(0, q.limit); const more = all.length > q.limit;
    return json(c, { object: 'list', data: page, has_more: more, next_cursor: more ? encodeCursor({ i: page[page.length - 1].card_id }) : null });
  });

  add(R.getSpec, async (c) => { gate(c); return json(c, getDeps(c).spec); });
  return r;
}

const INTERNAL = new Set(['request_hash', 'response_status', 'identify_call']);
function stripInternal(p: Record<string, any>) { const o: Record<string, any> = {}; for (const [k, v] of Object.entries(p || {})) if (!INTERNAL.has(k)) o[k] = v; return o; }
