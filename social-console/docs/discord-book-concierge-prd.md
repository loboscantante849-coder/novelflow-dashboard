# NovelFlow Discord Book Concierge

## Product decision

Turn the Discord assistant into a focused book concierge: identify a NovelFlow
title from an excerpt, screenshot, or selected Discord message; explain the
next safe action; and create a verified Discord attribution package only after
the requester confirms the title.

This is intentionally narrower than the earlier Social Agent proposal. It
keeps the strongest business loop, `discovery -> verified attribution ->
measurable outcome`, without adding platform scraping, unsolicited DMs,
automatic commission payouts, or automatic social publishing.

## Users and jobs

| User | Job to be done | Product response |
| --- | --- | --- |
| Reader or community member | Identify a novel from a quote or screenshot | Ranked candidates, evidence, and similar books |
| Creator | Obtain a usable link/code for a confirmed title | A verified Discord code and short link |
| Community operator | Answer repeated book and attribution questions | `/book-help`, access rules, and auditable job records |
| NovelFlow operator | Prevent incorrect attribution | Confirmation gate, source verification, and manual-review state |

## MVP experience

1. A member uses `/find-book`, attaches a screenshot, or right-clicks a message
   and chooses `Find NovelFlow book`.
2. The bot defers privately, preserves OCR text, and searches the active
   bookstore catalogue plus UV, funnel, volume, first-read, retention, and
   profit rankings.
3. It returns at most three candidates with a calibrated system match score,
   concrete matching evidence, and source labels. A score is not presented as a
   probability or a guarantee.
4. If evidence is weak, it recommends similar titles and asks for more text.
5. The original requester explicitly confirms one candidate.
6. The worker persists the allocated code before calling the external provider,
   verifies code ownership/channel and the enabled short link, then returns the
   attribution package. Ambiguous writes are stopped for manual review.

## Success criteria

- Clear-image OCR success rate: at least 90%.
- Top-three accepted-match rate: at least 80% on a labelled evaluation set.
- High-confidence correction rate: below 10%.
- Verified code/link completion rate: at least 99% for configured channels.
- No automatic retry after an uncertain external write.

## Scope boundaries

Included: Discord interactions, message context action, screenshot/text
matching, FAQ, ranking-informed recommendations, confirmation, link/code
generation, audit state, guild/role access control.

Excluded from this project: scraping BookTok/Instagram profiles, automatic DM
sending, IP/device attribution, automatic payouts, automatic Facebook
publishing, and a separate FastAPI service. Those are distinct products with
platform, privacy, and finance controls that should be approved separately.

## Architecture

```text
Discord Interactions -> Vercel /api/discord -> Upstash Redis queue
                                             -> worker
                                                -> OCR adapter
                                                -> NovelFlow catalogue + rankings
                                                -> DeepSeek constrained rerank
                                                -> verified code/link provider
```

All assistant keys live under `nf_social:discord:*`. Credentials are read only
from Vercel environment variables. The bot does not publish any Facebook
content.

## Delivery order

1. Ship command and context-menu discovery, FAQ, candidate confirmation, and
   safe attribution generation.
2. Build a labelled screenshot/quote evaluation set and tune confidence bands.
3. Add chapter-level evidence and a dedicated vector index when the catalogue
   volume requires it.
4. Add an operator review view for failures and correction feedback.
