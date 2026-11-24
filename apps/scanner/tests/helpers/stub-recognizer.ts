// TEST ONLY. Deterministic answers driven by `STUB:<directive>` at the start of the crop bytes. Injected by the harness.
import type { Candidate, Recognizer, RecognizerResult } from '../../src/scanner/adapters/recognizer';

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
