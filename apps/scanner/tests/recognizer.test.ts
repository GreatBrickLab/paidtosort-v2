// The Brickognize adapter with a FAKE fetch. No test ever calls the real service.
import { expect, test } from 'vitest';
import { BrickognizeRecognizer, mapBrickognize } from '../src/scanner/adapters/recognizer';

const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
const fake = (res: Response | Error) => (async () => { if (res instanceof Error) throw res; return res; }) as unknown as typeof fetch;
const R = (f: typeof fetch) => new BrickognizeRecognizer('https://example.invalid', 50, f);

test('ok answer → top candidates, sorted, figs as M', async () => {
  const r = await R(fake(Response.json({ items: [{ id: '3023', name: 'Plate 1 x 2', type: 'part', score: 0.5 }, { id: 'cty0001', name: 'Fig', type: 'fig', score: 0.9 }, { id: 'bad id!', score: 0.99 }] }))).identify(blob, { kind: 'part' });
  expect(r).toEqual({ status: 'ok', candidates: [{ part_no: 'cty0001', name: 'Fig', item_type: 'M', score: 0.9 }, { part_no: '3023', name: 'Plate 1 x 2', item_type: 'P', score: 0.5 }] });
});
test('empty list → none', async () => { expect(mapBrickognize({ items: [] })).toEqual({ status: 'none' }); });
test('429 → busy with Retry-After', async () => {
  expect(await R(fake(new Response('', { status: 429, headers: { 'Retry-After': '12' } }))).identify(blob, { kind: 'part' })).toEqual({ status: 'error', kind: 'busy', retry_after_s: 12, upstream_status: 429 });
});
test('5xx → error, 504 → timeout, network timeout → timeout, junk → error', async () => {
  expect((await R(fake(new Response('', { status: 500 }))).identify(blob, { kind: 'part' }))).toMatchObject({ status: 'error', kind: 'error', upstream_status: 500 });
  expect((await R(fake(new Response('', { status: 504 }))).identify(blob, { kind: 'part' }))).toMatchObject({ status: 'error', kind: 'timeout' });
  const t = Object.assign(new Error('t'), { name: 'TimeoutError' });
  expect((await R(fake(t)).identify(blob, { kind: 'part' }))).toMatchObject({ status: 'error', kind: 'timeout' });
  expect((await R(fake(new Response('not json', { status: 200 }))).identify(blob, { kind: 'part' }))).toMatchObject({ status: 'error', kind: 'error' });
});
test('figs go to the fig endpoint; the crop is sent as multipart and nothing else', async () => {
  let url = ''; let body: unknown;
  const f = (async (u: string, init: RequestInit) => { url = u; body = init.body; return Response.json({ items: [] }); }) as unknown as typeof fetch;
  await R(f).identify(blob, { kind: 'fig' });
  expect(url).toBe('https://example.invalid/predict/figs/');
  expect(body).toBeInstanceOf(FormData); expect([...(body as FormData).keys()]).toEqual(['query_image']);
});
