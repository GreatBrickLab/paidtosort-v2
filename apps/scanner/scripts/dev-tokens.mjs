// Writes fake LOCAL TEST tokens into the gitignored .dev.vars (DEV_AUTH_TOKENS) for `wrangler dev --local`.
// These stand in for A&S's test keys; they are random, local-only and never printed.
// Usage: node scripts/dev-tokens.mjs  → then source tokens from .dev-tokens.json in your shell (also gitignored).
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
const tok = () => `pts_test_${randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32).padEnd(32, 'x')}`;
const P = (user_id, name, role, scopes) => ({ user_id, name, role, scopes, key_id: `key_dev_${user_id}`, mode: 'test' });
const people = {
  sorter: P('usr_sam_test', 'Sam Sorter', 'sorter', ['scan:write', 'batches:read']),
  sorter2: P('usr_pat_test', 'Pat Sorter', 'sorter', ['scan:write', 'batches:read']),
  team: P('usr_terry_test', 'Terry Team', 'team', ['scan:write', 'batches:read', 'batches:read_all']),
  admin: P('usr_alex_test', 'Alex Admin', 'admin', ['scan:write', 'batches:read', 'batches:read_all', 'exports:create', 'batches:process']),
};
const tokens = {}; const byName = {};
for (const [k, p] of Object.entries(people)) { const t = tok(); tokens[t] = p; byName[k] = t; }
if (existsSync('.dev.vars') && !process.argv.includes('--force')) { console.log('.dev.vars exists; pass --force to replace it.'); process.exit(0); }
writeFileSync('.dev.vars', `DEV_AUTH_TOKENS='${JSON.stringify(tokens)}'\n`, { mode: 0o600 });
writeFileSync('.dev-tokens.json', JSON.stringify(byName, null, 2) + '\n', { mode: 0o600 });
console.log('Wrote .dev.vars and .dev-tokens.json (both gitignored). Tokens not shown.');
