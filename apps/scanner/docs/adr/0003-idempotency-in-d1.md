# ADR 0003: Idempotency keys stored in D1 with the events
Date: 2026-11-24 · Status: accepted (DRAFT 1)
**Decision.** Writes require `Idempotency-Key`. The key (or `key#n` for multi-event writes) is the event's `client_event_id`, unique per batch in `scan_events`, with a SHA-256 hash of the canonical request. A replay returns the first result; the same key with a different body gets 422 `idempotency_key_reused`.
**Reason.** Web Boss base #9 says D1, not KV: KV is eventually consistent, so two retries could both miss and both write. Storing the key in the same row as the change makes "write once" one atomic insert, and the audit trail (#14) comes for free.
**Consequence.** No separate idempotency table or expiry job; key reuse is scoped to a batch.
