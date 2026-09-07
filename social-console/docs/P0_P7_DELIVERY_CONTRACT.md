# P0–P7 Delivery Contract

Last updated: 2026-09-03

This is the operating contract for the Social Console. Its purpose is simple:
every run must always answer **where it is, why it is there, what can safely
happen next, and whether a human decision is required**.

## Non-negotiable outcomes

A run has exactly one durable outcome:

1. `scheduled_external` / `external_draft`: SocialEcho returned a real external
   `data.id`; the account, media, caption, and (when requested) schedule match
   the locked route.
2. `publish_ambiguous`: a provider outcome cannot be proven. Reconcile it; do
   not submit another upload or article.
3. `failed` or `blocked`: a concrete error and a concrete next action are
   stored. A paid task is never silently retried.

`ready_for_review`, an uploaded video, HTTP 200 without `data.id`, and a
SocialEcho `status: 0` draft are **not** scheduled delivery.

## State vocabulary

| State | Meaning | Worker behaviour |
| --- | --- | --- |
| `waiting` | Needs a safe prerequisite or a saved backoff window | Resume automatically at `nextAttemptAt` |
| `running` | A durable stage is advancing or polling an existing external ID | Poll/reconcile only; never make a second paid request |
| `done` | The stage's success evidence is saved | Advance to its successor |
| `partial` | Optional side branch is incomplete | Continue the video delivery path; show the warning |
| `failed` | A deterministic failure is saved | Offer the recorded repair action; no implicit paid retry |
| `ambiguous` | An external side effect may already exist | Reconcile only; no resubmission |
| `blocked` | A human decision or a hard policy condition is needed | Do not spin or occupy worker capacity |

## Stage contract

| Stage | Required durable evidence | Safe automatic recovery | Hard stop |
| --- | --- | --- | --- |
| P0 — selection | Ranking receipt, metric timestamp, title/SKU/application/account tuple, chosen schedule | Refresh an expired ranking and choose from the same verified route | No live or still-fresh ranking snapshot; no qualified candidate |
| P1 — identity | Exact active book identity from the target application and a live SocialEcho route | Retry a read-only lookup | SKU/title/application/account mismatch or a retired account |
| P2 — evidence | Locked chapter IDs and bodies, source language, story brief/evidence cursor | Resume the saved cursor; honour model capacity/backoff | Source evidence is insufficient for a grounded creative |
| P3 — creative | Validated post variants, source quotes, video contract, language/routing checks | Bounded JSON repair using the same model and evidence | Cross-book facts, unsafe content, invalid tracking or a non-repairable validation error |
| P3.5 — posters | Optional image task IDs and results, if posters were requested | Poll existing task IDs only | Ambiguous paid image is isolated for reconciliation; it never blocks video delivery |
| P4 — video | Submit intent, AC remark, then persisted `threadId`; verified HTTPS video URL | Poll the same `threadId`; retry only a pre-submit provider outage after saved backoff | Ambiguous submission, definitive AC failure, or a rejected video contract |
| P5 — attribution | Route-owned Code and, only for eligible Facebook routes, verified short link | Read-only remote verification and bounded unused-Code advance | Application ownership mismatch, disabled Code, or ambiguous create/link result |
| P6 — package | Exact copy, effective video, route, attribution, warnings, and internal publication draft | Rebuild from saved finished assets | `executionQa: rejected` or a hard execution-control mismatch |
| P7 — SocialEcho | Upload identity, confirmed public URL, full request fingerprint, and external `data.id` | Reconcile an ambiguous result by exact fingerprint | Missing external ID, upload ambiguity, or a non-unique reconciliation match |

P5 may reserve/verify route attribution before copy is rendered so the final
caption can include the exact Code. It remains a locked attribution contract,
not permission to publish.

## Delivery rules

### Image and QA policy

- Video-only campaigns set `posterGenerationRequired: false` by default.
  P3.5 is a side branch; a skipped/failed poster is visible but cannot hold P4,
  P6, or P7.
- `executionQa: pending_manual_review` is a review warning, not a delivery
  deadlock. `executionQa: rejected` remains a hard stop.
- A mismatch in the AC character-reference contract remains a hard stop.

### Paid-media safety

1. Save external submission intent before calling AC or image providers.
2. Save a returned task ID before polling it.
3. Treat timeout/transport uncertainty after submission as `ambiguous`.
4. Only a fresh operator decision may create a replacement after a definitive
   paid failure.

### SocialEcho scheduling

For an explicitly scheduled delivery, P7 may only mark success when all of
the following are true:

```text
status = 1
scheduled_at = future Asia/Shanghai timestamp with +08:00
response.data.id = non-empty
```

`status = 1` without `scheduled_at` is rejected because it can publish
immediately. An unscheduled, explicitly requested review draft uses `status =
0` and remains `external_draft`; it is not described as a scheduled task.

Upload order is fixed:

```text
upload intent -> upload identity -> confirmed upload -> article submission
```

No article request is allowed after a failed or uncertain upload. A response
without `data.id` is `publish_ambiguous`, never a completed P7.

### Reconciliation and idempotency

The reconciliation fingerprint is:

```text
account_id + publish type + caption hash + video/public-url hash + scheduled_at
```

All fields must match exactly. A zero-match result remains ambiguous; a
multi-match result is also ambiguous. Neither case may create another article.

## Worker fairness

The worker chooses a runnable transition, not merely the oldest active run.
A run waiting for AC polling/backoff must not starve P0–P3/P6/P7 work from
other runs. Capacity waits preserve their model, evidence, and
`nextAttemptAt`; they do not turn into generic failure or an unbounded loop.

## Operator view

Each row must display:

- current P-stage and state;
- plain-language block reason and next action;
- `recoverable` plus `nextAttemptAt` where automatic recovery is safe;
- AC task ID / SocialEcho external ID when present;
- target account, platform, and scheduled time;
- whether the outcome is an internal review draft, an external draft, a real
  scheduled task, failed, or ambiguous.

The dashboard must fetch enough rows for the requested campaign; a recent-20
summary must never be used as a completion audit for a 44-item campaign.

## Completion audit

Before saying a campaign is complete, query all expected run IDs and count:

```text
scheduled_external / external_draft
publish_ambiguous
active / capacity queued
definitive paid failure
blocked by human decision
```

Only the first count is delivery. The other four are always listed with their
stored next action and IDs.
