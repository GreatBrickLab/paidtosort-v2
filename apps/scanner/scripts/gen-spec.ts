// npm run spec → contract/openapi.json + contract/openapi.yaml, generated from the zod schemas (single source).
import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { generateSpec } from '../src/app';
const doc = generateSpec();
writeFileSync(new URL('../contract/openapi.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n');
writeFileSync(new URL('../contract/openapi.yaml', import.meta.url), '# GENERATED from src/scanner/schemas.ts + routes.ts by `npm run spec`. Do not edit by hand. DRAFT 1.\n' + stringify(doc, { lineWidth: 0 }));
console.log(`spec: ${Object.keys(doc.paths ?? {}).length} paths`);
