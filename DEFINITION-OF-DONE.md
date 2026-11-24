# Definition of done (Paid to Sort v2)

A change is done only when every box below is true. If one is not, it is not done, and it does
not deploy.

1. **Spec updated.** `spec/openapi.json` describes the change in the same pull request as the code.
2. **Contract tests pass.** `node tests/contract.mjs <url>` passes against a local
   `wrangler pages dev` in CI, and against the target before any deploy.
3. **Security tests pass.** The Accounts and Security test kit passes: scopes, object-level
   checks (sorter A cannot touch sorter B's data), headers and rate limits.
4. **Docs regenerate.** `/docs` renders the change from the spec with no hand edits.
5. **Gitleaks clean.** No secrets in the change or in history. Stop on any finding.
6. **Staging checked.** Once a staging environment exists for v2, the change is checked there by
   the owner (and by Accounts and Security for anything touching sign-in, roles, keys, tables or
   routes) before Chris is asked to say go.
7. **Rollback noted.** The pull request or deploy log says exactly how to undo the change in
   minutes (previous deployment to restore, and the D1 restore point for any data change).
8. **Change log entry.** `CHANGELOG.md` has a dated line: what changed, who approved it, result.

Plus the standing rules: anything that costs money, any D1 schema change, any DNS change and any
promotion to staging or live needs Chris's own typed OK.
