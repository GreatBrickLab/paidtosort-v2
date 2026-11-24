// Platform shell conventions (src/platform): error contract, request ids, JSON logs, validation, 404/405.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type H, setup } from './helpers/harness';

let h: H;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h.close(); });

test('unknown route → 404 problem+json with request_id = x-request-id', async () => {
  const r = await h.call('sorterA', 'GET', '/scanner/nope');
  expect(r.status).toBe(404); expect(r.headers.get('content-type')).toBe('application/problem+json');
  expect(r.json).toMatchObject({ code: 'not_found', status: 404, type: 'https://paidtosort.com/problems/not-found' });
  expect(r.json.request_id).toBe(r.headers.get('x-request-id'));
});
test('known path, wrong method → 405 method_not_allowed', async () => {
  const r = await h.call('sorterA', 'DELETE', '/scanner/batches');
  expect(r.status).toBe(405); expect(r.json.code).toBe('method_not_allowed');
});
test('bad body → 400 invalid_request with errors[]; unknown fields are refused', async () => {
  const a = await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'X' } });
  expect(a.status).toBe(400); expect(a.json.code).toBe('invalid_request'); expect(a.json.errors[0].field).toBe('json.condition');
  const b = await h.call('sorterA', 'POST', '/scanner/batches', { body: { condition: 'U', owner_user_id: 'usr_someone_else' } });
  expect(b.status).toBe(400); expect(b.json.code).toBe('invalid_request');
});
test('bad cursor → 400 invalid_request', async () => {
  const r = await h.call('sorterA', 'GET', '/scanner/batches?cursor=%%%');
  expect(r.status).toBe(400);
});
test('one JSON log line per request with the required fields, and never the key', async () => {
  h.logs.length = 0;
  const r = await h.call('sorterA', 'GET', '/scanner/me');
  const line = h.logs.find((l) => l.request_id === r.headers.get('x-request-id'))!;
  expect(line).toMatchObject({ method: 'GET', path: '/api/v1/scanner/me', status: 200 });
  expect(typeof line.ms).toBe('number'); expect(line.route).toBeTruthy();
  expect(JSON.stringify(h.logs)).not.toContain(h.tokenOf.sorterA);
});
