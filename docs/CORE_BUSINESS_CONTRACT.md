# Core business contract

This document is the implementation boundary for the next refactor. It does not change production behavior by itself.

## Ownership

`nf_user_data:<canonical username>` is the server-owned wallet document. It owns points, bonus balance, check-in state, VIP state, withdrawals, binding and promotion records. Browser CloudSync may update book and UI state only. Financial and reward fields are always replaced from the server snapshot.

Every mutation resolves identity aliases, checks disabled status, acquires the relevant lock, validates the current record, and commits a complete result. A conflict or corrupt record fails closed and requires reconciliation.

## Check-in and rewards

`POST /api/rewards` is the only mutation endpoint. The server chooses the UTC date. A check-in awards exactly 5 points once per UTC day. Day seven credits 50 cents once per cycle and queues a separate two-day VIP entitlement. Operation IDs are idempotency keys. VIP delivery is an outbox operation: unknown upstream outcomes remain pending or reconciliation-required and are never blindly retried.

Mission points are 20 (`share1`), 50 (`share3`) and 30 (`bindId`), with completion verified server-side. Exchanging 1000 points awards three VIP days and requires an immutable verified NovelFlow binding.

## Wallet and withdrawals

Income attribution combines distinct code and link identifiers after source-specific deduplication. The candidate commission policy is 80% from 2026-08-10; production admin deployment remains the authority. Withdrawals require authenticated ownership, a valid wallet, idempotency key, minimum $10 and maximum $10,000. Pending amounts are frozen. Approval and rejection are administrator-only transitions; reconciliation blocks approval.

## Promotion code and link creation

`POST /api/confirm` takes the authenticated username from JWT and validates the selected book. `(username, bookId)` is deduplicated under a lock. The service allocates a numeric upstream promotion code, then creates a short link and stores the resulting `code`, `link`, and `linkId` in both submission indexes and the user's book list. A failed upstream allocation is persisted as pending and is safe to retry; it must never consume a second code for the same pending request.

The numeric promotion code and the personal invite/equity code are different products. The latter is managed by `/api/equity-code`, has one active code per account, binds one book, grants one day VIP to a reader, expires after seven days, and starts a seven-day cooldown after unbinding.

## Refactor order

1. Extract shared identity, wallet, money and error contracts without changing endpoints.
2. Add contract-level tests for every state transition and retry path.
3. Move the frontend to typed request adapters and server-authoritative state hydration.
4. Replace large inline feature blocks incrementally, preserving URLs and copy until behavior is verified.
5. Run syntax checks, the full Node test suite, and bounded desktop/mobile UI checks before any production promotion.
