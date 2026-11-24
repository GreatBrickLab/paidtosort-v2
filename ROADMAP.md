# Roadmap (Paid to Sort v2)

Each milestone ends with a gate. We do not start the next milestone's real work until the gate
is passed. Dates get filled in as each gate gets close.

| # | Milestone | What it means | Gate (how we know it's done) | Owner |
|---|---|---|---|---|
| 0 | Foundation | Code in one private GitHub repo with history, CI that checks every change, branch protection on main. | Accounts and Security reviewed the repo; first push done; CI green on main; main can't be changed without a passing check. | Web Boss |
| 1 | Spec draft | Write the v1 API spec using the Conventions, get it reviewed, then rebuild the placeholder twice from the spec alone to prove the spec is enough. | Part Scanner v2 and Accounts and Security sign off on the spec; both rebuilds pass the contract tests. | Web Boss |
| 2 | Auth and keys | Sign-in, sessions, tokens, roles, scopes, API keys, security headers, rate limits on auth. | Security test kit passes; Accounts and Security says it's safe; Chris's typed OK for its tables. | Accounts and Security |
| 3 | Shared data APIs | Parts, colors, drawers and staff, read through the API. | Contract and security tests pass; builders confirm the shapes work for them. | Web Boss |
| 4 | Scanner API | The scanner is the first real app on v2. | Scanner contract and security tests pass; a real phone test passes; Chris's typed OK for its tables. | Part Scanner v2 |
| 5 | UI kit | Shared screen pieces (cards, lists, forms, errors) every app uses. | Scanner screens use the kit; accessibility check passes on a phone. | Web Boss |
| 6 | Other sections | Each remaining Paid to Sort section moves to v2, one at a time. | Each section passes the definition of done. | Each builder |
| 7 | Data migration | Move real data from the old system with a repeatable script (dry run, counts, reconciliation). | Dry run on a copy matches counts; restore point taken; **Chris's typed OK** before any real data is copied. | Web Boss with Parts and Orders |
| 8 | Promotion | v2 goes to staging, then to live. | Staging checked by owners and Accounts and Security, rollback ready, **Chris's typed OK** for staging and again for live. | Web Boss |
