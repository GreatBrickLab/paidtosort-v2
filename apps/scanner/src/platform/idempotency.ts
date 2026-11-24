// Idempotency-Key (#9, IETF draft): required on every POST/PATCH here. Missing → 400 idempotency_key_missing.
// Same key + different body → 422 idempotency_mismatch. Same key + same body → the original result, with
// `Idempotent-Replayed: true`. Storage: D1, never KV. The scanner keeps key + request hash in its own event rows
// (no extra table); a shared platform idempotency table can replace that later behind the same helpers.
import { z } from '@hono/zod-openapi';
import { canonical, sha256Hex } from './ids';

export const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
export const IdempotencyHeaders = z.object({
  'idempotency-key': z.string().regex(IDEMPOTENCY_RE).openapi({ description: 'Unique per logical write (UUID v4 is fine). Reuse it to retry safely.', example: '4b0c5e2a-1f7e-4c1a-9d3b-2b8f0a6c7d11' }),
});
export const requestHash = (method: string, path: string, body: unknown) => sha256Hex(`${method} ${path} ${canonical(body)}`);
export const REPLAY_HEADER = 'Idempotent-Replayed';
