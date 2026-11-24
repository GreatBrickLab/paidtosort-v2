# Owners (Paid to Sort v2)

Who owns each route, table and screen. One owner each, so nothing falls between bots. If
something is not listed, Web Boss owns it until it is assigned here.

Note: today every route shares one database connection (`DB`), so the walls between apps are
enforced by review and tests until a separate-database design is decided. Any new table or route
needs an Accounts and Security review; any table change also needs Chris's typed OK.

## Platform

| Area | Owner | Reviewer |
|---|---|---|
| Conventions (README "Conventions"), spec layout, CI | Web Boss | Accounts and Security |
| Deploys (Pages project `pts-v2`) and DNS (Chris's OK) | Web Boss | Accounts and Security |
| Shared UI component kit | Web Boss | Each builder |
| Security headers, CORS, CSP | Accounts and Security | Web Boss |
| Secrets, API keys, Turnstile | Accounts and Security | - |
| Security test kit | Accounts and Security | - |

## Routes (all under `/api/v1`)

| Route | Owner | Status |
|---|---|---|
| `/health` | Web Boss | live (placeholder) |
| `/openapi.json` | Web Boss | live (placeholder) |
| `/auth/...` (sign-in, sessions, tokens, email codes) | Accounts and Security | planned (milestone 2) |
| `/keys/...`, `/roles/...` | Accounts and Security | planned (milestone 2) |
| `/parts/...`, `/colors/...`, `/drawers/...`, `/staff/...` (shared data) | Web Boss | planned (milestone 3) |
| `/scanner/...` | Part Scanner v2 | DRAFT 1 mounted, fail-closed (every call 401 until A&S auth) |
| Other sections (`/<app>/...`) | Assigned builder | planned (milestone 6) |

## Tables (D1 `pts-v2-db`, empty today)

| Tables | Owner | Change rule |
|---|---|---|
| users, sessions, refresh tokens, API keys, roles, scopes | Accounts and Security | A&S design + Chris's typed OK |
| idempotency keys, audit log | Accounts and Security | A&S design + Chris's typed OK |
| parts, colors, drawers, staff (shared data) | Web Boss | A&S request + Chris's typed OK |
| scanner tables (`scan_...`, proposed: `scan_batches`, `scan_events`) | Part Scanner v2 | A&S request + Chris's typed OK |
| other app tables (`<app>_...`) | Assigned builder | A&S request + Chris's typed OK |

## Screens

| Screen | Owner |
|---|---|
| Home shell (`public/index.html`) and docs page (`public/docs.html`) | Web Boss |
| Sign-in, password reset, account screens | Accounts and Security (UI built with Web Boss's kit) |
| Scanner screens | Part Scanner v2 |
| Other section screens | Assigned builder |
