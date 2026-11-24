// Part naming, server side only, behind one interface. The browser never calls a recognizer.
// - BrickognizeRecognizer: the free public tier only (Chris, Nov 24 7:34 AM: free options only). No paid features.
//   The crop is passed through in memory for this one call and never written anywhere.
// - StubRecognizer: deterministic answers for local dev and every automated test. Tests never hit the real service.
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

/**
 * Answers from the crop's own bytes, so tests and local dev are repeatable and free.
 * A crop whose text starts with "STUB:" picks the answer: busy[=s] | error | timeout | none | low | close | fig | part=<no>[,score=<n>]
 * Anything else → Plate 1 x 2 (3023) at 0.91.
 */
export class StubRecognizer implements Recognizer {
  public calls = 0;
  async identify(crop: Blob): Promise<RecognizerResult> {
    this.calls++;
    const head = new TextDecoder().decode(new Uint8Array(await crop.slice(0, 120).arrayBuffer()));
    const d = head.startsWith('STUB:') ? head.slice(5).split(/\s/)[0] : '';
    const ok = (cands: Candidate[]): RecognizerResult => ({ status: 'ok', candidates: cands });
    if (d.startsWith('busy')) return { status: 'error', kind: 'busy', retry_after_s: Number(d.split('=')[1] ?? 30) || 30, upstream_status: 429 };
    if (d === 'error') return { status: 'error', kind: 'error', upstream_status: 502 };
    if (d === 'timeout') return { status: 'error', kind: 'timeout', upstream_status: 504 };
    if (d === 'none') return { status: 'none' };
    if (d === 'low') return ok([{ part_no: '3001', name: 'Brick 2 x 4', item_type: 'P', score: 0.62 }, { part_no: '3005', name: 'Brick 1 x 1', item_type: 'P', score: 0.3 }, { part_no: '3023', name: 'Plate 1 x 2', item_type: 'P', score: 0.2 }]);
    if (d === 'close') return ok([{ part_no: '3001', name: 'Brick 2 x 4', item_type: 'P', score: 0.81 }, { part_no: '3005', name: 'Brick 1 x 1', item_type: 'P', score: 0.79 }]);
    if (d === 'fig') return ok([{ part_no: 'cty0001', name: 'Town Figure (test)', item_type: 'M', score: 0.93 }]);
    if (d.startsWith('part=')) {
      const kv = Object.fromEntries(d.split(',').map((x) => x.split('=')));
      return ok([{ part_no: kv.part, name: '', item_type: 'P', score: Number(kv.score ?? 0.95) }]);
    }
    return ok([{ part_no: '3023', name: 'Plate 1 x 2', item_type: 'P', score: 0.91 }]);
  }
}
