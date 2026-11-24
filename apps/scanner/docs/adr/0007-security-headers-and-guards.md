# ADR 0007: Standard headers and request guards in the platform module
Date: 2026-11-24 · Status: accepted (DRAFT 1)
**Decision.** `src/platform/security.ts` adds the contract §4 headers to every reply (errors included) plus `Cache-Control: private, no-store` and `Vary: Cookie`; refuses cookie writes from another origin (403 `cross_origin_refused`); refuses image data (415) and big bodies (413) on every route except the two naming routes.
**Reason.** A&S contract §4–5, Chris's no-photos rule (§2.7). Key-auth calls carry no cookie and must work from curl and servers; browsers can't send a Bearer header cross-site without a CORS preflight, which this API never answers.
**Consequence.** One file to replace with A&S's shared middleware later.
