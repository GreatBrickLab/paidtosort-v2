// BrickStore BSX format (same shape v1 wrote and Bricqer imports): snapshot-locked.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { toBSX, toCSV, toJSON } from '../src/scanner/bsx';
import type { Lot } from '../src/scanner/reducer';
import { exportFileName } from '../src/scanner/names';
import { type H, addCard, batchWithDrawer, setup } from './helpers/harness';

const lot = (o: Partial<Lot>): Lot => ({ key: 'k', drawer: 'TEST-A1', item_type: 'P', part_no: '3001', name: 'Brick 2 x 4', color_id: 5, color_name: 'Red', condition: 'U', qty: 3, note: '', card_ids: [], ...o });

test('LOCK bsx-format snapshot: BrickStoreXML, Remarks = drawer, Comments = note, fig ColorID 0, no Price/Cost', () => {
  const out = toBSX([
    lot({}),
    lot({ part_no: '15573', name: 'Plate, Modified 1 x 2 with 1 Stud (Jumper)', color_id: 86, color_name: 'Light Bluish Gray', qty: 1, note: 'tan & "scuffed" <x>' }),
    lot({ drawer: 'TEST-B2', item_type: 'M', part_no: 'cty0001', name: 'Town Figure (test)', color_id: 0, color_name: '', qty: 1 }),
    lot({ part_no: '3005', color_id: null, color_name: '' }), // no color → left out
  ]);
  expect(out).toMatchSnapshot();
  expect(out).not.toMatch(/<Price>|<Cost>/);
  expect(out).toContain('<Remarks>TEST-A1</Remarks>');
  expect(out).toContain('<Comments>tan &amp; &quot;scuffed&quot; &lt;x&gt;</Comments>');
  expect(out).not.toContain('<ItemID>3005</ItemID>');
});

test('LOCK csv-formula-guard and JSON shape', () => {
  const csv = toCSV([lot({ note: '=HYPERLINK("x")' })]);
  expect(csv.split('\r\n')[0]).toBe('Drawer,Type,Part,Name,Color ID,Color,Condition,Quantity,Note');
  expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  expect(toJSON({ id: 'bat_x', name: 'n', condition: 'U' }, [lot({})]).lots[0]).toEqual({ part_no: '3001', item_type: 'P', color_id: 5, color_name: 'Red', name: 'Brick 2 x 4', qty: 3, condition: 'U', drawer_code: 'TEST-A1', note: '' });
});

test('file names: Chicago time, slugged batch name', () => {
  expect(exportFileName('Sam 11-24-26 B', '2026-11-24T17:31:00Z', 'bsx')).toBe('scan-sam-11-24-26-b-20261124-1131.bsx');
  expect(exportFileName('Sam', '2026-12-01T05:59:00Z', 'csv')).toBe('scan-sam-20261130-2359.csv');
});

let h: H;
beforeAll(async () => { h = await setup({ now: () => new Date('2026-11-24T17:31:00Z') }); });
afterAll(async () => { await h.close(); });
test('LOCK bsx-end-to-end snapshot from a real batch', async () => {
  const { batch } = await batchWithDrawer(h, 'sorterA', 'N');
  for (const d of ['part=3001,score=0.9', 'part=3001,score=0.9', '']) {
    const c = await addCard(h, batch.id, d);
    await h.call('sorterA', 'POST', `/scanner/cards/${c.json.id}/decision`, { body: { state: 'approved' } });
  }
  await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/drawers`, { body: { code: 'test-b2' } });
  const fig = await addCard(h, batch.id, 'fig');
  await h.call('sorterA', 'POST', `/scanner/cards/${fig.json.id}/decision`, { body: { state: 'approved' } });
  await h.call('sorterA', 'POST', `/scanner/batches/${batch.id}/finish`);
  const ex = await h.call('admin', 'POST', `/scanner/batches/${batch.id}/exports`, { body: { format: 'bsx' } });
  const file = await h.call('admin', 'GET', `/scanner/exports/${ex.json.id}/file`);
  expect(file.headers.get('content-type')).toMatch(/application\/xml/);
  expect(file.text).toMatchSnapshot();
});
