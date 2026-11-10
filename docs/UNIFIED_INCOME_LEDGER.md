# Shared income calculation (2026-11-10)

My Stats, per-link totals, wallet reads, withdrawal creation/approval, and the dashboard balance migration now use `api/_lib/income-ledger.js`.

Ownership comes from the report, server-created `nf_subs`, reviewed recovery asset lists, and server-owned equity codes. CloudSync book metadata cannot grant income. The report's latest per-asset daily DN is the amount source. A recovery's stored amount is validated as evidence; it is never added to current report revenue. Link and CPS code IDs are distinct assets; invite codes use the separate `invite:` namespace. Each asset is included once, even after the report catches up with a recovery or when legacy spelling records overlap.

Cross-account claims exclude disputed assets and require reconciliation. Missing recovery evidence, truncated history, inconsistent totals, malformed daily amounts and duplicate dates block settlement. Storage failures do not fall back to an old additive wallet total. All financial mutation paths load current server attribution evidence for the request; there is no persisted balance cache or credit/backfill job in this change.

The existing wallet policy continues to separate historical carryover, rewards, commission, and audited adjustments. Pending and approved withdrawals reduce availability once; rejection releases the pending hold. Existing migration dates and historical bonus markers remain in place. Statistics use 80% commission rounded per account/day, matching the wallet's post-cutoff rounding. Historical settlement policy and rewards can still make lifetime wallet earnings differ from the statistics commission total.

Validation: 490 tests and syntax checks pass. New coverage includes two unrelated accounts, new unmapped server assets, recovery/pipeline duplication, repeated recovery spellings, negative corrections, code/invite collisions, ownership conflicts, incomplete history, Redis failures, authenticated stats/wallet parity, request retries, approval-time ownership changes, migrated carryover, and replay of all assigned promoters in the bundled report (60 promoters / 2,657 raw asset rows at the time of this change).

The DRAS integration fixture uses known report amounts with simulated Redis ownership and withdrawal records. It is not a production wallet audit. Real Redis balances, recovery records and principal/alias conflicts must not be described as verified based on this fixture. This release does not manually edit any user's money, withdrawals or recovery records.
