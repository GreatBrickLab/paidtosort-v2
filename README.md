# Paid to Sort v2 (v2.paidtosort.com)

A brand-new, clean, API-first Paid to Sort. Approved by Chris typed 11:29 AM CT, Nov 24, 2026.
Base requirements added by Chris 11:31, 11:32 and 11:33 AM CT (18 total), Nov 24, 2026.

## Resources (Greatbricklab Cloudflare account)
- Pages project: `pts-v2` (production branch `main`), https://pts-v2.pages.dev
- Custom domain: `v2.paidtosort.com`
- D1: `pts-v2-db`, bound as `DB` (production and preview). Starts empty.
- KV: `pts-v2-kv`, bound as `KV` (production and preview). Starts empty.
- No other bindings, no secrets, no mailer yet.
- Separate from the current staging and live sites. Nothing here touches them.

## Base requirements (non-negotiable)

1. **100% API-driven. No exceptions, no shortcuts.** All data and all business rules come from
   the API, and the server re-checks everything. The client may only do presentation, UI state
   and convenience checks that the server repeats; it never decides anything the server trusts.
   Zero hardcoded data. No code is copied or reused from the old Paid to Sort platform.
   *(Reworded Nov 24, 2026 per BEST-PRACTICE-CHECK.md.)*
2. **Auth is a first-class API.** Tokens and email codes, exposed as versioned API endpoints
   (for example `/api/v1/auth/...`), not bolted-on cookie sessions. Not built yet; design it as
   an API from the start.
3. **Versioning in the URL from day one.** Every endpoint lives under `/api/v1/...`. Breaking
   changes go to `/api/v2/...`; old versions keep working until retired on purpose.
4. **Observability.** Every request writes one structured JSON log line
   (`console.log(JSON.stringify(...))`) with `request_id`, `method`, `path`, `route`, `status`
   and `ms`. Every response carries an `x-request-id` header. Health lives at `/api/v1/health`
   and includes a database check (`SELECT 1` on `DB`); it returns 503 in the error shape if the
   database check fails.
5. **One error contract.** Every endpoint fails with the same shape:
   ```json
   { "error": { "code": "not_found", "message": "No such API route", "request_id": "..." } }
   ```
   `code` is a stable machine-readable string (`not_found`, `method_not_allowed`,
   `db_unavailable`, `internal`, ...), `message` is human-readable, `request_id` matches the log
   line and the `x-request-id` header. Unknown `/api/*` routes return 404 in this shape.
   *(The agreed target is RFC 9457 problem+json with `code` and `request_id` extensions; see
   Conventions. The placeholder still sends the shape above until the spec draft in milestone 1.)*
6. **Rate limiting before launch.** Every endpoint is rate limited before v2 goes to staging or
   production, auth endpoints most strictly. Use what the existing plan includes; no paid add-ons
   without Chris's typed OK and a cost log entry. Not built yet. The Workers rate limiter is
   approximate, so it is for abuse protection only: **pay caps and any other exact limit are
   enforced in D1.**
7. **Migration path from the old system.** There is a documented, repeatable path to move data
   from the old Paid to Sort databases into the v2 databases through v2's own API/schema. Document
   only for now. Copying any real data needs Chris's typed OK first.
8. **API docs are generated from the spec, not written after.** `spec/openapi.json` is the source
   of truth. The API serves it at `/api/v1/openapi.json`, and `/docs` (docs.html) renders the docs from
   that response. Add an endpoint to the spec in the same change that adds it to the code.

9. **Idempotency keys on creates and money moves.** Every POST or PATCH that creates something or
   moves money (batches, approvals, pay) requires an `Idempotency-Key` header. A repeated request
   with the same key returns the original result instead of saving twice; a reused key with a
   different body is rejected. Keys, request hashes and responses are **stored in D1** (not KV,
   which is eventually consistent) with an expiry window. PUT and DELETE are idempotent by design.
   Not built yet (no write endpoints exist).
10. **Seeded test database and test keys (replaces the sandbox site).** Tests and bots use a
    seeded test D1 database with fake data and test-mode API keys, never real parts. A separate
    sandbox subdomain is revisited only when Bricqer or other outside integrators need more.
    Creating any new database still needs Chris's typed OK and a cost log entry.

11. **Permissions and scopes.** Every endpoint declares the scope it needs. Scopes are granted
    per role (sorter, admin, ...) and per API key; a token can only do what its scopes allow.
12. **Schema validation on every request.** Request bodies, params and queries are validated
    against `spec/openapi.json` before any handler runs; failures use the error contract
    (`code: "invalid_request"`).
13. **Shared paging and filtering.** Every list endpoint uses the same conventions (cursor
    paging with `limit` and `cursor`, the same filter and sort parameter style), defined once in
    the spec.
14. **Audit log.** Every write records who (user or API key), what, when (UTC) and the
    request_id.
15. **Backups with a tested restore.** The v2 databases are backed up on a schedule, and a
    restore is actually tested, not assumed. Uses what the existing plan includes; anything paid
    needs Chris's typed OK and a cost log entry.
16. **Contract tests gate deploys.** Responses are tested against the spec, and a failing
    contract test stops the deploy. Starter: `tests/contract.mjs` checks `/api/v1/health` and the
    404 error shape against `spec/openapi.json`.
17. **Deprecation policy.** An old API version or field is marked deprecated in the spec and in a
    `Deprecation` response header, kept working for a stated period, and removed only after that.
18. **Money in cents, times in UTC.** Money is stored and sent as integer cents; times are stored
    and sent as UTC ISO 8601.

### Added Nov 24, 2026 (gaps found by BEST-PRACTICE-CHECK.md)

19. **Object-level authorization.** Every handler checks that the caller may touch this specific
    object, not just that it holds the scope (sorter A can never read sorter B's pay or batches).
    One shared helper, with tests for every route.
20. **CORS and security headers.** An explicit CORS allow-list (no wildcard origins with
    credentials), HSTS, `X-Content-Type-Options: nosniff`, and a CSP for the pages.
21. **Token lifetime, refresh and revocation.** Short-lived access tokens, rotating refresh
    tokens, revocation on logout or lost phone, email codes that expire with attempt limits, and
    API keys hashed at rest with a recognizable prefix for leak scanning.
22. **Secret rotation.** Secrets live only as Workers secrets per environment, with a written
    rotation runbook and support for two valid signing keys during a switch.
23. **PII retention.** A written list of what is kept about people (email, pay), for how long,
    how it is deleted, and log redaction (never log tokens, email codes or PII).
24. **Signed webhooks.** Outgoing events (for example to Bricqer) carry an HMAC signature and a
    timestamp, with a replay window, following Standard Webhooks.
25. **Consistent resource naming.** Plural nouns, stable IDs and standard methods, enforced by a
    spec linter in CI.
26. **ETags and conflict protection.** Updates use `ETag` and `If-Match`; a stale write gets
    412, so two people approving the same card never overwrite each other.
27. **A client generated from the spec.** Pages and integrations use a typed client generated
    from `spec/openapi.json`; nobody hand-writes API shapes.
28. **Request IDs everywhere.** Every request gets an ID that appears in the response header,
    the error body, the log line and the audit log.

## Conventions (agreed with Part Scanner v2, Nov 24, 2026)

- **Errors:** RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`,
  `instance`) plus `code` (stable machine string) and `request_id` extensions.
- **Versions:** one prefix, `/api/v1`, with apps under it (for example `/api/v1/scanner/...`).
  Only breaking changes bump the major version; otherwise fields are added, never removed or
  renamed.
- **Retries:** `Idempotency-Key` header on creates and money moves (see #9).
- **Lists:** cursor paging (`limit` with a maximum, opaque `cursor`), defined once in the spec.
- **JSON:** `snake_case` field names.
- **IDs:** type-prefixed opaque IDs (for example `bat_...`, `usr_...`); never raw row numbers.
- **Time and money:** UTC ISO 8601 times ending in `Z`; integer cents with a currency field.
- **Framework:** Hono + `@hono/zod-openapi`. The spec is the single source: docs, request
  validation, contract tests and the generated client all come from it.
- **Access checks:** every route declares its scope and runs the object-level check (#11, #19).

## Ownership

- **Web Boss:** these conventions, the shared UI component kit, the shared data APIs (parts,
  colors, drawers, staff), deploys and DNS (DNS only with Chris's OK).
- **Accounts and Security:** sign-in, sessions, roles, API keys, secrets, Turnstile, security
  headers, review of every table or route change, and the security test kit.
- **Each builder:** its own app routes, tables (through an Accounts and Security request plus
  Chris's typed OK) and screens. Part Scanner v2 owns the scanner.
- **Note:** today every route shares one database connection (`DB`), so the walls between apps
  are enforced by review and tests, not by the platform, until a separate-database design is
  decided.

See OWNERS.md for the full list, DEFINITION-OF-DONE.md, ROADMAP.md and CHANGELOG.md.

## Promotion
v2 is promoted later to staging, then production, **only on Chris's typed OK** at each step.
Normal team rules still apply: gitleaks before every deploy (stop on nonzero), no secrets in
chat or files, no schema changes on shared databases without Chris's OK, anything that costs money
needs approval first.

## Layout
- `functions/api/[[path]].js`: the API router (versioned routes, error contract, JSON logs)
- `spec/openapi.json`: the API spec (source of truth for docs)
- `tests/contract.mjs`: contract test (responses vs spec); must pass before every deploy
- `.github/workflows/ci.yml`: CI (spec lint, contract test on local `wrangler pages dev`, gitleaks)
- `redocly.yaml`: spec lint rules
- `public/`: page shells that only render API data (`index.html` + `app.js` from
  `/api/v1/health`; `docs.html` + `docs.js` from `/api/v1/openapi.json`)

## Deploy (only with approval)
Deploys need approval. They run only after gitleaks and `node tests/contract.mjs <url>` pass,
with credentials kept outside the repo.
