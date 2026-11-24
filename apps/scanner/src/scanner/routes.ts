// Operations of the contract (DRAFT 1). Paths are relative to the platform server `/api/v1`, all under /scanner/…,
// with operationIds prefixed `scanner` so they merge into pts-v2's /api/v1/openapi.json cleanly.
import { createRoute, z } from '@hono/zod-openapi';
import { CursorParam, LimitParam, listOf } from '../platform/paging';
import { IdempotencyHeaders } from '../platform/idempotency';
import * as S from './schemas';

const PROBLEM_TEXT: Record<number, string> = {
  400: '`invalid_request` (with `errors[]`), `idempotency_key_missing`, `ambiguous_credentials` (session cookie and API key on one request) or `too_many_crops`',
  401: '`api_key_missing` or `api_key_invalid`',
  403: '`forbidden`, with `need` naming the missing scope (or `owner`)',
  404: '`not_found` (also for batches the key may not see, so ids do not leak)',
  409: 'A state rule refused the write (see `code`), including `batch_event_limit` when a batch is full',
  413: '`crop_too_large` (crop over 300 KB) or `body_too_large`',
  415: '`unsupported_media_type` / `image_data_refused`: only the two naming routes accept image data',
  422: '`idempotency_mismatch`: this key was used with a different request',
  429: '`id_service_busy` (the namer said wait; card saved as `error`, with `card_id`) or `rate_limited` (per-person per-minute or hourly cap, or the shared cap for everyone; `limit` says which; no card made)',
  502: '`id_service_error`: the namer failed. The card is saved with state `error` (see `card_id`); Retry works.',
  503: '`recognizer_not_configured`: part naming is not switched on in this environment. Nothing is saved.',
  504: '`id_service_timeout`: the namer took too long. The card is saved with state `error` (see `card_id`); Retry works.',
};
const problems = (...codes: number[]) => Object.fromEntries(codes.map((n) => [n, {
  description: PROBLEM_TEXT[n],
  ...(n === 429 ? { headers: { 'Retry-After': { schema: { type: 'integer' as const, minimum: 0 }, description: 'Seconds to wait' } } } : {}),
  ...(n === 401 ? { headers: { 'WWW-Authenticate': { schema: { type: 'string' as const } } } } : {}),
  content: { 'application/problem+json': { schema: S.Problem } },
}]));
const REPLAYED = { 'Idempotent-Replayed': { schema: { type: 'string' as const, enum: ['true'] }, description: '`true` when this answer replays an earlier request with the same Idempotency-Key' } };
const ok = (schema: z.ZodTypeAny, description: string, replay = false) => ({ description, ...(replay ? { headers: REPLAYED } : {}), content: { 'application/json': { schema } } });
const jsonBody = (schema: z.ZodTypeAny, required = true) => ({ required, content: { 'application/json': { schema } } });

const BatchParams = z.object({ batch_id: S.BatchId.openapi({ param: { name: 'batch_id', in: 'path' } }) });
const CardParams = z.object({ card_id: S.CardId.openapi({ param: { name: 'card_id', in: 'path' } }) });
const ExportParams = z.object({ export_id: S.ExportId.openapi({ param: { name: 'export_id', in: 'path' } }) });
const arr = <T extends z.ZodTypeAny>(item: T) => z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]), z.array(item).optional());
const IncludeQuery = arr(z.enum(['values'])).openapi({ param: { name: 'include[]', in: 'query', style: 'form', explode: true }, description: 'Per-part values are opt-in (a sorter setting, off by default). Batch and minifig values always show.' });
const W = { headers: IdempotencyHeaders };
const WRITE_PROBLEMS = [400, 401, 403, 404, 409, 413, 415, 422] as const;

export const BatchList = listOf(S.Batch, 'ScannerBatchList');
export const CardList = listOf(S.Card, 'ScannerCardList');
export const DrawerList = listOf(S.Drawer, 'ScannerDrawerList');
export const FindList = listOf(S.Find, 'ScannerFindList');
export const EventList = z.object({ object: z.literal('list'), data: z.array(S.Event), last_seq: z.number().int(), has_more: z.boolean(), next_cursor: z.string().nullable() }).openapi('ScannerEventList');

export const R = {
  getMe: createRoute({ method: 'get', path: '/scanner/me', operationId: 'scannerGetMe', tags: ['scanner-me'], summary: 'Who this key belongs to', description: 'The person behind the key, with role and scopes. Pending users (no role) get 403.',
    responses: { 200: ok(S.Me, 'The key owner'), ...problems(400, 401, 403) } }),

  listBatches: createRoute({ method: 'get', path: '/scanner/batches', operationId: 'scannerListBatches', tags: ['scanner-batches'], summary: 'List batches, newest first',
    description: 'Default: your own batches only (scope `batches:read`). `owner=all` needs `batches:read_all` (team, admin).',
    request: { query: z.object({ owner: z.enum(['me', 'all']).default('me').openapi({ param: { name: 'owner', in: 'query' } }), status: S.BatchStatus.optional().openapi({ param: { name: 'status', in: 'query' } }), limit: LimitParam, cursor: CursorParam }) },
    responses: { 200: ok(BatchList, 'A page of batches'), ...problems(400, 401, 403) } }),

  createBatch: createRoute({ method: 'post', path: '/scanner/batches', operationId: 'scannerCreateBatch', tags: ['scanner-batches'], summary: 'Start a batch (one open batch per sorter)',
    description: 'The server names it from the first name and the Chicago date ("Sam 11-24-26", then " B", " C"). A second open batch gives 409 `open_batch_exists` with `batch_id`.',
    request: { ...W, body: jsonBody(S.CreateBatchBody) }, responses: { 201: ok(S.Batch, 'Created', true), ...problems(400, 401, 403, 409, 413, 415, 422) } }),

  getBatch: createRoute({ method: 'get', path: '/scanner/batches/{batch_id}', operationId: 'scannerGetBatch', tags: ['scanner-batches'], summary: 'One batch', description: 'Small by default; `expand[]=drawers` and `expand[]=cards` add the lists.',
    request: { params: BatchParams, query: z.object({ 'expand[]': arr(z.enum(['drawers', 'cards'])).openapi({ param: { name: 'expand[]', in: 'query', style: 'form', explode: true } }), 'include[]': IncludeQuery }) },
    responses: { 200: ok(S.Batch, 'The batch'), ...problems(400, 401, 403, 404) } }),

  updateBatch: createRoute({ method: 'patch', path: '/scanner/batches/{batch_id}', operationId: 'scannerUpdateBatch', tags: ['scanner-batches'], summary: 'Rename or add a note', description: 'Any time before Processed. Owner only.',
    request: { ...W, params: BatchParams, body: jsonBody(S.UpdateBatchBody) }, responses: { 200: ok(S.Batch, 'Updated', true), ...problems(...WRITE_PROBLEMS) } }),

  finishBatch: createRoute({ method: 'post', path: '/scanner/batches/{batch_id}/finish', operationId: 'scannerFinishBatch', tags: ['scanner-batches'], summary: 'Finish the batch',
    description: 'Refused while any card is undecided: 409 `cards_undecided` with `count` and `first_card_id`. Never auto-drops. 409 `no_cards` for an empty batch.',
    request: { ...W, params: BatchParams }, responses: { 200: ok(S.FinishSummary, 'Finished; the finish-screen summary', true), ...problems(...WRITE_PROBLEMS) } }),

  reopenBatch: createRoute({ method: 'post', path: '/scanner/batches/{batch_id}/reopen', operationId: 'scannerReopenBatch', tags: ['scanner-batches'], summary: 'Reopen your own finished batch', description: 'No admin send-back. 409 `not_finished`, `batch_processed` or `open_batch_exists`.',
    request: { ...W, params: BatchParams }, responses: { 200: ok(S.Batch, 'Open again', true), ...problems(...WRITE_PROBLEMS) } }),

  markBatchProcessed: createRoute({ method: 'post', path: '/scanner/batches/{batch_id}/processed', operationId: 'scannerMarkBatchProcessed', tags: ['scanner-batches'], summary: 'Mark as Processed', description: 'Scope `batches:process` (admin). 409 `not_finished` while open.',
    request: { ...W, params: BatchParams }, responses: { 200: ok(S.Batch, 'Processed', true), ...problems(...WRITE_PROBLEMS) } }),

  listBatchEvents: createRoute({ method: 'get', path: '/scanner/batches/{batch_id}/events', operationId: 'scannerListBatchEvents', tags: ['scanner-sync'], summary: 'Events in order', description: 'For resume and other devices. `after_seq` filters; `cursor` pages.',
    request: { params: BatchParams, query: z.object({ after_seq: z.coerce.number().int().min(0).default(0).openapi({ param: { name: 'after_seq', in: 'query' } }), limit: z.coerce.number().int().min(1).max(500).default(200).openapi({ param: { name: 'limit', in: 'query' } }), cursor: CursorParam }) },
    responses: { 200: ok(EventList, 'Events'), ...problems(400, 401, 403, 404) } }),

  appendBatchEvents: createRoute({ method: 'post', path: '/scanner/batches/{batch_id}/events', operationId: 'scannerAppendBatchEvents', tags: ['scanner-sync'], summary: 'Send the offline outbox (up to 200 events)',
    description: "Each event's `client_event_id` is its own idempotency key; a replay acks the first `seq`. Devices may send edits, decisions, drawer opens, photo counts, renames and notes. Cards are only made by the server and batch status only changes through its own route, so those come back in `rejected` as `route_only`.",
    request: { ...W, params: BatchParams, body: jsonBody(S.AppendEventsBody) }, responses: { 200: ok(S.AppendEventsResponse, 'Per-event acks and rejections'), ...problems(400, 401, 403, 404, 409, 413, 415, 422) } }),

  listDrawers: createRoute({ method: 'get', path: '/scanner/batches/{batch_id}/drawers', operationId: 'scannerListDrawers', tags: ['scanner-drawers'], summary: 'Drawer rows with counts', description: 'In the order first opened.',
    request: { params: BatchParams, query: z.object({ limit: LimitParam, cursor: CursorParam }) }, responses: { 200: ok(DrawerList, 'Drawers'), ...problems(400, 401, 403, 404) } }),

  openDrawer: createRoute({ method: 'post', path: '/scanner/batches/{batch_id}/drawers', operationId: 'scannerOpenDrawer', tags: ['scanner-drawers'], summary: 'Open a drawer by its label',
    description: 'Case-insensitive, saved UPPER case. The code comes from the barcode reader, the printed-text read, or typing (all in the browser). A drawer already in the batch becomes current again (200).',
    request: { ...W, params: BatchParams, body: jsonBody(S.OpenDrawerBody) }, responses: { 200: ok(S.Drawer, 'Already in the batch; current again', true), 201: ok(S.Drawer, 'New drawer, now current', true), ...problems(...WRITE_PROBLEMS) } }),

  recordPhoto: createRoute({ method: 'post', path: '/scanner/batches/{batch_id}/photos', operationId: 'scannerRecordPhoto', tags: ['scanner-photos'], summary: 'Record a photo after the box check', description: 'Counts only, never image data.',
    request: { ...W, params: BatchParams, body: jsonBody(S.RecordPhotoBody) }, responses: { 201: ok(S.Photo, 'Recorded', true), ...problems(...WRITE_PROBLEMS) } }),

  listCards: createRoute({ method: 'get', path: '/scanner/batches/{batch_id}/cards', operationId: 'scannerListCards', tags: ['scanner-cards'], summary: 'The card queue', description: 'Drawer order, then the order added; part-out pieces right under their fig. `state=undecided` = every state that still needs a decision.',
    request: { params: BatchParams, query: z.object({ state: z.enum(['undecided', 'decided', ...S.CardState.options]).optional().openapi({ param: { name: 'state', in: 'query' } }), drawer: z.string().max(40).optional().openapi({ param: { name: 'drawer', in: 'query' }, description: 'Drawer code, any case' }), limit: LimitParam, cursor: CursorParam, 'include[]': IncludeQuery }) },
    responses: { 200: ok(CardList, 'A page of cards'), ...problems(400, 401, 403, 404) } }),

  createCard: createRoute({ method: 'post', path: '/scanner/batches/{batch_id}/cards', operationId: 'scannerCreateCard', tags: ['scanner-cards'], summary: 'Send one crop; the server names it and makes a card',
    description: 'The crop (max 300 KB) is named by the free recognizer tier on the server, held in memory for that one call and never stored. Top score below 0.70, or the top two within 0.05, gives `check_by_hand` with no pre-pick. Recognizer trouble is never turned into "no match": the card is saved as `error` (so Retry works) and the answer is a real error (429 / 502 / 504) carrying `card_id`. Our own cap (100 per hour per person) gives 429 `rate_limited` and makes no card.',
    request: { ...W, params: BatchParams, body: { required: true, content: { 'multipart/form-data': { schema: S.CreateCardForm } } } },
    responses: { 201: ok(S.Card, 'Card made and named', true), ...problems(400, 401, 403, 404, 409, 413, 422, 429, 502, 503, 504) } }),

  getCard: createRoute({ method: 'get', path: '/scanner/cards/{card_id}', operationId: 'scannerGetCard', tags: ['scanner-cards'], summary: 'One card', description: 'Readable by whoever can read its batch.',
    request: { params: CardParams, query: z.object({ 'include[]': IncludeQuery }) }, responses: { 200: ok(S.Card, 'The card'), ...problems(400, 401, 403, 404) } }),

  updateCard: createRoute({ method: 'patch', path: '/scanner/cards/{card_id}', operationId: 'scannerUpdateCard', tags: ['scanner-cards'], summary: 'Qty, color, pick, part number, note',
    description: 'Every change is one `card.edited` event, so color corrections are logged. Colors are limited to colors that exist for the part. An alternate part number maps to the main number. Decided cards must be reopened first (409 `card_decided`).',
    request: { ...W, params: CardParams, body: jsonBody(S.UpdateCardBody) }, responses: { 200: ok(S.Card, 'Updated', true), ...problems(...WRITE_PROBLEMS) } }),

  retryIdentify: createRoute({ method: 'post', path: '/scanner/cards/{card_id}/identify', operationId: 'scannerRetryIdentify', tags: ['scanner-cards'], summary: 'Retry naming after a recognizer error', description: 'Send the same crop again. 409 `retry_not_needed` unless the card is in `error`.',
    request: { ...W, params: CardParams, body: { required: true, content: { 'multipart/form-data': { schema: S.RetryIdentifyForm } } } },
    responses: { 200: ok(S.Card, 'Named', true), ...problems(400, 401, 403, 404, 409, 413, 422, 429, 502, 503, 504) } }),

  decideCard: createRoute({ method: 'post', path: '/scanner/cards/{card_id}/decision', operationId: 'scannerDecideCard', tags: ['scanner-cards'], summary: 'Approve, Drop, Set aside, or Unknown',
    description: "Allowed choices are in the card's `allowed_decisions`. Drop needs no confirm and no reason. A Parts We Need find only allows `set_aside`. Anything else is 409 `decision_not_allowed`.",
    request: { ...W, params: CardParams, body: jsonBody(S.DecisionBody) }, responses: { 200: ok(S.Card, 'Decided', true), ...problems(...WRITE_PROBLEMS) } }),

  reopenCard: createRoute({ method: 'post', path: '/scanner/cards/{card_id}/reopen', operationId: 'scannerReopenCard', tags: ['scanner-cards'], summary: 'Undo a decision', description: 'The Undo row after Drop, or reopening a done row.',
    request: { ...W, params: CardParams }, responses: { 200: ok(S.Card, 'Undecided again', true), ...problems(...WRITE_PROBLEMS) } }),

  partOutFig: createRoute({ method: 'post', path: '/scanner/cards/{card_id}/part-out', operationId: 'scannerPartOutFig', tags: ['scanner-minifigs'], summary: 'Part out a minifig', description: "The pieces become their own cards right under the fig. Leave `pieces` out to use the fig's known pieces.",
    request: { ...W, params: CardParams, body: jsonBody(S.PartOutBody, false) }, responses: { 201: ok(S.PartOutResult, 'The fig (now parted_out) and its piece cards', true), ...problems(...WRITE_PROBLEMS) } }),

  holdFig: createRoute({ method: 'post', path: '/scanner/cards/{card_id}/hold', operationId: 'scannerHoldFig', tags: ['scanner-minifigs'], summary: 'Hold a minifig that is missing a piece', description: 'Decision `set_aside` with `held` true; shows on the admin Held figs list; left out of export.',
    request: { ...W, params: CardParams, body: jsonBody(S.HoldBody) }, responses: { 200: ok(S.Card, 'Held', true), ...problems(...WRITE_PROBLEMS) } }),

  needHelp: createRoute({ method: 'post', path: '/scanner/cards/{card_id}/need-help', operationId: 'scannerNeedHelp', tags: ['scanner-cards'], summary: 'Unknown part: Need help in one tap', description: 'Decision `unknown` with the help text. No tracking. Posting to the team help feed is a platform hook, not built here.',
    request: { ...W, params: CardParams, body: jsonBody(S.NeedHelpBody) }, responses: { 200: ok(S.Card, 'Marked unknown', true), ...problems(...WRITE_PROBLEMS) } }),

  createExport: createRoute({ method: 'post', path: '/scanner/batches/{batch_id}/exports', operationId: 'scannerCreateExport', tags: ['scanner-exports'], summary: 'Make an export (BSX, CSV or JSON)',
    description: 'Scope `exports:create` (admin only for staff). Approved cards only, one lot per drawer + type + part + color + condition. Dropped, set-aside (incl. Parts We Need), unknown, held and parted-out cards are left out. BSX: XML lot list, `Remarks` = drawer code, `Comments` = card note, no Price or Cost. Never overwrites: each export gets its own file name. 409 `not_finished` while open.',
    request: { ...W, params: BatchParams, body: jsonBody(S.CreateExportBody) }, responses: { 201: ok(S.Export, 'Export ready', true), ...problems(...WRITE_PROBLEMS) } }),

  getExport: createRoute({ method: 'get', path: '/scanner/exports/{export_id}', operationId: 'scannerGetExport', tags: ['scanner-exports'], summary: 'One export', description: 'Scope `exports:create`.',
    request: { params: ExportParams }, responses: { 200: ok(S.Export, 'The export'), ...problems(400, 401, 403, 404) } }),

  downloadExport: createRoute({ method: 'get', path: '/scanner/exports/{export_id}/file', operationId: 'scannerDownloadExport', tags: ['scanner-exports'], summary: 'Download the file', description: "Rebuilt from the event list up to the export's sequence number, so it is always the same file. Scope `exports:create`.",
    request: { params: ExportParams },
    responses: { 200: { description: 'The file', headers: { 'Content-Disposition': { schema: { type: 'string' }, description: 'attachment; filename="scan-<batch>-YYYYMMDD-HHMM.<ext>" (Chicago time)' } },
      content: { 'application/xml': { schema: z.string() }, 'text/csv': { schema: z.string() }, 'application/json': { schema: S.ExportJson } } }, ...problems(400, 401, 403, 404) } }),

  listFinds: createRoute({ method: 'get', path: '/scanner/finds', operationId: 'scannerListFinds', tags: ['scanner-finds'], summary: 'Admin lists: held figs, Parts We Need found', description: 'Scope `batches:read_all`. Newest first.',
    request: { query: z.object({ type: z.enum(['held', 'parts_we_need']).openapi({ param: { name: 'type', in: 'query' } }), limit: LimitParam, cursor: CursorParam }) },
    responses: { 200: ok(FindList, 'Finds'), ...problems(400, 401, 403) } }),

  getSpec: createRoute({ method: 'get', path: '/scanner/openapi.json', operationId: 'scannerGetSpec', tags: ['scanner-meta'], summary: 'This contract as JSON', description: 'The scanner part of the platform spec (DRAFT 1).',
    responses: { 200: ok(z.object({}).passthrough(), 'OpenAPI 3.1 document'), ...problems(400, 401, 403) } }),
};
