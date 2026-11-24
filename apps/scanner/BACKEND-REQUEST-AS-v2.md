# Part Scanner v2: backend request for Accounts and Security (v2)

Status: **REQUEST ONLY. DRAFT 1.** Changes nothing. No D1, bindings, migrations, staging or live touched.
Written Nov 24, 2026 (~12:00 PM CT) by the Part Scanner v2 build bot. Replaces BACKEND-REQUEST-AS.md (v1, ~8:25 AM CT).
Gate: A&S writes and runs the real migration only after **Chris types OK in Accounts and Security's chat**. Time Travel bookmark first, staging before live (V2-SECURITY-CONTRACT.md §1).
Reference build: `paidtosort/scanner-v2/part-scanner-api-wip/` (local only; the SQL below is `proposed-schema/0001_scan_tables.sql`, applied only to a local Miniflare D1 in tests).

## What changed since v1
| v1 | v2 | Why |
|---|---|---|
| `scanner_v2_batches`, `scanner_v2_events` | **`scan_batches`, `scan_events`** | A&S contract §2.3 app prefix; huddle 11:56 AM CT |
| ids `b_…` | **`bat_…`** (cards `crd_`, photos `pho_`, exports `exp_`, requests `req_`) | Web Boss Conventions: type-prefixed opaque IDs |
| no audit columns | **`key_id`, `request_id`** on every event | Web Boss base #14 (who/which key) and #28 (request id in audit) |
| `/api/scanner-v2/...`, cookie only | **`/api/v1/scanner/...`**, Bearer key (A&S verifier); cookie sessions also fine | Web Boss #3; Chris: everybody needs a key |
| `{error:'signed_out'}` | **RFC 9457 problem+json** with `code` + `request_id` | Web Boss #5 (see open item 5) |
| `scanner.use` etc. | scopes `scan:write`, `batches:read`, `batches:read_all`, `exports:create`, `batches:process` | Web Boss #11 |
| partner keys | **no partner role for now**; queries owner-scoped so one can be added | Huddle 11:56 AM CT |

## 1. Proposed tables
```sql
CREATE TABLE scan_batches (
  id            TEXT PRIMARY KEY CHECK (id LIKE 'bat\_%' ESCAPE '\' AND length(id) <= 40),
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) <= 64),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  condition     TEXT NOT NULL CHECK (condition IN ('U','N')),
  status        TEXT NOT NULL CHECK (status IN ('open','finished','processed')),
  last_seq      INTEGER NOT NULL DEFAULT 0 CHECK (last_seq BETWEEN 0 AND 5000),
  summary_json  TEXT NOT NULL DEFAULT '{}' CHECK (length(summary_json) <= 65536),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  finished_at   TEXT,
  processed_at  TEXT,
  processed_by  TEXT CHECK (processed_by IS NULL OR length(processed_by) <= 64)
) STRICT;
CREATE UNIQUE INDEX scan_batches_one_open ON scan_batches(owner_user_id) WHERE status = 'open';
CREATE INDEX scan_batches_owner ON scan_batches(owner_user_id, updated_at);
CREATE INDEX scan_batches_created ON scan_batches(created_at, id);
CREATE INDEX scan_batches_status_created ON scan_batches(status, created_at);

CREATE TABLE scan_events (
  batch_id        TEXT NOT NULL REFERENCES scan_batches(id),
  seq             INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 5000),   -- events-per-batch cap (G8), also enforced in the app
  client_event_id TEXT NOT NULL CHECK (length(client_event_id) <= 140), -- the Idempotency-Key (or key#n for multi-event writes)
  type            TEXT NOT NULL CHECK (type IN ('batch.created','batch.renamed','batch.noted','drawer.opened','photo.taken','card.added','card.updated',
                    'card.edited','card.decided','card.reopened','batch.finished','batch.reopened','batch.exported','batch.processed')),
  payload_json    TEXT NOT NULL CHECK (length(payload_json) <= 8000),  -- never image data
  user_id         TEXT NOT NULL CHECK (length(user_id) <= 64),         -- who (signed-in user id)
  key_id          TEXT CHECK (key_id IS NULL OR length(key_id) <= 64),  -- which API key (audit, platform base #14)
  request_id      TEXT CHECK (request_id IS NULL OR length(request_id) <= 64), -- matches the log line and x-request-id (#4, #14, #28)
  device_id       TEXT CHECK (device_id IS NULL OR length(device_id) <= 64),
  at              TEXT NOT NULL,
  PRIMARY KEY (batch_id, seq),
  UNIQUE (batch_id, client_event_id)
) STRICT;
-- find a card's batch, find an export
CREATE INDEX scan_events_card ON scan_events(json_extract(payload_json, '$.card_id')) WHERE type = 'card.added';
CREATE INDEX scan_events_export ON scan_events(json_extract(payload_json, '$.export_id')) WHERE type = 'batch.exported';
CREATE INDEX scan_events_user_at ON scan_events(user_id, at);
-- duplicate lookup for batch-create replays (findCreateByKey), so a create is never a full scan
CREATE INDEX scan_events_create_key ON scan_events(user_id, client_event_id) WHERE type = 'batch.created';

-- G2: one row per recognizer call, reserved atomically BEFORE the call (conditional INSERT … SELECT … WHERE count < cap),
-- so failed calls count too and concurrent requests can't overshoot. Rows older than 2 hours are no longer read.
CREATE TABLE scan_identify_calls (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL CHECK (length(user_id) <= 64),
  at         TEXT NOT NULL,
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) <= 64)
) STRICT;
CREATE INDEX scan_identify_calls_user_at ON scan_identify_calls(user_id, at);
CREATE INDEX scan_identify_calls_at ON scan_identify_calls(at);
```
Revised ~12:30 PM CT per the A&S review (§6): `STRICT` tables; CHECKs on event type (14 types), name ≤ 60, `summary_json` ≤ 64 KB, ids/device ≤ 64; `scan_events_create_key` index for batch-create replays (no more full scan); `seq BETWEEN 1 AND 5000` (events-per-batch cap, also enforced by the app: 409 `batch_event_limit`); optional `scan_batches(status, created_at)` for admin lists; and **`scan_identify_calls`**, the atomic rate table (G2): one row per recognizer call, reserved by a single conditional `INSERT … SELECT … WHERE count < cap` before the call, so failed calls count and bursts can't overshoot.

**Meanings.** `owner_user_id`, `processed_by` and `user_id` are the account service's `user.id` values (no cross-DB foreign key). `scan_events` is append-only; no app path updates or deletes it.

**Retention (proposed, for A&S and Chris to set).** Batches and their events are kept **24 months after `processed_at`**, then deleted by an A&S-run job (batches never processed: 24 months after `updated_at`). `scan_identify_calls` rows are only read for 1 hour; delete rows older than **7 days**. On offboarding a person, keep the audit columns (ids, times, request ids) and blank their free text (batch notes, card notes, help text, first name in batch names) on request. No photos or image bytes exist to delete. The deletion job is not built (it needs a scheduled trigger, an A&S/Web Boss call).

Idempotency keys live in `scan_events.client_event_id` (unique per batch) with the request hash in the payload (Web Boss #9: D1, not KV). No photos are stored anywhere; `payload_json ≤ 8000` bytes; image data is refused before any write (contract §2.7, kit #6).

## 2. Roles → scopes the A&S verifier should hand the scanner
| Role (contract §4) | Scopes |
|---|---|
| sorter | `scan:write`, `batches:read` |
| team | + `batches:read_all` (read everyone's batches, team finds list; never write others') |
| admin | + `exports:create` (BSX), `batches:process` |
| pending / declined | none → 403 on every scanner route |

## 3. What the scanner needs from A&S
1. OK the two tables (or new names) and write the migration; Chris's typed OK.
2. The real verifier behind `src/platform/auth.ts` (`verify(request) → {user_id, name, role, scopes, key_id, mode} | null`) and a seeded test key (Web Boss #10).
3. The shared security test helper; our mirror of the 9 tests is `tests/security.test.ts`.
4. A per-caller rate-limit hook for the naming routes. Our own caps (now reserved atomically in `scan_identify_calls`, failed calls counted, plus a shared cap of **60/min and 600/hour** for all sorters), for your review (`src/scanner/limits.ts`): **20/min and 100/hour per person** (429 + `Retry-After`, `limit` says which), **1 crop per request** (400 `too_many_crops`), **300 KB per crop** (413 `crop_too_large`), **400 KB per request** (413 `body_too_large`), cookie + key together refused (400 `ambiguous_credentials`). Other routes: 256 KB JSON, no image data (413/415).
5. **Error wording:** contract §4/§5 says `{"error":"<code>"}`; Web Boss's agreed shape (kept in the huddle) is problem+json with `code`. Please align §4/§5; our 401 codes are `api_key_missing` / `api_key_invalid`.
6. Whether A&S wants the recognizer (Brickognize free tier, no key today) behind its own server route (contract §2.5).
7. The CI table allow-list for this app: `scan_batches`, `scan_events`, `scan_identify_calls` (contract §3; A&S review §7 allows the rate table).

## 4. Never public
Every route, including the two that send a crop to the recognizer, sits inside the shared auth middleware and returns 401 without a valid key or session.
