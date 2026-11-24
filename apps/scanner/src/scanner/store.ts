// D1 access. One event list per batch is the single source of truth; scan_batches holds the cached summary.
import type { StoredEvent } from './reducer';
import type { BatchRow } from './views';
import { MAX_EVENTS_PER_BATCH } from './limits';
import { problem } from '../platform/problem';

export interface NewEvent { client_event_id: string; type: string; payload: Record<string, unknown>; user_id: string; key_id: string | null; request_id: string | null; device_id: string | null; at: string }

/** A real write race (seq guard or UNIQUE): the caller may retry. */
export class Conflict extends Error {}

/**
 * Classifies a D1 error from a write. Rule violations (CHECK / NOT NULL / FOREIGN KEY) are the caller's problem and are
 * never retried: 422 `constraint_violation`. Only UNIQUE / PRIMARY KEY collisions are races (→ Conflict, retried).
 */
export function classifyDbError(e: unknown): never {
  const m = String((e as Error)?.message ?? e);
  if (/CHECK constraint failed|NOT NULL constraint failed|FOREIGN KEY constraint failed|cannot store .* value in .* column/i.test(m))
    throw problem(422, 'constraint_violation', { detail: 'A value broke a storage rule (for example a length or format limit). Nothing was saved.' });
  if (/UNIQUE constraint failed|PRIMARY KEY/i.test(m)) throw new Conflict('unique');
  throw e;
}

export class Store {
  constructor(private db: D1Database) {}

  getBatch(id: string) { return this.db.prepare('SELECT * FROM scan_batches WHERE id = ?').bind(id).first<BatchRow>(); }
  findOpenBatch(owner: string) { return this.db.prepare("SELECT * FROM scan_batches WHERE owner_user_id = ? AND status = 'open'").bind(owner).first<BatchRow>(); }

  async namesLike(owner: string, prefix: string) {
    const r = await this.db.prepare("SELECT name FROM scan_batches WHERE owner_user_id = ? AND name LIKE ? ESCAPE '\\'").bind(owner, `${prefix.replace(/[\\%_]/g, (m) => `\\${m}`)}%`).all<{ name: string }>();
    return r.results.map((x) => x.name);
  }

  async listBatches(o: { owner?: string; status?: string; statuses?: string[]; limit: number; startingAfter?: { created_at: string; id: string } | null }) {
    const where: string[] = []; const args: unknown[] = [];
    if (o.owner) { where.push('owner_user_id = ?'); args.push(o.owner); }
    if (o.status) { where.push('status = ?'); args.push(o.status); }
    if (o.statuses) { where.push(`status IN (${o.statuses.map(() => '?').join(',')})`); args.push(...o.statuses); }
    if (o.startingAfter) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(o.startingAfter.created_at, o.startingAfter.created_at, o.startingAfter.id); }
    const sql = `SELECT * FROM scan_batches ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const r = await this.db.prepare(sql).bind(...args, o.limit + 1).all<BatchRow>();
    return r.results;
  }

  /** Batches whose counts-only summary says they hold finds of this type (ADR 0009); the finds themselves come from events. */
  async batchesWithFinds(type: 'held' | 'parts_we_need') {
    const r = await this.db.prepare("SELECT * FROM scan_batches WHERE json_extract(summary_json, '$.finds_count.' || ?) > 0").bind(type).all<BatchRow>();
    return r.results;
  }

  async events(batchId: string, after = 0, limit = MAX_EVENTS_PER_BATCH + 1): Promise<StoredEvent[]> {
    const r = await this.db.prepare('SELECT seq, client_event_id, type, payload_json, user_id, key_id, device_id, at FROM scan_events WHERE batch_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .bind(batchId, after, limit).all<{ seq: number; client_event_id: string; type: string; payload_json: string; user_id: string; key_id: string | null; device_id: string | null; at: string }>();
    return r.results.map((x) => ({ seq: x.seq, client_event_id: x.client_event_id, type: x.type, payload: JSON.parse(x.payload_json), user_id: x.user_id, key_id: x.key_id, device_id: x.device_id, at: x.at }));
  }

  async findCreateByKey(user: string, key: string) {
    return this.db.prepare("SELECT batch_id, payload_json FROM scan_events WHERE user_id = ? AND client_event_id = ? AND type = 'batch.created'").bind(user, key).first<{ batch_id: string; payload_json: string }>();
  }

  async cardBatch(cardId: string) {
    const r = await this.db.prepare("SELECT batch_id FROM scan_events WHERE json_extract(payload_json, '$.card_id') = ? AND type = 'card.added'").bind(cardId).first<{ batch_id: string }>();
    return r?.batch_id ?? null;
  }

  async exportEvent(exportId: string) {
    return this.db.prepare("SELECT batch_id, payload_json, at FROM scan_events WHERE json_extract(payload_json, '$.export_id') = ? AND type = 'batch.exported'").bind(exportId).first<{ batch_id: string; payload_json: string; at: string }>();
  }

  /**
   * G2: reserves one recognizer call BEFORE it is made, in ONE statement (atomic in D1/SQLite), so concurrent requests
   * can't all slip under the cap and failed calls still count. Returns true when the slot was taken.
   */
  async reserveIdentify(o: { user: string; at: string; requestId: string; minuteAgo: string; hourAgo: string; perMinute: number; perHour: number; globalPerMinute: number; globalPerHour: number;
    idempotencyKey: string; cropSha256: string }): Promise<number | null> {
    const r = await this.db.prepare(`INSERT INTO scan_identify_calls (user_id, at, request_id, idempotency_key, crop_sha256)
      SELECT ?1, ?2, ?3, ?10, ?11
      WHERE (SELECT COUNT(*) FROM scan_identify_calls WHERE user_id = ?1 AND at > ?4) < ?6
        AND (SELECT COUNT(*) FROM scan_identify_calls WHERE user_id = ?1 AND at > ?5) < ?7
        AND (SELECT COUNT(*) FROM scan_identify_calls WHERE at > ?4) < ?8
        AND (SELECT COUNT(*) FROM scan_identify_calls WHERE at > ?5) < ?9`)
      .bind(o.user, o.at, o.requestId, o.minuteAgo, o.hourAgo, o.perMinute, o.perHour, o.globalPerMinute, o.globalPerHour, o.idempotencyKey, o.cropSha256).run()
      .catch(classifyDbError);
    return (r.meta.changes ?? 0) === 1 ? Number(r.meta.last_row_id) : null;
  }

  /** The naming result already obtained for this caller + Idempotency-Key + crop, so a retry never calls the recognizer twice. */
  async cachedIdentify(user: string, idempotencyKey: string, cropSha256: string): Promise<string | null> {
    const r = await this.db.prepare('SELECT result_json FROM scan_identify_calls WHERE user_id = ? AND idempotency_key = ? AND crop_sha256 = ? AND result_json IS NOT NULL ORDER BY id DESC LIMIT 1')
      .bind(user, idempotencyKey, cropSha256).first<{ result_json: string }>();
    return r?.result_json ?? null;
  }
  async saveIdentifyResult(id: number, resultJson: string) {
    if (resultJson.length > 4000) return; // never block a naming on the cache; the CHECK would refuse it anyway
    await this.db.prepare('UPDATE scan_identify_calls SET result_json = ? WHERE id = ?').bind(resultJson, id).run().catch(classifyDbError);
  }

  /** Rate-row retention (7 days), bounded so it can run inside normal requests (Pages has no cron). Returns rows deleted. */
  async purgeIdentifyCalls(beforeIso: string, limit = 500) {
    const r = await this.db.prepare('DELETE FROM scan_identify_calls WHERE id IN (SELECT id FROM scan_identify_calls WHERE at < ? ORDER BY at LIMIT ?)').bind(beforeIso, limit).run();
    return r.meta.changes ?? 0;
  }

  /**
   * Batch retention (24 months after processed, or after the last update if never processed). Events are deleted BEFORE
   * their batch, in one D1 batch (there is a foreign key and no cascade). Bounded per call. Returns the batch ids deleted.
   */
  async purgeExpiredBatches(o: { processedBefore: string; untouchedBefore: string; limit?: number }) {
    const ids = (await this.db.prepare(`SELECT id FROM scan_batches WHERE (status = 'processed' AND processed_at < ?) OR (status <> 'processed' AND updated_at < ?) ORDER BY updated_at LIMIT ?`)
      .bind(o.processedBefore, o.untouchedBefore, o.limit ?? 20).all<{ id: string }>()).results.map((x) => x.id);
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    await this.db.batch([
      this.db.prepare(`DELETE FROM scan_events WHERE batch_id IN (${marks})`).bind(...ids),
      this.db.prepare(`DELETE FROM scan_batches WHERE id IN (${marks})`).bind(...ids),
    ]);
    return ids;
  }

  /** After a refused reservation: which window is full, and when its oldest call leaves it. */
  async identifyWindow(user: string | null, sinceIso: string) {
    const r = await (user
      ? this.db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM scan_identify_calls WHERE user_id = ? AND at > ?').bind(user, sinceIso)
      : this.db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM scan_identify_calls WHERE at > ?').bind(sinceIso)).first<{ n: number; oldest: string | null }>();
    return { n: r?.n ?? 0, oldest: r?.oldest ?? null };
  }

  async createBatch(row: BatchRow, ev: NewEvent) {
    await this.db.batch([
      this.db.prepare('INSERT INTO scan_batches (id, owner_user_id, name, condition, status, last_seq, summary_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(row.id, row.owner_user_id, row.name, row.condition, 'open', 1, row.summary_json, row.created_at, row.updated_at),
      this.insertEvent(row.id, 1, ev),
    ]).catch(classifyDbError);
  }

  private insertEvent(batchId: string, seq: number, e: NewEvent, guardSeq?: number) {
    const cols = '(batch_id, seq, client_event_id, type, payload_json, user_id, key_id, request_id, device_id, at)';
    const vals = [batchId, seq, e.client_event_id, e.type, JSON.stringify(e.payload), e.user_id, e.key_id, e.request_id, e.device_id, e.at];
    if (guardSeq === undefined) return this.db.prepare(`INSERT INTO scan_events ${cols} VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(...vals);
    return this.db.prepare(`INSERT INTO scan_events ${cols} SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT last_seq FROM scan_batches WHERE id = ?) = ?`).bind(...vals, batchId, guardSeq);
  }

  /** Appends events in one transaction, only if nobody else appended since `expectedSeq`. Throws Conflict otherwise. */
  async append(batchId: string, expectedSeq: number, evs: NewEvent[], patch: { summary_json: string; status: string; name: string; updated_at: string; finished_at: string | null; processed_at: string | null; processed_by?: string | null }) {
    const stmts = evs.map((e, i) => this.insertEvent(batchId, expectedSeq + 1 + i, e, expectedSeq));
    stmts.push(this.db.prepare('UPDATE scan_batches SET last_seq = ?, summary_json = ?, status = ?, name = ?, updated_at = ?, finished_at = ?, processed_at = ?, processed_by = COALESCE(?, processed_by) WHERE id = ? AND last_seq = ?')
      .bind(expectedSeq + evs.length, patch.summary_json, patch.status, patch.name, patch.updated_at, patch.finished_at, patch.processed_at, patch.processed_by ?? null, batchId, expectedSeq));
    let res: D1Result[];
    try { res = await this.db.batch(stmts); } catch (e) { classifyDbError(e); }
    if (!res[res.length - 1].meta.changes) throw new Conflict('seq');
  }
}
