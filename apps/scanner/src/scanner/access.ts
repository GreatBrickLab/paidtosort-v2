// Object-level access (OWASP API1, platform base #11 + BEST-PRACTICE-CHECK). Every scanner route goes through one of
// these after its scope check. A sorter only ever reaches their own batches; batches a key may not see are 404 (no leak).
import type { Context } from 'hono';
import { type Principal, hasScope, principalOf, requireScope } from '../platform/auth';
import { problem } from '../platform/problem';
import type { BatchRow } from './views';
import type { Store } from './store';

export function canRead(p: Principal, row: BatchRow): boolean {
  if (row.owner_user_id === p.user_id && hasScope(p, 'batches:read')) return true;
  return hasScope(p, 'batches:read_all'); // team/admin. A future partner role would add its own narrower rule here.
}

export async function readableBatch(c: Context, store: Store, batchId: string): Promise<{ p: Principal; row: BatchRow }> {
  const p = principalOf(c);
  if (!hasScope(p, 'batches:read') && !hasScope(p, 'batches:read_all')) throw problem(403, 'forbidden', { need: 'batches:read' });
  const row = await store.getBatch(batchId);
  if (!row || !canRead(p, row)) throw problem(404, 'not_found', { detail: 'No such batch' });
  return { p, row };
}

/** Writes to a batch: scope scan:write AND the caller owns the batch. */
export async function ownedBatch(c: Context, store: Store, batchId: string): Promise<{ p: Principal; row: BatchRow }> {
  requireScope(c, 'scan:write');
  const { p, row } = await readableBatch(c, store, batchId);
  if (row.owner_user_id !== p.user_id) throw problem(403, 'forbidden', { need: 'owner', detail: 'Only the sorter who owns this batch can change it.' });
  return { p, row };
}

/** Admin-style actions on someone's batch (export, processed): the scope first, then visibility. */
export async function scopedBatch(c: Context, store: Store, batchId: string, scope: 'exports:create' | 'batches:process') {
  requireScope(c, scope);
  return readableBatch(c, store, batchId);
}
