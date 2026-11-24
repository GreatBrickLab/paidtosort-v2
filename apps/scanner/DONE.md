# Definition of done (Part Scanner API)

## For every route
A route is done when **all** of these are true and shown by a test in CI:
1. It is in the generated contract with an `operationId` starting `scanner`, a summary, its scope in the description, and every status it can return.
2. Its responses match the contract (`conforms()` in tests: status documented, body valid against the schema, `application/json` or `application/problem+json`, `x-request-id: req_…`).
3. A&S kit, all 9: signed out 401 with no data · pending user 403 · sorter B gets 404 on sorter A's object and only own rows in lists · `Cache-Control: private, no-store` · §4 headers on success and errors · image data refused 415/413 except the two naming routes · unknown fields/wrong types 400, never 500 · cookie writes from another origin 403 (key auth from curl works) · gitleaks clean.
4. Writes need `Idempotency-Key`; a replay returns the first response; same key + different body → 422 `idempotency_key_reused`.
5. Each write appends events with `user_id`, `key_id`, `request_id`, `at` (UTC) for the audit trail.
6. Money is integer `_cents` + `currency`; times end in `Z`; IDs are prefixed; JSON is snake_case.
7. Spectral lint passes with zero warnings; `tsc` clean.
8. Concurrency and storage rules (A&S follow-ups): 25 concurrent writes to one batch all land with zero lost cards and one recognizer call each; a cross-isolate loser gets 409 `write_conflict` + `Retry-After` and a retry with the same key reuses the naming; a CHECK failure is 422 `constraint_violation`, never a retried 409/500; keys over 128 chars are 400 before any write.

## Acceptance criteria per route
| Operation | Scope / who | Must |
|---|---|---|
| `GET /scanner/me` | `batches:read` | Returns user id, name, role, key id/mode/scopes; pending → 403 |
| `GET /scanner/batches` | `batches:read`; `owner=all` needs `batches:read_all` | Own batches only by default; cursor paging; status filter; sorter `owner=all` → 403 |
| `POST /scanner/batches` | `scan:write` | 201, server names it "First MM-DD-YY" (Chicago), then " B"…; second open batch → 409 `open_batch_exists` |
| `GET /scanner/batches/{id}` | owner, or `batches:read_all` | `expand[]=drawers,cards`; others → 404 |
| `PATCH /scanner/batches/{id}` | owner | Rename/note until Processed; else 409 |
| `POST …/finish` | owner | 409 `cards_undecided` (count, first_card_id) or `no_cards`; never auto-drops |
| `POST …/reopen` | owner | 409 `not_finished` / `batch_processed` / `open_batch_exists` |
| `POST …/processed` | `batches:process` (admin) | 409 `not_finished` while open |
| `GET …/events` | read | `after_seq`, cursor paging, stable order |
| `POST …/events` | owner | Per-event acks/rejections; replay acks first `seq`; route-only types rejected; finished batch → rejected `batch_finished` |
| `GET/POST …/drawers` | read / owner | Code normalized UPPER; bad code 422; reopening an existing drawer → 200 not 201 |
| `POST …/photos` | owner | Counts only; any image data → 415 |
| `GET …/cards` | read | Drawer order, part-out pieces under their fig, `state` filter |
| `POST …/cards` (multipart) | owner, `scan:write` | Crop ≤ 300 KB (413), image types only; named by recognizer; 429 with `Retry-After` at the hourly limit; 502/504 typed, never "none"; crop never stored |
| `GET /scanner/cards/{id}` | read | 404 to others |
| `PATCH /scanner/cards/{id}` | owner | One `card.edited` event; colors limited to known colors for the part (422) |
| `POST …/identify` | owner | Same crop rules; 409 `retry_not_needed` unless card is `error` |
| Every route (A&S review 12:17 PM CT) | | Auth before any body read (signed-out large upload → 401); size caps count received bytes; session cookie + key → 400; cookie writes need Origin = self or `Sec-Fetch-Site: same-origin`; only our session cookie counts; 5,000 events per batch |
| Both naming routes (A&S 12:01 PM CT) | | 401 without auth; cookie+key → 400 `ambiguous_credentials`; 20/min and 100/hour per caller → 429 + `Retry-After`; body > 400 KB → 413 `body_too_large`; > 1 crop → 400 `too_many_crops`; namer never called when refused; slot reserved atomically before the call (failed calls count); shared cap 60/min, 600/h; 503 `recognizer_not_configured` when RECOGNIZER is unset |
| `POST …/decision` | owner | Only `allowed_decisions`; Parts We Need find recorded |
| `POST …/reopen` (card) | owner | Undo after Drop |
| `POST …/part-out` | owner | Pieces become cards under the fig; no known pieces → 400 |
| `POST …/hold` | owner | `set_aside` + held; left out of export; on admin Held list |
| `POST …/need-help` | owner | `unknown` + help text |
| `POST …/exports` | `exports:create` (admin) | Finished batches only; approved cards only; one lot per drawer+type+part+color+condition; file name `scan-<slug>-YYYYMMDD-HHMM` with `-2`… on collision |
| `GET /scanner/exports/{id}` + `/file` | `exports:create` | Same bytes every time (rebuilt to the export's seq); CSV formula-safe |
| `GET /scanner/finds` | `batches:read_all` | Held figs / Parts We Need finds, newest first |
| `GET /scanner/openapi.json` | `batches:read` | The scanner spec (DRAFT 1) |

## For the handoff to Web Boss (not done yet, needs approvals)
A&S review + GO, A&S-written migration with Chris's typed OK, real auth verifier swapped in, A&S's shared kit passing, contract merged into pts-v2 `/api/v1/openapi.json`, staging first, Chris's typed OK for live.
