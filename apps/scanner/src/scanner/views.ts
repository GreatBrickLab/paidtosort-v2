// JSON shapes the API returns. They must match openapi.yaml (the contract tests check every answer against it).
import type { Catalog } from './adapters/catalog';
import { CURRENCY, toCents } from '../platform/conventions';
import {
  type BatchState, type Card, allowedDecisions, batchValue, cardColorId, cardState, chosen, counts, finds, isWantedFind, itemType,
  lots, mergesInto,
} from './reducer';

export interface BatchRow {
  id: string; owner_user_id: string; name: string; condition: 'U' | 'N'; status: 'open' | 'finished' | 'processed'; last_seq: number;
  summary_json: string; created_at: string; updated_at: string; finished_at: string | null; processed_at: string | null; processed_by: string | null;
}

/** The cached summary stored in scan_batches.summary_json, rebuilt on every append. */
export function summaryOf(s: BatchState, cat: Catalog) {
  return { owner_name: s.batch.owner_name, note: s.batch.note, counts: counts(s, cat), estimated_value_cents: toCents(batchValue(s, cat)),
    current_drawer: s.current_drawer, exports: s.exports.length, finds: finds(s, cat) };
}

export function batchView(row: BatchRow) {
  const sum = JSON.parse(row.summary_json || '{}');
  return {
    id: row.id, object: 'batch' as const, name: row.name, status: row.status, condition: row.condition, note: sum.note ?? '',
    owner: { id: row.owner_user_id, name: sum.owner_name ?? '' }, counts: sum.counts, estimated_value_cents: sum.estimated_value_cents ?? null, currency: CURRENCY,
    current_drawer: sum.current_drawer ?? null, exports: sum.exports ?? 0, last_seq: row.last_seq, created_at: row.created_at,
    updated_at: row.updated_at, finished_at: row.finished_at, processed_at: row.processed_at,
  };
}

export function drawerViews(s: BatchState) {
  return s.drawers.map((d) => ({ object: 'drawer' as const, code: d.code, is_current: s.current_drawer === d.code, order: d.order,
    cards: s.cards.filter((c) => c.drawer === d.code).length, photos: s.photos.filter((p) => p.drawer === d.code).length }));
}

const RARE: [number, 'rare_20' | 'rare_5' | 'rare_1'][] = [[20, 'rare_20'], [5, 'rare_5'], [1, 'rare_1']];

export function cardView(s: BatchState, c: Card, cat: Catalog, opts: { values?: boolean } = {}) {
  const p = chosen(c); const t = itemType(c); const color = cardColorId(c, cat);
  const badges: string[] = [];
  if (p && t === 'P') {
    if (isWantedFind(c, cat)) badges.push('parts_we_need');
    else {
      if (!cat.inStock(p.part_no, color) && !mergesInto(s, c, cat)) badges.push('new_lot');
      if (!c.color_edited) badges.push('check_color');
      if (cat.part(p.part_no)?.mold_variants?.length) badges.push('check_mold');
      const v = cat.value(p.part_no, color);
      const tier = v === null ? undefined : RARE.find(([min]) => v >= min);
      if (tier) badges.push(tier[1]);
    }
  }
  const colors = p && t === 'P' ? cat.validColors(p.part_no).slice(0, 3).map((id) => ({ color_id: id, name: cat.colorName(id), score: null })) : [];
  let minifig = null;
  if (t === 'M' && p) {
    const fig = cat.value(p.part_no, 0);
    const pieces = cat.figPieces(p.part_no);
    const vals = pieces.map((x) => cat.value(x.part_no, x.color_id));
    const partOut = pieces.length && vals.every((v) => v !== null) ? Math.round(pieces.reduce((n, x, i) => n + x.qty * (vals[i] as number), 0) * 100) / 100 : null;
    minifig = { fig_value_cents: toCents(fig), part_out_value_cents: toCents(partOut), currency: CURRENCY, suggestion: fig === null || partOut === null ? null : fig >= partOut ? 'keep' : 'part_out' };
  }
  const photo = c.photo_id ? s.photos.find((x) => x.id === c.photo_id) : undefined;
  const identify: Record<string, unknown> = { status: c.identify.status };
  if (c.identify.candidates) identify.candidates = c.identify.candidates;
  if (c.identify.source) identify.source = c.identify.source;
  if (c.identify.error_code) identify.error_code = c.identify.error_code;
  if (c.identify.retry_after_s !== undefined) identify.retry_after_s = c.identify.retry_after_s;
  const out: Record<string, unknown> = {
    id: c.id, object: 'card', batch_id: s.batch.id, photo_id: c.photo_id, photo_number: photo?.number ?? null, box: c.box, drawer_code: c.drawer,
    parent_card_id: c.parent_card_id, item_type: t, state: cardState(c), identify, pick: c.pick, chosen: p, qty: c.qty, color_id: color,
    colors, note: c.note, badges, allowed_decisions: allowedDecisions(c, cat), held: c.held, hold_reason: c.hold_reason, help_text: c.help_text,
    merges_into: mergesInto(s, c, cat), minifig, created_at: c.created_at, updated_at: c.updated_at,
  };
  if (opts.values) { out.value_cents = p ? toCents(cat.value(p.part_no, color)) : null; out.currency = CURRENCY; }
  return out;
}

export function finishSummary(s: BatchState, cat: Catalog, row: BatchRow) {
  const ls = lots(s, cat);
  return { object: 'finish_summary' as const, batch: batchView(row), parts: ls.reduce((n, l) => n + l.qty, 0), lots: ls.length,
    drawers: s.drawers.length, new_lots: ls.filter((l) => !cat.inStock(l.part_no, l.color_id)).length,
    held_figs: s.cards.filter((c) => c.held).length, estimated_value_cents: toCents(batchValue(s, cat)), currency: CURRENCY };
}
