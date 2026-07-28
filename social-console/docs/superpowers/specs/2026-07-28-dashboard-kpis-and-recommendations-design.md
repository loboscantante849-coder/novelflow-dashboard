# Dashboard KPIs and trusted daily recommendations

## User stories

- As an operator, I can click a KPI card to immediately see the corresponding task set instead of interpreting a passive number.
- As an operator, I only see daily book recommendations backed by sufficient, verified content-dashboard metrics.
- As an operator, I do not see model token-share or a verbose model ledger in the production overview.

## Scope and constraints

- Remove the model-share KPI and model ledger from the overview; retain model details only inside individual task details.
- Keep the existing three KPI totals: active runs, usable assets, and items requiring attention.
- Use only `content_dashboard_performance` catalog data for daily recommendations; never substitute bookstore data or zero-metric records.
- Do not alter production workers, paid-media submission, Facebook manual-publish policy, or task state persistence.

## Interaction design

- Each KPI is an accessible button with an active state and a concise subtitle explaining its filter.
- Active: queued/running runs.
- Usable: runs with at least one completed copy, verified poster, or playable video.
- Attention: failed, blocked, ambiguous, or partially completed runs.
- Selecting a KPI switches the task list to the matching set and scrolls to it. Selecting it again restores all operations.

## Recommendation policy

1. Read verified 7-day catalog data.
2. Admit a book only when UV is at least 20 and it has a non-zero first-read rate plus a non-zero 10w or 20w retention metric.
3. Score eligible books with normalized UV (40%), first-read (25%), long-read retention (25%), and profit (10%), then apply a UV confidence factor so low-sample rates cannot dominate.
4. If fewer than six books pass, use the verified 30-day catalog with a UV threshold of 80; the UI explicitly labels that window.
5. If no window has enough eligible books, show a transparent empty state instead of recommending weak data.

## Data flow

```text
content-dashboard verified catalog
  -> sample + metric completeness gate
  -> confidence-adjusted composite score
  -> daily recommendation rail

run summaries
  -> KPI counts
  -> click filter state
  -> task list + selected card feedback
```

## API contract

No new endpoint is required. The existing `GET /api/leaderboard` remains the source:

- `source=catalog`
- `days=7|30`
- `sort=baseReadUnt`
- existing NovelFlow, EN, completed, active filters

The client treats `dataQuality=verified_metrics|stale_verified_metrics` as the only eligible provenance and performs recommendation gating locally.

## Test plan

- Unit-test rejection of zero/low-UV and incomplete-metric records.
- Unit-test confidence-adjusted ordering and 30-day fallback selection.
- Unit-test each KPI filter and active toggle.
- Run the existing frontend suite and syntax check; verify the deployed rail never renders a zero-UV recommendation.
