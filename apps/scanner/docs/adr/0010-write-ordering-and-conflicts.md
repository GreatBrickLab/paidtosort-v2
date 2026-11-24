# ADR 0010: Per-batch write ordering, clear conflict and constraint errors, naming reuse
Date: 2026-11-24 · Status: accepted (A&S follow-up to PR #1)
**Decision.**
1. Writes to one batch run one at a time inside an isolate (an in-memory queue per batch id). Across isolates the `last_seq` guard still decides; a loser re-reads and retries up to 8 times with jittered backoff (≈ 0.6 s worst case), then gets **409 `write_conflict`** with `Retry-After: 1`, and nothing is saved.
2. D1 errors are classified: CHECK / NOT NULL / FOREIGN KEY → **422 `constraint_violation`** immediately, never retried; UNIQUE / PRIMARY KEY → a race, retried.
3. Each recognizer call is recorded with the caller, Idempotency-Key and crop hash, and its text result. A retry of the same request reuses it: no second recognizer call and no second rate slot.
4. Idempotency-Key and sync `client_event_id` are 8–128 chars, matching the CHECK; derived ids for the 2nd+ event of a write are `#<n>#<40 hex>`.
**Reason.** A&S found that 25 concurrent writes to one batch lost cards with 409 `internal` after the recognizer had already been paid for, and that a too-long key gave 500/409 `internal` because a CHECK failure was treated as a race.
**Alternatives.** A Durable Object per batch would serialize across isolates too, but it is a new binding (A&S / Web Boss call). Allocating `seq` in SQL alone does not work because the summary is computed from the full state.
**Consequence.** One sorter drives one batch, so real contention is low; the queue removes it within an isolate and the error is now clear and safe to retry everywhere else.
