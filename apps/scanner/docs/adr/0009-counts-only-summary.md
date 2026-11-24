# ADR 0009: The batch summary caches counts only
Date: 2026-11-24 · Status: accepted (A&S follow-up to PR #1)
**Decision.** `scan_batches.summary_json` holds only bounded fields: owner first name, note (≤ 500), counts, estimated value in cents, current drawer, export count and `finds_count: {held, parts_we_need}`. The finds list (`GET /scanner/finds`) picks batches with `finds_count` > 0 and rebuilds the finds from their events. CHECK `length(summary_json) <= 4096`.
**Reason.** The old summary embedded every find (one row per held fig or wanted part), so its size grew with the batch and the 64 KB CHECK could be hit by a big batch, failing a valid write. Counts are bounded, and the list is an admin view that can afford an event replay of the few batches that have finds.
**Consequence.** The finds list costs one event read per batch with finds (≤ 5,000 events each). If that ever gets slow, add a `scan_finds` table (A&S migration) rather than growing the summary.
