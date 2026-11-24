// Export files built from reducer lots. Format follows v1 (staff-tools-step1/releases/web-20261123e-scanner-wip/site/js/part-scanner/lots.js
// toBSX/toCSV, and the v2 WIP shared/bsx.js), reviewed Nov 24 2026:
// - root <BrickStoreXML><Inventory Currency="USD">, one <Item> per lot, items grouped by drawer in the order drawers were opened
// - <Remarks> = drawer code only (UPPER case); the lot note goes to <Comments>, never <Remarks> (Web Boss merge, Chris + A&S)
// - minifigs: ItemTypeID M, ColorID 0, no ColorName
// - no <Price> and no <Cost> (v2 rule), Condition from the batch (U/N)
// Lots without a color or part number are left out and counted (Export.left_out).
import type { Lot } from './reducer';
import { exportable } from './reducer';

// eslint-disable-next-line no-control-regex
const BAD_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const xml = (s: unknown) => String(s ?? '').replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const csvCell = (v: unknown) => {
  const t = v === null || v === undefined ? '' : String(v);
  const f = /^[=+\-@\t\r]/.test(t); // spreadsheet formula guard
  return /[",\n\r]/.test(t) || f ? `"${(f ? "'" : '') + t.replace(/"/g, '""')}"` : t;
};

export function toBSX(lots: Lot[]): string {
  let o = '<?xml version="1.0" encoding="UTF-8"?>\n<BrickStoreXML>\n <Inventory Currency="USD">\n';
  for (const l of lots.filter(exportable)) {
    const fig = l.item_type === 'M';
    o += '  <Item>\n'
      + `   <ItemID>${xml(l.part_no)}</ItemID>\n   <ItemTypeID>${fig ? 'M' : 'P'}</ItemTypeID>\n   <ColorID>${fig ? 0 : l.color_id}</ColorID>\n`
      + (l.name ? `   <ItemName>${xml(l.name)}</ItemName>\n` : '')
      + (!fig && l.color_name ? `   <ColorName>${xml(l.color_name)}</ColorName>\n` : '')
      + `   <Qty>${l.qty}</Qty>\n   <Condition>${l.condition === 'N' ? 'N' : 'U'}</Condition>\n`
      + (l.drawer ? `   <Remarks>${xml(l.drawer)}</Remarks>\n` : '')
      + (l.note ? `   <Comments>${xml(l.note)}</Comments>\n` : '')
      + '  </Item>\n';
  }
  return o + ' </Inventory>\n</BrickStoreXML>\n';
}

export function toCSV(lots: Lot[]): string {
  const rows: unknown[][] = [['Drawer', 'Type', 'Part', 'Name', 'Color ID', 'Color', 'Condition', 'Quantity', 'Note']];
  for (const l of lots.filter(exportable)) rows.push([l.drawer, l.item_type === 'M' ? 'Minifig' : 'Part', l.part_no, l.name, l.item_type === 'M' ? 0 : l.color_id, l.color_name, l.condition, l.qty, l.note]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function toJSON(batch: { id: string; name: string; condition: 'U' | 'N' }, lots: Lot[]) {
  return { object: 'export_file' as const, batch, lots: lots.filter(exportable).map((l) => ({ part_no: l.part_no, item_type: l.item_type,
    color_id: l.item_type === 'M' ? 0 : (l.color_id as number), color_name: l.color_name, name: l.name, qty: l.qty, condition: l.condition,
    drawer_code: l.drawer, note: l.note })) };
}
