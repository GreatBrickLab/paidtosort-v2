-- PROPOSED schema for A&S review, local test only (loaded into an in-memory Miniflare D1 by the tests). NOT a migration.
-- A&S writes the real numbered migration in the platform migrations folder, test DB first, Time Travel bookmark before
-- live, and only after Chris's typed OK in A&S's chat. Revised Nov 24 2026 ~12:30 PM CT per A&S review §6 (STRICT tables,
-- CHECKs, duplicate-lookup index, events-per-batch cap, atomic rate table). Retention rule: BACKEND-REQUEST-AS-v2.md §1.
-- Revised again ~1:00 PM CT per A&S follow-ups: keys ≤ 128 (agree with the app), counts-only summary ≤ 4096, timestamp
-- format CHECKs (x IS strftime('%Y-%m-%dT%H:%M:%fZ', x): a real UTC date written exactly as the app writes it; IS, not =,
-- so a non-date (strftime → NULL) fails instead of passing), scan_events_user_at dropped, naming-result reuse.
-- owner_user_id / processed_by / user_id are the platform account service's user.id values (no cross-DB foreign key).
-- scan_events is append-only: no app path updates or deletes it.
CREATE TABLE scan_batches (
  id            TEXT PRIMARY KEY CHECK (id LIKE 'bat\_%' ESCAPE '\' AND length(id) <= 40),
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) <= 64),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  condition     TEXT NOT NULL CHECK (condition IN ('U','N')),
  status        TEXT NOT NULL CHECK (status IN ('open','finished','processed')),
  last_seq      INTEGER NOT NULL DEFAULT 0 CHECK (last_seq BETWEEN 0 AND 5000),
  summary_json  TEXT NOT NULL DEFAULT '{}' CHECK (length(summary_json) <= 4096), -- counts only (ADR 0009); note ≤ 500 is the largest field
  created_at    TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at    TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  finished_at   TEXT CHECK (finished_at IS NULL OR finished_at IS strftime('%Y-%m-%dT%H:%M:%fZ', finished_at)),
  processed_at  TEXT CHECK (processed_at IS NULL OR processed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', processed_at)),
  processed_by  TEXT CHECK (processed_by IS NULL OR length(processed_by) <= 64)
) STRICT;
CREATE UNIQUE INDEX scan_batches_one_open ON scan_batches(owner_user_id) WHERE status = 'open';
CREATE INDEX scan_batches_owner ON scan_batches(owner_user_id, updated_at);
CREATE INDEX scan_batches_created ON scan_batches(created_at, id);
CREATE INDEX scan_batches_status_created ON scan_batches(status, created_at);

CREATE TABLE scan_events (
  batch_id        TEXT NOT NULL REFERENCES scan_batches(id),
  seq             INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 5000),   -- events-per-batch cap (G8), also enforced in the app
  client_event_id TEXT NOT NULL CHECK (length(client_event_id) BETWEEN 1 AND 128), -- Idempotency-Key / sync id (8–128, same as the app), or '#n#<40 hex>' for the 2nd+ event of one write
  type            TEXT NOT NULL CHECK (type IN ('batch.created','batch.renamed','batch.noted','drawer.opened','photo.taken','card.added','card.updated',
                    'card.edited','card.decided','card.reopened','batch.finished','batch.reopened','batch.exported','batch.processed')),
  payload_json    TEXT NOT NULL CHECK (length(payload_json) <= 8000),  -- never image data
  user_id         TEXT NOT NULL CHECK (length(user_id) <= 64),         -- who (signed-in user id)
  key_id          TEXT CHECK (key_id IS NULL OR length(key_id) <= 64),  -- which API key (audit, platform base #14)
  request_id      TEXT CHECK (request_id IS NULL OR length(request_id) <= 64), -- matches the log line and x-request-id (#4, #14, #28)
  device_id       TEXT CHECK (device_id IS NULL OR length(device_id) <= 64),
  at              TEXT NOT NULL CHECK (at IS strftime('%Y-%m-%dT%H:%M:%fZ', at)),
  PRIMARY KEY (batch_id, seq),
  UNIQUE (batch_id, client_event_id)
) STRICT;
-- find a card's batch, find an export
CREATE INDEX scan_events_card ON scan_events(json_extract(payload_json, '$.card_id')) WHERE type = 'card.added';
CREATE INDEX scan_events_export ON scan_events(json_extract(payload_json, '$.export_id')) WHERE type = 'batch.exported';
-- duplicate lookup for batch-create replays (findCreateByKey), so a create is never a full scan
CREATE INDEX scan_events_create_key ON scan_events(user_id, client_event_id) WHERE type = 'batch.created';

-- G2: one row per recognizer call, reserved atomically BEFORE the call (conditional INSERT … SELECT … WHERE count < cap),
-- so failed calls count too and concurrent requests can't overshoot. Rows older than 2 hours are no longer read for limits;
-- the app deletes rows older than 7 days, a bounded few hundred at a time, during normal naming requests.
-- result_json keeps the recognizer's answer so a retry of the same request (same caller + Idempotency-Key + crop) reuses it
-- and never calls the recognizer twice. Text results only (part numbers, names, scores), never image data.
CREATE TABLE scan_identify_calls (
  id              INTEGER PRIMARY KEY,
  user_id         TEXT NOT NULL CHECK (length(user_id) <= 64),
  at              TEXT NOT NULL CHECK (at IS strftime('%Y-%m-%dT%H:%M:%fZ', at)),
  request_id      TEXT CHECK (request_id IS NULL OR length(request_id) <= 64),
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128),
  crop_sha256     TEXT CHECK (crop_sha256 IS NULL OR (length(crop_sha256) = 64 AND crop_sha256 NOT GLOB '*[^0-9a-f]*')),
  result_json     TEXT CHECK (result_json IS NULL OR length(result_json) <= 4000)
) STRICT;
CREATE INDEX scan_identify_calls_user_at ON scan_identify_calls(user_id, at);
CREATE INDEX scan_identify_calls_reuse ON scan_identify_calls(user_id, idempotency_key);
CREATE INDEX scan_identify_calls_at ON scan_identify_calls(at);
