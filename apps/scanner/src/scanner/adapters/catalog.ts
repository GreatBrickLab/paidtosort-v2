// Parts and Orders catalog feed, behind an interface. The real feed (names, valid colors, alternates, mold variants,
// values from BrickStore, stock, Parts We Need) is owned by Parts and Orders and is NOT read here. This WIP ships a
// tiny made-up fixture so every rule can be tested. Nothing here calls BrickLink, Bricqer or any other service.
import fixture from '../../../fixtures/catalog.json';

export interface CatalogPart { name: string; colors: number[]; mold_variants?: string[]; pieces?: { part_no: string; color_id: number; qty: number }[] }
export interface Catalog {
  part(partNo: string): CatalogPart | null;
  /** Alternate id → main number ("Edit part number" maps alternates). */
  mainNumber(partNo: string): string;
  colorName(colorId: number): string;
  validColors(partNo: string): number[];
  value(partNo: string, colorId: number | null): number | null;
  inStock(partNo: string, colorId: number | null): boolean;
  isWanted(partNo: string, colorId: number | null): boolean;
  figPieces(figNo: string): { part_no: string; color_id: number; qty: number }[];
}

type Fixture = {
  colors: Record<string, string>; parts: Record<string, CatalogPart>; alternates: Record<string, string>;
  values: Record<string, number>; in_stock: string[]; wanted: string[];
};

export class FixtureCatalog implements Catalog {
  private stock: Set<string>; private wanted: Set<string>;
  constructor(private f: Fixture = fixture as Fixture) { this.stock = new Set(f.in_stock); this.wanted = new Set(f.wanted); }
  part(p: string) { return this.f.parts[p] ?? null; }
  mainNumber(p: string) { return this.f.alternates[p] ?? p; }
  colorName(id: number) { return this.f.colors[String(id)] ?? ''; }
  validColors(p: string) { return this.f.parts[p]?.colors ?? []; }
  value(p: string, c: number | null) { const v = this.f.values[`${p}|${c ?? 0}`]; return typeof v === 'number' ? v : null; }
  inStock(p: string, c: number | null) { return this.stock.has(`${p}|${c ?? 0}`); }
  isWanted(p: string, c: number | null) { return c !== null && this.wanted.has(`${p}|${c}`); }
  figPieces(f: string) { return this.f.parts[f]?.pieces ?? []; }
}
