# Changelog
All notable changes. Format: Keep a Changelog. Contract versions follow Chris's draft process (DRAFT 1 → review → rebuild ×2 → final).

## [Unreleased] DRAFT 1, 2026-11-24 (local only, never deployed)
### Added
- 28 operations under `/api/v1/scanner/...`: batches, events (offline sync), drawers, photo counts, cards (crop → name), decisions, minifig part-out / hold / need-help, exports (BSX, CSV, JSON), finds, me, spec.
- Contract generated from Zod (`contract/openapi.{json,yaml}`), Spectral rules (snake_case, Idempotency-Key on writes, 401 on every op).
- Platform module `src/platform/` (ids, problem+json, paging, idempotency, base app, security headers and guards, stub auth, rate-limit hook).
- A&S security kit mirror (9 tests × every route), route, rule, contract, platform, BSX snapshot and recognizer tests.
- DONE.md, ROLLBACK.md, docs/adr/0001–0007, CI workflow (vitest, spectral, gitleaks), `.gitleaks.toml` with a `pts_` key rule.
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
