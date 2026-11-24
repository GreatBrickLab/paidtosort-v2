// THE CONTRACT (DRAFT 1). These zod schemas are the single source: `npm run spec` emits contract/openapi.json and
// contract/openapi.yaml from them, the server validates requests with them before any handler runs, the contract tests
// validate every response against the emitted file, and the docs page renders from it.
// Component names are prefixed "Scanner" so this spec can merge into pts-v2's /api/v1/openapi.json without clashes.
import { z } from '@hono/zod-openapi';

const id = (prefix: string, name: string, example: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{10,32}$`)).openapi(name, { example });
export const BatchId = id('bat', 'ScannerBatchId', 'bat_7Qm2xK9pLw3RtY8v');
export const CardId = id('crd', 'ScannerCardId', 'crd_91LxQ2mZr8TnVb4c');
export const PhotoId = id('pho', 'ScannerPhotoId', 'pho_Hn3kW8qZ2xPm5RtL');
export const ExportId = id('exp', 'ScannerExportId', 'exp_4RtYb8Nq2LmW9xKp');
export const DrawerCode = z.string().regex(/^[A-Z0-9][A-Z0-9 ._-]{0,23}$/).openapi('ScannerDrawerCode', { description: 'UPPER case. Typed or scanned codes match without regard to case.', example: 'TEST-A1' });
export const Timestamp = z.string().datetime().openapi('Timestamp', { description: 'UTC, ISO 8601', example: '2026-11-24T17:25:00Z' });
export const Cents = z.number().int().nullable();
/** Nullable reference that generates `oneOf: [$ref, {type: null}]` (zod-openapi's .nullable() on a registered schema emits a broken allOf). */
const orNull = <T extends z.ZodTypeAny>(t: T) => z.union([t, z.null()]);
export const Currency = z.literal('USD');
export const PartNo = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);

export const BatchStatus = z.enum(['open', 'finished', 'processed']).openapi('ScannerBatchStatus');
export const Condition = z.enum(['U', 'N']).openapi('ScannerCondition', { description: 'U = used, N = new' });
export const CardState = z.enum(['identifying', 'pending', 'check_by_hand', 'no_match', 'error', 'approved', 'dropped', 'set_aside', 'unknown', 'parted_out']).openapi('ScannerCardState');
export const Decision = z.enum(['approved', 'dropped', 'set_aside', 'unknown']).openapi('ScannerDecision');
export const Badge = z.enum(['new_lot', 'check_color', 'check_mold', 'rare_1', 'rare_5', 'rare_20', 'parts_we_need']).openapi('ScannerBadge');
export const Scope = z.enum(['scan:write', 'batches:read', 'batches:read_all', 'exports:create', 'batches:process']).openapi('ApiKeyScope');

export const Problem = z.object({
  type: z.string().url(), title: z.string(), status: z.number().int().min(400).max(599), code: z.string(),
  detail: z.string().optional(), instance: z.string().optional(), request_id: z.string(),
  need: z.string().optional().openapi({ description: 'Missing scope, or `owner`' }),
  batch_id: BatchId.optional(), card_id: CardId.optional(), first_card_id: CardId.optional(), count: z.number().int().optional(),
  retry_after_s: z.number().int().min(0).optional(), limit: z.union([z.enum(['hourly', 'minute']), z.number().int()]).optional(),
  errors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
}).passthrough().openapi('Problem', { description: 'RFC 9457 problem details with `code` and `request_id` extension members (one error contract, platform base #5)' });

export const Me = z.object({
  object: z.literal('me'),
  user: z.object({ id: z.string(), name: z.string(), role: z.enum(['sorter', 'team', 'admin']) }),
  key: z.object({ id: z.string().nullable(), mode: z.enum(['test', 'live']), scopes: z.array(Scope) }),
}).openapi('ScannerMe', { description: 'Echo of what the auth layer (owned by Accounts and Security) said about this caller.' });

export const Counts = z.object({
  cards: z.number().int(), undecided: z.number().int(), decided: z.number().int(), approved: z.number().int(), dropped: z.number().int(),
  set_aside: z.number().int(), unknown: z.number().int(), parted_out: z.number().int(), held: z.number().int(), check_by_hand: z.number().int(),
  no_match: z.number().int(), error: z.number().int(), lots: z.number().int(), parts: z.number().int(), drawers: z.number().int(), photos: z.number().int(),
}).openapi('ScannerBatchCounts');

export const Drawer = z.object({
  object: z.literal('drawer'), code: DrawerCode, is_current: z.boolean(), order: z.number().int(), cards: z.number().int(), photos: z.number().int(),
}).strict().openapi('ScannerDrawer');

export const Candidate = z.object({
  part_no: z.string(), name: z.string(), item_type: z.enum(['P', 'M']).openapi({ description: 'P = part, M = minifig' }), score: z.number().min(0).max(1),
}).openapi('ScannerCandidate');

export const Identify = z.object({
  status: z.enum(['ok', 'none', 'error', 'identifying']), candidates: z.array(Candidate).max(5).optional(),
  source: z.enum(['recognizer', 'part_out']).optional(), error_code: z.enum(['id_service_busy', 'id_service_error', 'id_service_timeout']).optional(),
  retry_after_s: z.number().int().min(0).optional(),
}).openapi('ScannerIdentify');

export const Color = z.object({ color_id: z.number().int().min(0), name: z.string(), score: z.number().min(0).max(1).nullable() }).openapi('ScannerColor');

export const Card = z.object({
  id: CardId, object: z.literal('card'), batch_id: BatchId, photo_id: orNull(PhotoId),
  photo_number: z.number().int().nullable().openapi({ description: 'For "Photo 1 · box 4"' }), box: z.number().int().min(1).nullable(),
  drawer_code: DrawerCode, parent_card_id: orNull(CardId), item_type: z.enum(['P', 'M']), state: CardState, identify: Identify,
  pick: z.number().int().min(0).max(4).nullable(), chosen: orNull(Candidate), qty: z.number().int().min(1).max(9999),
  color_id: z.number().int().min(0).nullable(), colors: z.array(Color).max(3).openapi({ description: 'Top 3 colors, limited to colors that exist for the part' }),
  note: z.string().max(200), badges: z.array(Badge), allowed_decisions: z.array(Decision), held: z.boolean(),
  hold_reason: z.enum(['missing_piece', 'other']).nullable(), help_text: z.string().nullable(),
  merges_into: orNull(CardId).openapi({ description: 'The earlier approved card this one adds to ("+2 to existing lot")' }),
  minifig: z.object({ fig_value_cents: Cents, part_out_value_cents: Cents, currency: Currency, suggestion: z.enum(['keep', 'part_out']).nullable() }).nullable()
    .openapi({ description: 'Minifig values are shown to everyone. null for parts.' }),
  value_cents: Cents.optional().openapi({ description: 'Per-part value, only with include[]=values (a sorter setting, off by default)' }),
  currency: Currency.optional(),
  created_at: Timestamp, updated_at: Timestamp,
}).strict().openapi('ScannerCard');

export const Batch = z.object({
  id: BatchId, object: z.literal('batch'), name: z.string().max(60), status: BatchStatus, condition: Condition, note: z.string().max(500),
  owner: z.object({ id: z.string(), name: z.string() }), counts: Counts,
  estimated_value_cents: Cents.openapi({ description: 'Batch value from Parts and Orders data, shown to everyone. null when unknown.' }), currency: Currency,
  current_drawer: orNull(DrawerCode), exports: z.number().int(), last_seq: z.number().int(), created_at: Timestamp, updated_at: Timestamp,
  finished_at: orNull(Timestamp), processed_at: orNull(Timestamp),
  drawers: z.array(Drawer).optional().openapi({ description: 'Only with expand[]=drawers' }),
  cards: z.array(Card).optional().openapi({ description: 'Only with expand[]=cards' }),
}).strict().openapi('ScannerBatch');

export const FinishSummary = z.object({
  object: z.literal('finish_summary'), batch: Batch, parts: z.number().int(), lots: z.number().int(), drawers: z.number().int(),
  new_lots: z.number().int(), held_figs: z.number().int(), estimated_value_cents: Cents, currency: Currency,
}).openapi('ScannerFinishSummary');

export const EventType = z.enum(['batch.created', 'batch.renamed', 'batch.noted', 'drawer.opened', 'photo.taken', 'card.added', 'card.updated', 'card.edited',
  'card.decided', 'card.reopened', 'batch.finished', 'batch.reopened', 'batch.exported', 'batch.processed']).openapi('ScannerEventType');
export const Event = z.object({
  id: z.string().regex(/^evt_/), seq: z.number().int().min(1), type: EventType, payload: z.record(z.string(), z.unknown()),
  user_id: z.string(), key_id: z.string().nullable(), device_id: z.string().nullable(), at: Timestamp,
}).openapi('ScannerEvent');

export const Photo = z.object({ id: PhotoId, object: z.literal('photo'), number: z.number().int().min(1), drawer_code: DrawerCode, boxes: z.number().int().min(1).max(200) }).strict().openapi('ScannerPhoto');

export const Export = z.object({
  id: ExportId, object: z.literal('export'), batch_id: BatchId, format: z.enum(['bsx', 'csv', 'json']),
  file_name: z.string().regex(/^scan-[a-z0-9-]+-\d{8}-\d{4}(-\d+)?\.(bsx|csv|json)$/), lots: z.number().int(),
  left_out: z.number().int().openapi({ description: 'Approved lots left out because a color or part number is missing' }),
  at_seq: z.number().int(), download_url: z.string(), created_at: Timestamp,
}).strict().openapi('ScannerExport');

export const ExportJson = z.object({
  object: z.literal('export_file'), batch: z.object({ id: BatchId, name: z.string(), condition: Condition }),
  lots: z.array(z.object({ part_no: z.string(), item_type: z.enum(['P', 'M']), color_id: z.number().int(), color_name: z.string(), name: z.string(),
    qty: z.number().int(), condition: Condition, drawer_code: DrawerCode, note: z.string() })),
}).openapi('ScannerExportFile');

export const Find = z.object({
  object: z.literal('find'), type: z.enum(['held', 'parts_we_need']), card_id: CardId, batch_id: BatchId, batch_name: z.string(),
  part_no: z.string().nullable(), name: z.string(), color_id: z.number().int().nullable(), drawer_code: DrawerCode, reason: z.string().nullable(), at: Timestamp,
}).openapi('ScannerFind');

export const PartOutResult = z.object({ object: z.literal('part_out'), fig: Card, pieces: z.array(Card) }).openapi('ScannerPartOutResult');

export const AppendEventsResponse = z.object({
  acks: z.array(z.object({ client_event_id: z.string(), seq: z.number().int(), replayed: z.boolean() })),
  rejected: z.array(z.object({ client_event_id: z.string(), reason: z.string() })), last_seq: z.number().int(),
}).openapi('ScannerAppendEventsResponse');

// ---- request bodies (strict: unknown fields are refused, platform base #12) ----
export const CreateBatchBody = z.object({ condition: Condition, note: z.string().max(500).optional() }).strict().openapi('ScannerCreateBatchRequest');
export const UpdateBatchBody = z.object({ name: z.string().trim().min(1).max(60).optional(), note: z.string().max(500).optional() }).strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send name or note' }).openapi('ScannerUpdateBatchRequest');
export const OpenDrawerBody = z.object({ code: z.string().min(1).max(40).openapi({ description: 'Any case; spaces trimmed', example: 'test-a1' }) }).strict().openapi('ScannerOpenDrawerRequest');
export const RecordPhotoBody = z.object({
  drawer_code: z.string().max(40).optional().openapi({ description: 'Defaults to the current drawer' }),
  boxes: z.number().int().min(1).max(200).openapi({ description: 'Boxes kept after Looks good' }),
}).strict().openapi('ScannerRecordPhotoRequest');
export const CardMeta = z.object({
  photo_id: PhotoId.optional(), box: z.number().int().min(1).max(200).optional(), drawer_code: z.string().max(40).optional(), kind: z.enum(['part', 'fig']).optional(),
}).strict();
const CropFile = z.custom<File>((v) => typeof File !== 'undefined' && v instanceof File, { message: 'crop must be an image file' })
  .openapi({ type: 'string', format: 'binary', description: 'One cropped part, max 300 KB. Held in memory for one call, never stored.' });
export const CreateCardForm = z.object({
  crop: CropFile,
  meta: z.string().max(2000).openapi({ description: 'JSON text: {"photo_id":"pho_…","box":4,"drawer_code":"test-a1","kind":"part"|"fig"}', example: '{"photo_id":"pho_Hn3kW8qZ2xPm5RtL","box":4}' }),
}).openapi('ScannerCreateCardForm');
export const RetryIdentifyForm = z.object({ crop: CropFile }).openapi('ScannerRetryIdentifyForm');
export const UpdateCardBody = z.object({
  qty: z.number().int().min(1).max(9999).optional(), color_id: z.number().int().min(0).optional(), pick: z.number().int().min(0).max(4).optional(),
  part_no: PartNo.optional(), note: z.string().max(200).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field' }).openapi('ScannerUpdateCardRequest');
export const DecisionBody = z.object({ state: Decision }).strict().openapi('ScannerDecisionRequest');
export const PartOutBody = z.object({
  pieces: z.array(z.object({ part_no: PartNo, color_id: z.number().int().min(0), qty: z.number().int().min(1).max(99).optional(), name: z.string().max(200).optional() }).strict()).min(1).max(50).optional(),
}).strict().openapi('ScannerPartOutRequest');
export const HoldBody = z.object({ reason: z.enum(['missing_piece', 'other']) }).strict().openapi('ScannerHoldRequest');
export const NeedHelpBody = z.object({ text: z.string().trim().min(1).max(500) }).strict().openapi('ScannerNeedHelpRequest');
export const CreateExportBody = z.object({ format: z.enum(['bsx', 'csv', 'json']) }).strict().openapi('ScannerCreateExportRequest');
export const AppendEventsBody = z.object({
  events: z.array(z.object({
    client_event_id: z.string().regex(/^[A-Za-z0-9_.:-]{8,200}$/),
    type: z.string().max(40).openapi({ description: 'Allowed from a device: batch.renamed, batch.noted, drawer.opened, photo.taken, card.edited, card.decided, card.reopened. Anything else comes back in `rejected`.' }),
    device_id: z.string().max(64).optional(), payload: z.record(z.string(), z.unknown()),
  }).strict()).min(1).max(200),
}).strict().openapi('ScannerAppendEventsRequest');
