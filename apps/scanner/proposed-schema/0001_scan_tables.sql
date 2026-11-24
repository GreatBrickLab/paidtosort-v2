-- PROPOSED schema for A&S review, local test only. (wrangler d1 migrations apply DB --local). Never applied to a real database.
-- Builders never write real migrations; A&S writes and runs the real one after Chris's typed OK in A&S chat.
-- Same two tables as BACKEND-REQUEST-AS.md (Nov 24 2026), renamed to the scan_* app prefix (V2-SECURITY-CONTRACT.md §2.3, Huddle 11:56 AM CT), plus key_id/request_id audit columns and three indexes (BACKEND-REQUEST-AS-v2.md).
-- Real tables need Chris's own typed OK in Accounts and Security's chat.
CREATE TABLE scan_batches (
  id            TEXT PRIMARY KEY,            -- 'bat_' + random (platform id style)
  owner_user_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  condition     TEXT NOT NULL CHECK (condition IN ('U','N')),
  status        TEXT NOT NULL CHECK (status IN ('open','finished','processed')),
  last_seq      INTEGER NOT NULL DEFAULT 0,
  summary_json  TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  finished_at   TEXT,
  processed_at  TEXT,
  processed_by  TEXT
);
CREATE UNIQUE INDEX scan_batches_one_open ON scan_batches(owner_user_id) WHERE status = 'open';
CREATE INDEX scan_batches_owner ON scan_batches(owner_user_id, updated_at);
CREATE INDEX scan_batches_created ON scan_batches(created_at, id);

CREATE TABLE scan_events (
  batch_id        TEXT NOT NULL REFERENCES scan_batches(id),
  seq             INTEGER NOT NULL,
  client_event_id TEXT NOT NULL,             -- the Idempotency-Key (or key#n for multi-event writes)
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL CHECK (length(payload_json) <= 8000),  -- never image data
  user_id         TEXT NOT NULL,             -- who (signed-in user id)
  key_id          TEXT,                      -- which API key (audit, platform base #14)
  request_id      TEXT,                      -- matches the log line and x-request-id (#4, #14)
  device_id       TEXT,
  at              TEXT NOT NULL,
  PRIMARY KEY (batch_id, seq),
  UNIQUE (batch_id, client_event_id)
);
-- proposed (v2 request): find a card's batch, find an export, count recent namings per person
CREATE INDEX scan_events_card ON scan_events(json_extract(payload_json, '$.card_id')) WHERE type = 'card.added';
CREATE INDEX scan_events_export ON scan_events(json_extract(payload_json, '$.export_id')) WHERE type = 'batch.exported';
CREATE INDEX scan_events_user_at ON scan_events(user_id, at);
