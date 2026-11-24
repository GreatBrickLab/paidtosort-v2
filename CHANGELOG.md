# Change log (Paid to Sort v2)

One line per change: when (Central Time), what, who approved it, result. Newest at the bottom of
each day.

## Nov 24, 2026

- 11:29 AM CT: v2.paidtosort.com created (Pages `pts-v2`, D1 `pts-v2-db`, KV `pts-v2-kv`,
  DNS CNAME `v2`). Approved by Chris (typed OK). Owner: Web Boss.
- 11:31 to 11:33 AM CT: 18 base requirements added to README.md. Source: Chris's own words.
- 11:33 AM CT: placeholder deployed (health with DB check, openapi.json, error contract, JSON
  logs). Gitleaks clean first. Contract test passed on pts-v2.pages.dev and v2.paidtosort.com at
  11:35 AM CT. Staging and live unchanged.
- 11:36 AM CT: BEST-PRACTICE-CHECK.md written (lookup only, no changes).
- 11:45 AM CT: Chris told the team to make professional technical decisions and do free,
  reversible work without waiting on him.
- Late morning: README.md updated (no deploy): requirement #1 reworded, #10 sandbox site replaced
  with a seeded test database and test keys, #9 idempotency limited to creates and money moves
  stored in D1, #6 pay caps enforced in D1; requirements #19 to #28 added; Conventions and
  Ownership sections added. New files: DEFINITION-OF-DONE.md, OWNERS.md, CHANGELOG.md,
  ROADMAP.md, .gitignore, redocly.yaml, .github/workflows/ci.yml. Folder put under git (local
  commit only, not pushed; Accounts and Security reviews before the first push). Owner: Web Boss.
- 12:10 PM CT (proposed, PR from Part Scanner v2, not merged): scanner v0 slice. `apps/scanner/` (source, tests,
  generated contract, prebuilt Pages bundle), `/api/v1/scanner/*` mounted fail-closed (every call 401 until A&S
  auth), 28 scanner operations merged into spec/openapi.json, contract test checks each one signed out. No tables,
  no secrets, no deploy. Needs: A&S review, Web Boss merge.
