# ADR 0006: Proposed tables `scan_batches` / `scan_events`, owner-scoped queries, no partner role yet
Date: 2026-11-24 · Status: proposed to A&S (needs Chris's typed OK)
**Decision.** Two app-prefixed tables (`scan_*`, A&S contract §2.3): batches plus an append-only event log. Every list query filters by `owner_user_id` unless the caller has `batches:read_all`. Roles are sorter, team, admin; no partner role for now.
**Reason.** Huddle 11:56 AM CT naming update; contract §2.6 (a sorter only ever sees their own batches). Owner scoping means a key-gated partner (Bricqer) can be added later as one rule in `access.ts`.
**Consequence.** Schema lives in `proposed-schema/` for local tests only; A&S writes the real migration.
