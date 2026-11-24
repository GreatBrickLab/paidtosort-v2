# Changelog
All notable changes. Format: Keep a Changelog. Contract versions follow Chris's draft process (DRAFT 1 → review → rebuild ×2 → final).

## [Unreleased] DRAFT 1, 2026-11-24 (local only, never deployed)
### Added
- 28 operations under `/api/v1/scanner/...`: batches, events (offline sync), drawers, photo counts, cards (crop → name), decisions, minifig part-out / hold / need-help, exports (BSX, CSV, JSON), finds, me, spec.
- Contract generated from Zod (`contract/openapi.{json,yaml}`), Spectral rules (snake_case, Idempotency-Key on writes, 401 on every op).
- Platform module `src/platform/` (ids, problem+json, paging, idempotency, base app, security headers and guards, stub auth, rate-limit hook).
- A&S security kit mirror (9 tests × every route), route, rule, contract, platform, BSX snapshot and recognizer tests.
- DONE.md, ROLLBACK.md, docs/adr/0001–0007, CI workflow (vitest, spectral, gitleaks), `.gitleaks.toml` with a `pts_` key rule.
### Fixed (12:30 PM CT, A&S review M1/M1b/G1–G8 and Web Boss review)
- M1: auth now runs before anything reads the body (signed-out 5 MB upload → 401, body not read). Only header checks run before auth.
- G1: request size caps count bytes actually received (streamed), not Content-Length.
- G2: naming calls are reserved atomically in `scan_identify_calls` before the recognizer is called; failed calls count; shared cap 60/min, 600/h.
- G3: only our session cookie (`__Secure-better-auth.session_token`) counts as a cookie credential. G4: cookie + key → 400 on every route. G5: cookie writes without Origin or `Sec-Fetch-Site: same-origin` → 403.
- G6 / WB #2: no local-auth switch (`SCANNER_LOCAL_TEST`, `DEV_AUTH_TOKENS`) and no stub recognizer in shipped code; defaults `DenyAllVerifier` and 503 `recognizer_not_configured`. Fakes moved to `tests/helpers/`; `scripts/dev-tokens.mjs` removed.
- G7: sync payload keys allow-listed per event type, same text limits as routes. G8: 5,000 events per batch (409 / rejected).
- M1b / WB #1: esbuild pinned as a direct devDependency; scanner CI job installs checksum-verified gitleaks 8.28.0; tests use `$GITLEAKS_BIN`.
- WB #3: license MIT; `pages-bundle/THIRD_PARTY_NOTICES.md` generated with the bundle. WB #4: no vendor or tool names in the spec.
- Headers: `Vary: Cookie, Authorization`, `Cross-Origin-Resource-Policy: same-origin`.
- Proposed schema: STRICT tables, CHECKs, create-key index, seq ≤ 5,000, `scan_identify_calls`, retention rule.
### Added (12:01 PM CT, A&S ID-route rules)
- Cookie + API key on a naming route → 400 `ambiguous_credentials`; per-minute cap (20, `limit: "minute"`) besides the hourly cap (100); 1 crop per request (400 `too_many_crops`); 400 KB body cap on naming routes (413). Limits in `src/scanner/limits.ts`, tests in `tests/rules.test.ts`.
### Added (12:01 PM CT, handoff)
- `src/pages.ts` + `npm run bundle:pages` (prebuilt `pages-bundle/scanner.mjs` for pts-v2, fail-closed `DenyAllVerifier`), `scripts/merge-platform-spec.mjs`, `handoff/` (slice script, patch, notes).
### Changed
- Path `/api/scanner/v1` → `/api/v1/scanner` (Web Boss base).
- IDs `b_…` → `bat_…`, `crd_…`, `pho_…`, `exp_…`, `req_…`.
- Errors → RFC 9457 problem+json with `code` + `request_id`.
- Money → integer cents with `currency: "USD"`.
- Proposed tables renamed `scanner_v2_*` → `scan_batches`, `scan_events` (A&S contract §2.3, huddle 11:56 AM CT); audit columns `key_id`, `request_id`.
- `/scanner/me` and `/scanner/openapi.json` now need `batches:read` (pending users get 403).
### Removed
- Partner role and partner-only list filter (no partner role for now; owner scoping kept so one can be added).
- Key issuance/storage (A&S owns keys); only a stub verifier remains.
- Hand-written `openapi.yaml` (a second source of truth).
