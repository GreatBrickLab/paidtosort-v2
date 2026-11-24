// Batch names and drawer codes. Ideas from part-scanner-v2-wip/site/scanner-v2/js/shared/names.js (reviewed Nov 24 2026).
// Chris Nov 23 R1: auto names like "Sam 11-24-26", then " B", " C" the same day (America/Chicago date).
// Drawer codes are saved UPPER case and match without regard to case (P&O data rule; DECISIONS conflict #7).

export function dayStamp(at: Date | string, timeZone = 'America/Chicago'): string {
  const d = at instanceof Date ? at : new Date(at);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: '2-digit', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day}-${p.year}`;
}

export function firstName(name: string): string {
  return String(name || 'Sorter').trim().split(/\s+/)[0] || 'Sorter';
}

export function nextBatchName(name: string, at: Date | string, existing: string[]): string {
  const base = `${firstName(name)} ${dayStamp(at)}`;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 1; i < 26; i++) {
    const n = `${base} ${String.fromCharCode(65 + i)}`;
    if (!taken.has(n)) return n;
  }
  return `${base} ${existing.length + 1}`;
}

const DRAWER_RE = /^[A-Z0-9][A-Z0-9 ._-]{0,23}$/;
export function normDrawer(raw: unknown): string | null {
  const code = String(raw ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  return DRAWER_RE.test(code) ? code : null;
}

/** scan-<batch-slug>-YYYYMMDD-HHMM.<ext> in America/Chicago. */
export function exportFileName(batchName: string, at: Date | string, ext: string): string {
  const d = at instanceof Date ? at : new Date(at);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const slug = String(batchName || 'batch').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'batch';
  return `scan-${slug}-${p.year}${p.month}${p.day}-${p.hour}${p.minute}.${ext}`;
}
