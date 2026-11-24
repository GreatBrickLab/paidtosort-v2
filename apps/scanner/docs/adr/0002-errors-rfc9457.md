# ADR 0002: Errors are RFC 9457 problem+json with `code` and `request_id`
Date: 2026-11-24 · Status: accepted (DRAFT 1); open item with A&S
**Decision.** Every error is `application/problem+json` with `type`, `title`, `status`, `instance`, optional `detail`, plus `code` (stable machine string) and `request_id` (matches `x-request-id` and the log line). Field errors go in `errors[]`.
**Reason.** Web Boss base #5 and Conventions (agreed with Part Scanner v2); a standard that client generators and partners already understand. The huddle (11:56 AM CT) kept it.
**Open.** A&S contract §4/§5 still says `{"error":"<code>"}`. We match the *meaning* of its tests (status, no data) and ask A&S to update the wording.
