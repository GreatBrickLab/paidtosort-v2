// Part naming, server side only, behind one interface. The browser never calls a recognizer.
// - BrickognizeRecognizer: the free public tier only (Chris, Nov 24 7:34 AM: free options only). No paid features.
//   The crop is passed through in memory for this one call and never written anywhere.
// - NotConfiguredRecognizer: the shipped default when RECOGNIZER is not set; every naming call answers 503
//   `recognizer_not_configured`. The deterministic test stub lives in tests/helpers and is injected by tests only.
export interface Candidate { part_no: string; name: string; item_type: 'P' | 'M'; score: number }
export type RecognizerResult =
  | { status: 'ok'; candidates: Candidate[] }
  | { status: 'none' }
  | { status: 'error'; kind: 'busy' | 'error' | 'timeout'; retry_after_s?: number; upstream_status?: number };
export interface Recognizer { identify(crop: Blob, opts: { kind: 'part' | 'fig' }): Promise<RecognizerResult> }

const clamp01 = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null);
const PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** Maps a Brickognize-style JSON answer ({items:[{id,name,type,score}]}) to our shape. Exported for tests. */
export function mapBrickognize(json: unknown): RecognizerResult {
  const items = (json as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return { status: 'error', kind: 'error' };
  const candidates: Candidate[] = [];
  for (const it of items.slice(0, 5) as Record<string, unknown>[]) {
    const id = String(it?.id ?? ''); const score = clamp01(it?.score);
    if (!PART_RE.test(id) || score === null) continue;
    candidates.push({ part_no: id, name: String(it?.name ?? '').slice(0, 200), item_type: it?.type === 'fig' ? 'M' : 'P', score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? { status: 'ok', candidates } : { status: 'none' };
}

export class BrickognizeRecognizer implements Recognizer {
  constructor(private base = 'https://api.brickognize.com', private timeoutMs = 10_000, private fetchFn: typeof fetch = fetch) {}
  async identify(crop: Blob, opts: { kind: 'part' | 'fig' }): Promise<RecognizerResult> {
    const form = new FormData();
    form.append('query_image', crop, 'crop.jpg');
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/predict/${opts.kind === 'fig' ? 'figs' : 'parts'}/`, { method: 'POST', body: form, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const name = (e as Error)?.name;
      return { status: 'error', kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error' };
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('Retry-After'));
      return { status: 'error', kind: 'busy', retry_after_s: Number.isFinite(ra) && ra >= 0 ? Math.min(3600, Math.round(ra)) : 30, upstream_status: 429 };
    }
    if (res.status === 504) return { status: 'error', kind: 'timeout', upstream_status: 504 };
    if (!res.ok) return { status: 'error', kind: 'error', upstream_status: res.status };
    try { return mapBrickognize(await res.json()); } catch { return { status: 'error', kind: 'error', upstream_status: res.status }; }
  }
}


/** Shipped default: refuses to name anything (503 `recognizer_not_configured`) until A&S sets RECOGNIZER=brickognize. */
export class NotConfiguredRecognizer implements Recognizer {
  readonly notConfigured = true;
  async identify(): Promise<RecognizerResult> { throw new Error('recognizer not configured'); }
}
