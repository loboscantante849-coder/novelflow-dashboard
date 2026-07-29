# NovelFlow dashboard performance and promotion review design

## User story

As the NovelFlow social operator, I want the dashboard to become useful as soon as it opens, show the current production state without long waits, and translate historical promotion data into a clear book-level decision so that I can decide what to produce or reinvest in without interpreting an unexplained score.

## Scope

- Reduce first-view density and bring the ranking and production controls higher on the page.
- Reduce startup and polling work without removing access to older tasks.
- Replace the historical score-only list with four explicit outcomes: reinvest, observe, pause, and insufficient data.
- Explain every outcome using only fields returned by the verified historical attribution source.
- Keep individual-material attribution explicitly out of scope until Code/link-to-asset mapping is available.

## Technical constraints

- Keep the existing vanilla HTML, CSS, and JavaScript stack.
- Deploy through the existing Vercel project and keep state in isolated `nf_social:*` storage.
- Do not use Coze or add a UI framework.
- Do not change paid image/video retry guarantees or Facebook's manual publishing boundary.
- Do not invent retention. The historical source currently reports retention as unavailable.
- Keep the first response bounded while preserving an explicit path to load older tasks.

## Experience design

The first viewport becomes a compact operating surface: a short command header, a lighter horizontal recommendation rail, and three actionable KPIs. The ranking begins immediately below it. The dark nested recommendation panel is removed so the page reads as one coherent workspace.

Historical promotion review is not presented as a generic ranking. A summary strip shows counts by decision, a filter selects one decision class, and each row states the conclusion, the strongest positive signal, the main risk, and the next action. An inline disclosure provides the exact comparison basis.

Decision rules are cohort-relative inside the selected 3, 7, or 30-day window:

- `reinvest`: confidence is at least 30%, revenue is positive, the existing score is at or above the cohort median, and at least two of volume, first-read rate, revenue, or income-per-UV meet the cohort median.
- `pause`: confidence is at least 30%, but at most one of those signals meets the cohort median.
- `observe`: some evidence exists, but confidence has not reached the decision threshold or signals are mixed.
- `insufficient`: the record has too little evidence to support an action.

These outcomes are book-level summaries of the operator's historical Code/link attribution. They must never be labelled as the performance of one specific post, poster, or video.

## Data flow

```text
verified historical Code/link attribution
        |
        v
GET /api/leaderboard?source=history&days=N
        |
        v
book-level metrics: pull UV, first read, D14 income,
income/UV, confidence, historical score, record count
        |
        v
compare each book with the selected-window cohort medians
        |
        +---- enough evidence + balanced positives ----> suggest reinvest
        +---- enough evidence + weak signals ----------> pause expansion
        +---- mixed / early evidence -------------------> continue observing
        +---- too little evidence ----------------------> insufficient data
        |
        v
visible reason + risk + next action + exact basis
```

Startup performance flow:

```text
local verified snapshot -> immediate paint
        |
        +-> GET /api/status?limit=12 -> current tasks and counters
        +-> GET /api/leaderboard      -> current ranking
        +-> deferred recommendation / plan refresh

"Load older tasks" -> GET /api/status?limit=50
```

## API contract

### `GET /api/status?limit=12|50`

Returns the existing status payload. `limit` is clamped to 12-50 and defaults to 12. The response includes `runLimit` so the browser can show whether older tasks can be requested.

```json
{
  "runs": [],
  "runLimit": 24,
  "capabilities": {},
  "videoLimit": {}
}
```

### `GET /api/leaderboard?source=history&days=3|7|30`

The upstream contract remains unchanged. The browser derives the four transparent review outcomes from the returned cohort. No new external request or model call is needed.

## Failure handling

- Keep the last verified ranking visible when refresh fails.
- If historical metrics are missing, classify the book as insufficient instead of guessing.
- If retention is absent, show that it is unavailable and exclude it from the decision.
- Loading older tasks must not clear the current list while the request is in flight.
- A closed detail drawer must not rebuild hidden asset markup during status polling.

## Verification

- Unit-test all four review outcomes and the explicit missing-retention statement.
- Unit-test that a closed detail drawer does not render hidden details.
- Unit-test the status limit clamp.
- Run the full existing Node test suite and syntax checks.
- Measure production `/api/status` latency and payload before and after deployment.
- Visually inspect desktop and mobile layouts after deployment.
