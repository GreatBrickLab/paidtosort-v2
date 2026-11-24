# ADR 0004: Money as integer cents with a currency
Date: 2026-11-24 · Status: accepted (DRAFT 1)
**Decision.** Every money field ends in `_cents`, is an integer (or null when unknown), and sits next to `currency: "USD"`.
**Reason.** Web Boss base #18. Floating-point dollars drift when lots are summed (0.1 + 0.2); integer cents add exactly and match Stripe-style APIs partners already know.
**Consequence.** Catalog values are converted once (`toCents`) at the edge; exports format cents back to dollars only inside the BSX/CSV file.
