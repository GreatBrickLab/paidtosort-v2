# Part Scanner API (paidtosort v2): DRAFT 1, local only

Headless, API-first backend for Part Scanner v2. Any screen (Web Boss's UI, a phone app, a script) sits on top of it.
**DRAFT 1** of the contract (Chris's process: draft → review → rebuilt twice into a clean final spec).

**Local only.** No deploys, no remote, no real database. Deploys go through Web Boss after an A&S GO and Chris's typed OK.
`wrangler.toml` points at a placeholder local D1. Tables in `proposed-schema/` are a *proposal* for A&S (see `BACKEND-REQUEST-AS-v2.md`).

## What it follows
| Source | What we take from it |
|---|---|
| Web Boss `paidtosort/v2/README.md` (base #1–28, Conventions) | `/api/v1/scanner/...`, RFC 9457 problem+json with `code` + `request_id`, `Idempotency-Key` stored in D1, cursor paging, snake_case, `bat_`/`crd_` IDs, UTC `Z` times, integer cents + `currency`, Hono + zod-openapi with the spec generated from code |
| A&S `security/baseline/V2-SECURITY-CONTRACT.md` (DRAFT 1) | `scan_*` table names, roles sorter/team/admin (no partner role yet), §4 standard headers + `Cache-Control: private, no-store`, the 9-test security kit (mirrored in `tests/security.test.ts`) |

## Layout
- `src/platform/`: the shared conventions, isolated so Web Boss / A&S modules can replace them in one swap: `conventions.ts` (base path, cents, time), `ids.ts`, `problem.ts` (RFC 9457), `paging.ts`, `idempotency.ts`, `base.ts` (request id, JSON log line, errors), `security.ts` (§4 headers, same-origin for cookie writes, no-image guard), `auth.ts` (**STUB** verifier, local stand-in for A&S), `ratelimit.ts` (hook, stub).
- `src/scanner/`: the scanner: `schemas.ts` (Zod = the single source of the spec), `routes.ts`, `api.ts`, `access.ts` (object-level checks), `reducer.ts`, `store.ts`, `bsx.ts`, `adapters/` (catalog fixture, recognizer stub + Brickognize).
- `contract/openapi.{json,yaml}`: **generated** (`npm run spec`); never hand-edit. Shaped to merge into pts-v2's `/api/v1/openapi.json` (all operationIds `scanner*`, all components `Scanner*`, tags `scanner-*`).
- `proposed-schema/0001_scan_tables.sql`: proposed tables, local tests only.
- `tests/`: routes, rules, security kit, contract, platform, BSX snapshots, recognizer.

## Run
```bash
npm ci
npm run check        # spec → spectral lint → vitest → gitleaks
npm run db:local && npm run dev   # fail-closed like production: every call 401 (no local auth switch exists)
npm run mock         # Prism mock of the contract on :4795 (for UI work before the server)
npm run docs         # Scalar reference from the contract
```
There is no local-auth or stub switch in shipped code (Web Boss review #2): the default is `DenyAllVerifier` and no recognizer (503). Tests inject fakes from `tests/helpers/` only. Key auth works from curl; the same-origin check applies only to writes carrying our session cookie (`__Secure-better-auth.session_token`); other cookies are ignored.

## Naming (ID) route limits, for A&S review
A&S rules (12:01 PM CT) for `POST /scanner/batches/{batch_id}/cards` and `POST /scanner/cards/{card_id}/identify`. All values live in `src/scanner/limits.ts`.

| Rule | Value | Answer when broken |
|---|---|---|
| Auth required | valid key (A&S verifier) | 401 `api_key_missing` / `api_key_invalid` (problem+json) |
| Session cookie **and** API key on one request (every route) | refused | 400 `ambiguous_credentials` |
| Per caller, per minute (rolling 60 s, per user) | **20** (env `IDENTIFY_PER_MINUTE_LIMIT`) | 429 `rate_limited`, `limit: "minute"`, `Retry-After` |
| Per caller, per hour (rolling, per user) | **100** (env `IDENTIFY_HOURLY_LIMIT`) | 429 `rate_limited`, `limit: "hourly"`, `Retry-After` |
| All callers together, per minute / per hour | **60 / 600** | 429 `rate_limited`, `limit: "global_minute"` / `"global_hourly"` |
| How counted | one row in `scan_identify_calls`, reserved atomically **before** each recognizer call (failed calls count) | |
| Platform rate-limit hook (per user + key) | placeholder allows all; A&S plugs in | 429 `rate_limited`, `Retry-After` |
| No recognizer configured | `RECOGNIZER` unset → | 503 `recognizer_not_configured` |
| Whole request body (bytes actually received, after auth) | **400 KB** | 413 `body_too_large` |
| One crop file | **300 KB**, image types only | 413 `crop_too_large` / 400 |
| Crops per request | **1** | 400 `too_many_crops` |
| Every other route: JSON body (bytes received) | **256 KB**, no image data | 413 `body_too_large` / 415 |
| Events per batch | **5,000** | 409 `batch_event_limit` (sync: rejected) |
| Sync payloads | allow-listed keys per event type; same text limits as routes (name 60, batch note 500, card note 200, drawer code 40) | rejected `unknown_payload_key` / `bad_note` |

Why 20/min: a phone photo usually has 5–15 parts, each one crop; 20/min lets a sorter finish one busy photo without waiting but stops a runaway loop well below the free recognizer tier.

## Never open to the public
Every route, including `POST /scanner/batches/{id}/cards` and `/cards/{id}/identify` (the routes that send a crop to the recognizer), needs a valid key: 401 problem+json otherwise. Naming has per-caller limits (20/min, 100/hour, plus a platform rate-limit hook), a cookie+key request is refused, and body/crop caps apply (table above). The scanner must stay inside A&S's shared auth middleware; there are no public routes.

## Where we differ from the written docs (to settle, not guessed)
1. **Error body.** A&S contract §4/§5 says `{"error":"<code>"}` and 401 `{"error":"unauthenticated"}`. We use Web Boss's agreed RFC 9457 problem+json with `code` + `request_id` (Huddle 11:56 AM CT: Web Boss backs this). Our 401 codes are `api_key_missing` / `api_key_invalid`. A&S should update §4/§5 or name the codes it wants.
2. **Path.** A&S §2.1 gives `/api/scanner/v2/...` as an example; we use `/api/v1/scanner/...` (Web Boss conventions, confirmed in the huddle).
3. **Permissions-Policy.** API replies send `camera=(), microphone=(), geolocation=()`. The scanner *page* (not this API) needs `camera=(self)`.
4. **Pending users** get 403 on every scanner route, including `/scanner/me` (they get only the platform's `/api/me`).

## What the scanner needs that the base doesn't cover yet
- A&S: the real key/session verifier + test key to replace `src/platform/auth.ts`; the shared security test helper to replace our mirror; the real rate-limit hook.
- A&S: OK + migration for `scan_batches` / `scan_events` (BACKEND-REQUEST-AS-v2.md), Chris's typed OK.
- A&S: the Brickognize call behind a server route if A&S wants to own vendor calls (contract §2.5); today the adapter calls the free public tier, no key.
- Web Boss / Parts and Orders: shared parts/colors/values/stock/Parts-We-Need APIs (we use a fake fixture via `adapters/catalog.ts`).
- Web Boss: ETag / If-Match (base #26) is not built; the event log uses per-event idempotency + `seq` instead. Needs a decision for PATCH routes.
- Web Boss: multipart upload conventions (the crop routes are the only non-JSON bodies); webhook signing (#24) for a future Bricqer feed; generated client (#27).
- A&S: a partner role (for example Bricqer, key-gated per DECISIONS.md) when Chris wants it. Queries are already owner-scoped, so it plugs into `src/scanner/access.ts`.

## Handoff into GreatBrickLab/paidtosort-v2
`handoff/make-slice.sh <clone>` builds one local branch `scanner/v0-slice` and `handoff/0001-scanner-v0-slice.patch`
(see `handoff/HANDOFF.md`). Nothing is pushed; Web Boss opens the PR.

See DONE.md, CHANGELOG.md, ROLLBACK.md, docs/adr/.
