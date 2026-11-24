// Shared paging (#13): `limit` + opaque `cursor` in, {object:"list", data, has_more, next_cursor} out.
import { z } from '@hono/zod-openapi';
import { problem } from './problem';

export const LimitParam = z.coerce.number().int().min(1).max(100).default(50).openapi({ param: { name: 'limit', in: 'query' }, example: 50 });
export const CursorParam = z.string().max(200).optional().openapi({ param: { name: 'cursor', in: 'query' }, description: 'Opaque cursor from `next_cursor`' });

const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
export const encodeCursor = (v: Record<string, string | number>) => b64u(JSON.stringify(v));
export function decodeCursor(c: string | undefined): Record<string, string | number> | null {
  if (!c) return null;
  try { const v = JSON.parse(unb64u(c)); if (v && typeof v === 'object') return v; } catch { /* fallthrough */ }
  throw problem(400, 'invalid_request', { errors: [{ field: 'cursor', message: 'Not a cursor from this API' }] });
}

export const listOf = <T extends z.ZodTypeAny>(item: T, name: string) => z.object({
  object: z.literal('list'), data: z.array(item), has_more: z.boolean(), next_cursor: z.string().nullable(),
}).openapi(name);
