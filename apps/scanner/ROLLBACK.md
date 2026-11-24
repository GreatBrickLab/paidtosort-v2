# Rollback: undoing a handoff or deploy

Nothing here is deployed. These are the steps for when it is. Every live step needs Chris's typed OK; deploys are Web Boss's, schema is A&S's.

## Before any handoff
1. Tag the exact commit handed over (`scanner-api-draftN`) and record the pts-v2 commit it merged into.
2. A&S takes a **D1 Time Travel bookmark** right before the `scan_*` migration (contract §1) and writes the bookmark id in the handoff note.
3. The scanner is mounted behind one switch in pts-v2 (route mount `/api/v1/scanner/*`). The old v1 scanner stays live until v2 is accepted.

## Roll back the code (most cases)
1. Web Boss redeploys the previous pts-v2 Pages deployment (Cloudflare Pages → Deployments → previous → Rollback), or reverts the merge commit and redeploys. No schema change needed: unused `scan_*` tables are harmless.
2. Confirm: `GET /api/v1/scanner/me` returns 404 (unmounted) or the old behaviour; pts-v2 contract tests pass.
3. Sorters keep using v1. Devices hold unsynced events in their outbox and resend later (events are idempotent by `client_event_id`, so nothing doubles).

## Roll back the schema (only if the migration itself is wrong)
1. Stop writes: unmount the scanner routes first (step above).
2. Export `scan_batches` and `scan_events` (`wrangler d1 export` of those tables) so finished batches can be replayed.
3. A&S restores to the Time Travel bookmark, or drops only `scan_*` tables. Restoring the whole DB also rolls back other apps' writes since the bookmark, so prefer dropping `scan_*` and ask Chris first.
4. Batches can be rebuilt from the exported events (the reducer is deterministic); exports already downloaded stay valid.

## Roll back a contract change
Fields are only added, never removed or renamed (Web Boss Conventions). A bad new field is marked `deprecated` in the spec and in CHANGELOG.md and removed only in the next major version.

## Who
Web Boss: redeploy/revert. A&S: bookmark, restore, key revocation. Chris: typed OK for any live action.
