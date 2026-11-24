// One batch = one append-only event list. State = reduce(events). This module is the ONLY place card states, counts,
// lots, Finish rules and summaries are worked out (ideas from part-scanner-v2-wip shared/reducer.js, reviewed Nov 24 2026,
// rewritten for snake_case server events). Pure: never mutates its input.
import type { Catalog } from './adapters/catalog';
import type { Candidate } from './adapters/recognizer';
import { normDrawer } from './names';

export const LOW = 0.7;    // below this → Check by hand (DECISIONS R2)
export const CLOSE = 0.05; // top two this close → Check by hand
export const DECISIONS = ['approved', 'dropped', 'set_aside', 'unknown'] as const;
export type Decision = (typeof DECISIONS)[number] | 'parted_out';
export const UNDECIDED_STATES = ['identifying', 'pending', 'check_by_hand', 'no_match', 'error'] as const;
export type CardState = (typeof UNDECIDED_STATES)[number] | Decision;
export const EVENT_TYPES = ['batch.created', 'batch.renamed', 'batch.noted', 'drawer.opened', 'photo.taken', 'card.added', 'card.updated',
  'card.edited', 'card.decided', 'card.reopened', 'batch.finished', 'batch.reopened', 'batch.exported', 'batch.processed'] as const;
export const CLIENT_EVENT_TYPES = new Set(['batch.renamed', 'batch.noted', 'drawer.opened', 'photo.taken', 'card.edited', 'card.decided', 'card.reopened']);

export interface Identify { status: 'ok' | 'none' | 'error' | 'identifying'; candidates?: Candidate[]; source?: 'recognizer' | 'part_out'; error_code?: string; retry_after_s?: number }
export interface StoredEvent { seq: number; type: string; payload: Record<string, any>; user_id: string; key_id?: string | null; device_id: string | null; at: string; client_event_id?: string }
export interface Card {
  id: string; photo_id: string | null; box: number | null; drawer: string; parent_card_id: string | null; kind: 'part' | 'fig';
  identify: Identify; pick: number | null; override: Candidate | null; qty: number; color_id: number | null; color_edited: boolean;
  note: string; decision: Decision | null; held: boolean; hold_reason: string | null; help_text: string | null;
  order: number; created_at: string; updated_at: string;
}
export interface Photo { id: string; number: number; drawer: string; boxes: number }
export interface Drawer { code: string; order: number }
export interface BatchState {
  batch: { id: string; name: string; condition: 'U' | 'N'; status: 'open' | 'finished' | 'processed'; owner_id: string; owner_name: string;
    note: string; created_at: string; finished_at: string | null; processed_at: string | null };
  drawers: Drawer[]; current_drawer: string | null; photos: Photo[]; cards: Card[]; exports: Record<string, any>[]; last_seq: number; updated_at: string;
}

export function reduce(batchId: string, events: StoredEvent[]): BatchState {
  const s: BatchState = {
    batch: { id: batchId, name: '', condition: 'U', status: 'open', owner_id: '', owner_name: '', note: '', created_at: '', finished_at: null, processed_at: null },
    drawers: [], current_drawer: null, photos: [], cards: [], exports: [], last_seq: 0, updated_at: '',
  };
  const byId = new Map<string, Card>();
  for (const e of events) {
    const p = e.payload || {};
    if (e.seq > s.last_seq) s.last_seq = e.seq;
    s.updated_at = e.at;
    const card = p.card_id ? byId.get(p.card_id) : undefined;
    if (card && e.type.startsWith('card.') && e.type !== 'card.added') card.updated_at = e.at;
    switch (e.type) {
      case 'batch.created':
        Object.assign(s.batch, { name: String(p.name || ''), condition: p.condition === 'N' ? 'N' : 'U', owner_id: e.user_id, owner_name: String(p.owner_name || ''), note: String(p.note || ''), created_at: e.at });
        break;
      case 'batch.renamed': if (p.name) s.batch.name = String(p.name).slice(0, 60); break;
      case 'batch.noted': s.batch.note = String(p.note ?? '').slice(0, 500); break;
      case 'drawer.opened': {
        const code = normDrawer(p.code); if (!code) break;
        if (!s.drawers.some((d) => d.code === code)) s.drawers.push({ code, order: s.drawers.length });
        s.current_drawer = code; break;
      }
      case 'photo.taken': {
        const drawer = normDrawer(p.drawer_code) ?? s.current_drawer; if (!drawer || !p.photo_id) break;
        s.photos.push({ id: String(p.photo_id), number: s.photos.length + 1, drawer, boxes: p.boxes | 0 }); break;
      }
      case 'card.added': {
        if (!p.card_id || byId.has(p.card_id)) break;
        const drawer = normDrawer(p.drawer_code) ?? s.current_drawer ?? '';
        const c: Card = { id: String(p.card_id), photo_id: p.photo_id ?? null, box: Number.isInteger(p.box) ? p.box : null, drawer,
          parent_card_id: p.parent_card_id ?? null, kind: p.kind === 'fig' ? 'fig' : 'part', identify: p.identify ?? { status: 'error', error_code: 'id_service_error' },
          pick: null, override: null, qty: Number.isInteger(p.qty) ? p.qty : 1, color_id: Number.isInteger(p.color_id) ? p.color_id : null,
          color_edited: Number.isInteger(p.color_id), note: '', decision: null, held: false, hold_reason: null, help_text: null,
          order: s.cards.length, created_at: e.at, updated_at: e.at };
        byId.set(c.id, c); s.cards.push(c); break;
      }
      case 'card.updated': if (card && p.identify) { card.identify = p.identify; card.pick = null; } break;
      case 'card.edited': {
        if (!card) break;
        if (p.field === 'qty') card.qty = Math.max(1, Math.min(9999, p.to | 0));
        if (p.field === 'color_id' && Number.isInteger(p.to)) { card.color_id = p.to; card.color_edited = true; }
        if (p.field === 'pick' && Number.isInteger(p.to) && p.to >= 0 && p.to < 5) { card.pick = p.to; card.override = null; }
        if (p.field === 'part_no' && typeof p.to === 'string') { card.override = { part_no: p.to, name: String(p.name ?? ''), item_type: p.item_type === 'M' ? 'M' : 'P', score: 1 }; card.pick = null; }
        if (p.field === 'note') card.note = String(p.to ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        break;
      }
      case 'card.decided':
        if (card && ([...DECISIONS, 'parted_out'] as string[]).includes(p.state)) {
          card.decision = p.state; card.held = p.held === true; card.hold_reason = card.held ? String(p.hold_reason ?? 'other') : null;
          card.help_text = p.help_text ? String(p.help_text).slice(0, 500) : null;
        }
        break;
      case 'card.reopened': if (card) { card.decision = null; card.held = false; card.hold_reason = null; card.help_text = null; } break;
      case 'batch.finished': s.batch.status = 'finished'; s.batch.finished_at = e.at; break;
      case 'batch.reopened': if (s.batch.status === 'finished') { s.batch.status = 'open'; s.batch.finished_at = null; } break;
      case 'batch.exported': s.exports.push({ ...p, created_at: e.at }); break;
      case 'batch.processed': s.batch.status = 'processed'; s.batch.processed_at = e.at; break;
      default: break;
    }
  }
  return s;
}

/** True when the recognizer isn't sure enough to pre-pick (top < 0.70, or top two within 0.05). */
export function needsHand(r: Identify): boolean {
  if (r.status !== 'ok' || !r.candidates?.length || r.source === 'part_out') return false;
  const [a, b] = r.candidates;
  return a.score < LOW || (b !== undefined && a.score - b.score < CLOSE);
}

export function chosen(c: Card): Candidate | null {
  if (c.override) return c.override;
  if (c.identify.status !== 'ok' || !c.identify.candidates?.length) return null;
  if (c.pick !== null) return c.identify.candidates[c.pick] ?? null;
  return needsHand(c.identify) ? null : c.identify.candidates[0];
}

export const itemType = (c: Card): 'P' | 'M' => chosen(c)?.item_type ?? (c.kind === 'fig' ? 'M' : 'P');

export function cardColorId(c: Card, cat: Catalog): number | null {
  if (itemType(c) === 'M') return 0;
  if (c.color_edited) return c.color_id;
  const p = chosen(c); if (!p) return null;
  return cat.validColors(p.part_no)[0] ?? null;
}

export function cardState(c: Card): CardState {
  if (c.decision) return c.decision;
  if (c.override) return 'pending';
  if (c.identify.status === 'identifying') return 'identifying';
  if (c.identify.status === 'error') return 'error';
  if (c.identify.status === 'none') return 'no_match';
  return chosen(c) ? 'pending' : 'check_by_hand';
}

export const isUndecided = (c: Card) => (UNDECIDED_STATES as readonly string[]).includes(cardState(c));
export const isWantedFind = (c: Card, cat: Catalog) => { const p = chosen(c); return !!p && itemType(c) === 'P' && cat.isWanted(p.part_no, cardColorId(c, cat)); };

/** Which decisions a card may take right now. The server checks every write against this. */
export function allowedDecisions(c: Card, cat: Catalog): (typeof DECISIONS)[number][] {
  const st = cardState(c);
  if (!isUndecided(c)) return [];
  if (st !== 'pending') return ['dropped', 'unknown']; // check_by_hand needs a pick; no_match/error/identifying can't be approved
  if (isWantedFind(c, cat)) return ['set_aside'];      // Parts We Need: celebrate, set aside, no Approve (Chris 3:27 PM)
  if (itemType(c) === 'P' && cardColorId(c, cat) === null) return ['dropped', 'set_aside', 'unknown'];
  return ['approved', 'dropped', 'set_aside', 'unknown'];
}

/** Drawer order first, then the order added; part-out pieces sit right under their fig. */
export function orderedCards(s: BatchState): Card[] {
  const rank = new Map(s.drawers.map((d) => [d.code, d.order]));
  const kids = new Map<string, Card[]>();
  const top: Card[] = [];
  for (const c of s.cards) { if (c.parent_card_id && s.cards.some((x) => x.id === c.parent_card_id)) { const k = kids.get(c.parent_card_id) ?? []; k.push(c); kids.set(c.parent_card_id, k); } else top.push(c); }
  top.sort((a, b) => (rank.get(a.drawer) ?? 1e9) - (rank.get(b.drawer) ?? 1e9) || a.order - b.order);
  const out: Card[] = [];
  const add = (c: Card) => { out.push(c); for (const k of kids.get(c.id) ?? []) add(k); };
  top.forEach(add);
  return out;
}

export interface Lot { key: string; drawer: string; item_type: 'P' | 'M'; part_no: string; name: string; color_id: number | null; color_name: string; condition: 'U' | 'N'; qty: number; note: string; card_ids: string[] }

/** Lots = approved cards grouped by drawer + type + part + color + condition. Everything not approved is left out. */
export function lots(s: BatchState, cat: Catalog): Lot[] {
  const out = new Map<string, Lot>();
  for (const c of orderedCards(s)) {
    if (cardState(c) !== 'approved') continue;
    const p = chosen(c); if (!p) continue;
    const t = itemType(c); const color = cardColorId(c, cat);
    const key = `${c.drawer}|${t}|${p.part_no}|${color ?? 'none'}|${s.batch.condition}`;
    const prev = out.get(key);
    if (prev) { prev.qty += c.qty; prev.card_ids.push(c.id); if (c.note && !prev.note.includes(c.note)) prev.note = (prev.note ? `${prev.note}; ${c.note}` : c.note).slice(0, 200); continue; }
    out.set(key, { key, drawer: c.drawer, item_type: t, part_no: p.part_no, name: p.name || cat.part(p.part_no)?.name || '', color_id: color,
      color_name: t === 'M' || color === null ? '' : cat.colorName(color), condition: s.batch.condition, qty: c.qty, note: c.note, card_ids: [c.id] });
  }
  return [...out.values()];
}

export const exportable = (l: Lot) => !!l.part_no && Number.isInteger(l.color_id) && l.qty >= 1;

export function mergesInto(s: BatchState, c: Card, cat: Catalog): string | null {
  const p = chosen(c); if (!p) return null;
  const key = `${c.drawer}|${p.part_no}|${cardColorId(c, cat)}`;
  for (const x of orderedCards(s)) {
    if (x.id === c.id) return null;
    const q = chosen(x);
    if (cardState(x) === 'approved' && q && `${x.drawer}|${q.part_no}|${cardColorId(x, cat)}` === key) return x.id;
  }
  return null;
}

export function batchValue(s: BatchState, cat: Catalog): number | null {
  const ls = lots(s, cat);
  if (!ls.length) return 0;
  let known = false; let sum = 0;
  for (const l of ls) { const v = cat.value(l.part_no, l.color_id); if (v !== null) { known = true; sum += v * l.qty; } }
  return known ? Math.round(sum * 100) / 100 : null;
}

export function counts(s: BatchState, cat: Catalog) {
  const k = { cards: s.cards.length, undecided: 0, decided: 0, approved: 0, dropped: 0, set_aside: 0, unknown: 0, parted_out: 0, held: 0,
    check_by_hand: 0, no_match: 0, error: 0, lots: 0, parts: 0, drawers: s.drawers.length, photos: s.photos.length };
  for (const c of s.cards) {
    const st = cardState(c);
    if (isUndecided(c)) k.undecided++; else k.decided++;
    if (st in k) (k as any)[st]++;
    if (c.held) k.held++;
  }
  const ls = lots(s, cat); k.lots = ls.length; k.parts = ls.reduce((n, l) => n + l.qty, 0);
  return k;
}

export const firstUndecided = (s: BatchState) => orderedCards(s).find(isUndecided) ?? null;

/** Admin lists (held figs, Parts We Need found), cached in the batch summary so the list needs no event scan. */
export function finds(s: BatchState, cat: Catalog) {
  const out: Record<string, unknown>[] = [];
  for (const c of s.cards) {
    const p = chosen(c);
    const base = { card_id: c.id, part_no: p?.part_no ?? null, name: p?.name || (p ? cat.part(p.part_no)?.name ?? '' : ''), color_id: cardColorId(c, cat), drawer_code: c.drawer, at: c.updated_at };
    if (c.held) out.push({ type: 'held', ...base, reason: c.hold_reason });
    else if (c.decision === 'set_aside' && isWantedFind(c, cat)) out.push({ type: 'parts_we_need', ...base, reason: null });
  }
  return out;
}

/** Server-side check for one device event against the state before it. null = allowed. */
export function rejectReason(s: BatchState, e: { type: string; payload: Record<string, any> }, cat: Catalog): string | null {
  if (!(EVENT_TYPES as readonly string[]).includes(e.type)) return 'unknown_event_type';
  if (!CLIENT_EVENT_TYPES.has(e.type)) return 'route_only';
  const st = s.batch.status; const p = e.payload || {};
  if (st === 'processed') return 'batch_processed';
  if (st === 'finished' && !['batch.renamed', 'batch.noted'].includes(e.type)) return 'batch_finished';
  if (e.type === 'batch.renamed' && !(typeof p.name === 'string' && p.name.trim() && p.name.length <= 60)) return 'bad_name';
  if (e.type === 'drawer.opened' && !normDrawer(p.code)) return 'bad_drawer_code';
  if (e.type === 'photo.taken') {
    if (!/^pho_[A-Za-z0-9]{10,32}$/.test(String(p.photo_id ?? ''))) return 'bad_photo_id';
    if (s.photos.some((x) => x.id === p.photo_id)) return 'duplicate_photo_id';
    if (!(Number.isInteger(p.boxes) && p.boxes >= 1 && p.boxes <= 200)) return 'bad_boxes';
    if (!normDrawer(p.drawer_code) && !s.current_drawer) return 'no_drawer_open';
  }
  if (e.type.startsWith('card.')) {
    const c = s.cards.find((x) => x.id === p.card_id);
    if (!c) return 'unknown_card';
    if (e.type === 'card.edited') {
      if (!['qty', 'color_id', 'pick', 'note'].includes(p.field)) return 'bad_field';
      if (p.field === 'color_id' && !(Number.isInteger(p.to) && validColor(c, p.to, cat))) return 'bad_color';
      if (p.field === 'pick' && !(Number.isInteger(p.to) && c.identify.candidates?.[p.to])) return 'bad_pick';
      if (p.field === 'qty' && !(Number.isInteger(p.to) && p.to >= 1 && p.to <= 9999)) return 'bad_qty';
      if (!isUndecided(c)) return 'card_decided';
    }
    if (e.type === 'card.decided' && !(allowedDecisions(c, cat) as string[]).includes(p.state)) return 'decision_not_allowed';
    if (e.type === 'card.decided' && (p.held || p.help_text)) return 'route_only';
    if (e.type === 'card.reopened' && isUndecided(c)) return 'not_decided';
  }
  return null;
}

export function validColor(c: Card, colorId: number, cat: Catalog): boolean {
  const p = chosen(c); if (!p) return false;
  const valid = cat.validColors(p.part_no);
  return valid.length === 0 ? colorId >= 0 : valid.includes(colorId);
}
