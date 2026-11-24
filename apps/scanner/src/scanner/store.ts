// D1 access. One event list per batch is the single source of truth; scan_batches holds the cached summary.
import type { StoredEvent } from './reducer';
import type { BatchRow } from './views';

export interface NewEvent { client_event_id: string; type: string; payload: Record<string, unknown>; user_id: string; key_id: string | null; request_id: string | null; device_id: string | null; at: string }

export class Conflict extends Error {}

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

  async allBatchesWithFinds() {
    const r = await this.db.prepare(`SELECT * FROM scan_batches WHERE summary_json LIKE '%"type":"%'`).all<BatchRow>();
    return r.results;
  }

  async events(batchId: string, after = 0, limit = 100000): Promise<StoredEvent[]> {
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

  async recentIdentifies(user: string, sinceIso: string) {
    const r = await this.db.prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM scan_events WHERE user_id = ? AND at >= ? AND type IN ('card.added','card.updated') AND json_extract(payload_json, '$.identify_call') = 1")
      .bind(user, sinceIso).first<{ n: number; oldest: string | null }>();
    return { n: r?.n ?? 0, oldest: r?.oldest ?? null };
  }

  async createBatch(row: BatchRow, ev: NewEvent) {
    await this.db.batch([
      this.db.prepare('INSERT INTO scan_batches (id, owner_user_id, name, condition, status, last_seq, summary_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(row.id, row.owner_user_id, row.name, row.condition, 'open', 1, row.summary_json, row.created_at, row.updated_at),
      this.insertEvent(row.id, 1, ev),
    ]);
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
    try { res = await this.db.batch(stmts); } catch (e) {
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(String((e as Error)?.message))) throw new Conflict('constraint');
      throw e;
    }
    if (!res[res.length - 1].meta.changes) throw new Conflict('seq');
  }
}
