// Merges the generated scanner contract (apps/scanner/contract/openapi.json) into the platform spec (spec/openapi.json).
// Idempotent: scanner-owned parts are removed and re-added, everything else in the platform spec is left alone.
// Usage from the pts-v2 repo root:  node apps/scanner/scripts/merge-platform-spec.mjs [--check]
//   --check  exit 1 if spec/openapi.json is not up to date with the scanner contract (for CI).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scannerPath = resolve(here, '../contract/openapi.json');
const platformPath = resolve(process.env.PLATFORM_SPEC ?? resolve(here, '../../../spec/openapi.json'));
const scanner = JSON.parse(readFileSync(scannerPath, 'utf8'));
const before = readFileSync(platformPath, 'utf8');
const platform = JSON.parse(before);

// What the scanner owns in the merged spec.
const SHARED_SCHEMAS = ['Problem', 'Timestamp', 'ApiKeyScope']; // proposed for the platform; Web Boss may adopt them
const ownsPath = (p) => p.startsWith('/scanner/');
const ownsSchema = (n) => n.startsWith('Scanner') || SHARED_SCHEMAS.includes(n);
const ownsTag = (t) => t.startsWith('scanner-');

for (const p of Object.keys(platform.paths ?? {})) if (ownsPath(p)) delete platform.paths[p];
platform.components ??= {};
platform.components.schemas ??= {};
for (const n of Object.keys(platform.components.schemas)) if (n.startsWith('Scanner')) delete platform.components.schemas[n];

for (const n of SHARED_SCHEMAS) {
  const mine = scanner.components.schemas[n];
  const theirs = platform.components.schemas[n];
  if (!theirs) continue;
  const sameAsOurs = JSON.stringify(theirs) === JSON.stringify(mine) || theirs['x-owner'] === 'scanner';
  if (!sameAsOurs) {
    console.error(`merge: platform already defines a different "${n}" schema; not overwriting. Settle it with Web Boss.`);
    process.exit(2);
  }
  delete platform.components.schemas[n]; // ours: re-added below in a stable order
}
for (const [n, s] of Object.entries(scanner.components.schemas)) if (ownsSchema(n)) platform.components.schemas[n] = SHARED_SCHEMAS.includes(n) ? { ...s, 'x-owner': 'scanner' } : s;

platform.components.securitySchemes ??= {};
const scheme = scanner.components.securitySchemes.api_key;
const existing = platform.components.securitySchemes.api_key;
if (existing && JSON.stringify(existing) !== JSON.stringify(scheme) && existing['x-owner'] !== 'scanner') {
  console.error('merge: platform already defines a different "api_key" security scheme; not overwriting.');
  process.exit(2);
}
platform.components.securitySchemes.api_key = { ...scheme, 'x-owner': 'scanner' };

const globalSecurity = scanner.security ?? [{ api_key: [] }];
platform.paths ??= {};
for (const [p, item] of Object.entries(scanner.paths)) {
  if (!ownsPath(p)) throw new Error(`scanner path outside /scanner/: ${p}`);
  const copy = structuredClone(item);
  for (const op of Object.values(copy)) if (op && typeof op === 'object' && op.operationId) op.security ??= globalSecurity;
  platform.paths[p] = copy;
}

platform.tags = (platform.tags ?? []).filter((t) => !ownsTag(t.name)).concat(scanner.tags ?? []);

const after = JSON.stringify(platform, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (after !== before) { console.error('spec/openapi.json is out of date: run node apps/scanner/scripts/merge-platform-spec.mjs'); process.exit(1); }
  console.log('spec/openapi.json is up to date with the scanner contract');
} else {
  writeFileSync(platformPath, after);
  console.log(`merged ${Object.keys(scanner.paths).length} scanner paths into ${platformPath}`);
}
