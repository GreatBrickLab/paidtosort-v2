# ADR 0001: Base path `/api/v1/scanner/...`
Date: 2026-11-24 · Status: accepted (DRAFT 1)
**Decision.** All scanner routes live under `/api/v1/scanner/`, not `/api/scanner/v1/` (first sketch) or `/api/scanner/v2/` (A&S contract §2.1 example).
**Reason.** Web Boss base #3 and Conventions: one version prefix for the whole platform with apps under it, so the scanner spec merges into pts-v2's `/api/v1/openapi.json` and versions together. Confirmed in the 11:56 AM CT huddle.
**Consequence.** operationIds are prefixed `scanner`, components `Scanner*`, tags `scanner-*` to avoid collisions in the merged spec.
