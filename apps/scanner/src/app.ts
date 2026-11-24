// Composition: the platform shell (src/platform) + the scanner section (src/scanner), mounted at /api/v1.
import { API_BASE } from './platform/conventions';
import { type AuthVerifier, FakeLocalVerifier, requireAuth } from './platform/auth';
import { noImagesExcept, oneCredentialOnly, sameOriginForCookieWrites } from './platform/security';
import { ID_LIMITS, MAX_JSON_BODY_BYTES, cropCountGuard } from './scanner/limits';
import { createPlatformApp, newSectionRouter } from './platform/base';
import { createScannerRouter, type ScannerDeps } from './scanner/api';
import { FixtureCatalog } from './scanner/adapters/catalog';
import { BrickognizeRecognizer, StubRecognizer } from './scanner/adapters/recognizer';
import { R } from './scanner/routes';
import spec from '../contract/openapi.json';

export interface Env { DB: D1Database; RECOGNIZER?: string; DEV_AUTH_TOKENS?: string; IDENTIFY_HOURLY_LIMIT?: string; IDENTIFY_PER_MINUTE_LIMIT?: string }

export interface AppOverrides { verifier?: AuthVerifier; deps?: Partial<ScannerDeps>; log?: (l: Record<string, unknown>) => void }

export const SPEC_DOC = {
  openapi: '3.1.0',
  info: {
    title: 'Paid to Sort v2 API: Part Scanner section', version: '0.1.0-draft1',
    contact: { name: 'Part Scanner v2 (paidtosort staff tools)', url: 'https://paidtosort.com' },
    description: [
      '**DRAFT 1** (Chris\'s process: draft → review → rebuilt twice into a clean final spec). Local work in progress; not deployed.',
      'Shaped to merge into pts-v2\'s `/api/v1/openapi.json` (server `/api/v1`, paths under `/scanner/`, operationIds and components prefixed `scanner`/`Scanner`).',
      'Every request needs an API key (`Authorization: Bearer …`). Identity, roles and keys belong to Accounts and Security; the scanner only reads the scopes A&S gives it.',
      'Every POST/PATCH needs `Idempotency-Key`. Errors are RFC 9457 `application/problem+json` with `code` and `request_id`. Lists use `limit` + `cursor`. snake_case, UTC ISO 8601, money in integer cents with `currency`.',
      'Photos are never uploaded or stored; one small crop per part is named on the server by the free recognizer tier and held in memory for that call only.',
    ].join('\n\n'),
  },
  servers: [{ url: '/api/v1', description: 'Platform base (pts-v2)' }, { url: 'http://127.0.0.1:4794/api/v1', description: 'Local wrangler dev (--local)' }],
  security: [{ api_key: [] }],
  tags: Object.entries({
    me: 'Who the calling key belongs to, with role and scopes.',
    batches: 'A sorter\'s batches: create, rename, finish, reopen, mark processed.',
    sync: 'The batch event log, for offline devices and resume.',
    drawers: 'Drawer labels scanned into a batch.',
    photos: 'Photo counts only; photos are never uploaded.',
    cards: 'One card per found part: crop → name, edit, decide.',
    minifigs: 'Minifig part-out, hold and need-help.',
    exports: 'BrickStore (BSX), CSV and JSON exports of approved lots (admin).',
    finds: 'Team lists: held figs and Parts We Need finds.',
    meta: 'The scanner section of the OpenAPI spec.',
  }).map(([t, description]) => ({ name: `scanner-${t}`, description })),
};

export function buildScannerRouter(getDeps: Parameters<typeof createScannerRouter>[0]) {
  const r = createScannerRouter(getDeps);
  r.openAPIRegistry.registerComponent('securitySchemes', 'api_key', { type: 'http', scheme: 'bearer',
    description: 'Every caller needs a key. Issued and verified by Accounts and Security (no partner role yet; a scoped partner key (for example for Bricqer) can be added later because every query is owner-scoped). Local tests use fake `pts_test_…` tokens.' });
  return r;
}

/** The OpenAPI document generated from the zod schemas (single source). */
export function generateSpec() {
  const r = buildScannerRouter(() => { throw new Error('spec only'); });
  return r.getOpenAPI31Document(SPEC_DOC as never);
}

export function createApp(over: AppOverrides = {}) {
  const knownPaths = Object.values(R).map((x: any) => `${API_BASE}${x.path}`);
  const app = createPlatformApp({ log: over.log, knownPaths: () => knownPaths });
  const verifierFor = (env: Env) => over.verifier ?? FakeLocalVerifier.fromJson(env.DEV_AUTH_TOKENS);
  const isIdRoute = (m: string, p: string) => m === 'POST' && (/^\/api\/v1\/scanner\/batches\/[^/]+\/cards$/.test(p) || /^\/api\/v1\/scanner\/cards\/[^/]+\/identify$/.test(p));
  app.use(`${API_BASE}/*`, sameOriginForCookieWrites);
  app.use(`${API_BASE}/*`, oneCredentialOnly(isIdRoute));
  app.use(`${API_BASE}/*`, noImagesExcept(isIdRoute, { body: MAX_JSON_BODY_BYTES, idBody: ID_LIMITS.maxIdBodyBytes }));
  app.use(`${API_BASE}/scanner/*`, requireAuth((c) => verifierFor(c.env as Env)));
  app.use(`${API_BASE}/scanner/*`, cropCountGuard(isIdRoute));
  const scanner = buildScannerRouter((c) => {
    const env = c.env as Env;
    return {
      db: env.DB, catalog: new FixtureCatalog(),
      recognizer: env.RECOGNIZER === 'brickognize' ? new BrickognizeRecognizer() : new StubRecognizer(),
      identifyHourlyLimit: env.IDENTIFY_HOURLY_LIMIT ? Number(env.IDENTIFY_HOURLY_LIMIT) : ID_LIMITS.perHour,
      identifyPerMinuteLimit: env.IDENTIFY_PER_MINUTE_LIMIT ? Number(env.IDENTIFY_PER_MINUTE_LIMIT) : ID_LIMITS.perMinute,
      spec, ...over.deps,
    } as ScannerDeps;
  });
  app.route(API_BASE, scanner);
  return app;
}

export { newSectionRouter };
