# ADR 0005: Auth is a stub verifier; A&S owns keys
Date: 2026-11-24 · Status: accepted (DRAFT 1)
**Decision.** `src/platform/auth.ts` holds only an `AuthVerifier` interface and `FakeLocalVerifier`, a **local test stand-in** that maps fake `pts_test_` tokens to principals. No key issuance, storage or key tables.
**Reason.** A&S constraint (11:52 AM CT): API keys, sessions and roles belong to Accounts and Security (contract §1). Chris decided everyone who uses the API needs a key (DECISIONS.md). The interface lets A&S's real verifier drop in without touching scanner code.
**Consequence.** Every route, including identify, returns 401 without valid auth and is never public. Key auth works from curl; same-origin applies only to cookie writes (ADR 0007).
