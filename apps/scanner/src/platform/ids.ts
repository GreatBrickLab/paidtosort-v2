// Opaque ids with a type prefix (platform base): bat_, crd_, pho_, exp_, evt_, key_, req_.
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function rand(n = 16): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return s;
}
export const newId = (prefix: 'bat' | 'crd' | 'pho' | 'exp' | 'req' | 'key') => `${prefix}_${rand()}`;
export const idPattern = (prefix: string) => new RegExp(`^${prefix}_[A-Za-z0-9]{10,32}$`);

export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const h = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Stable JSON (sorted keys) so the same body always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
