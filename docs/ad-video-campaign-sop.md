# Ad Video Campaign SOP

This campaign stops at a SocialEcho `status: 0` draft. It never formally publishes.

## Durable stages

`initialize -> localize -> prepared -> submit -> running -> poll -> completed -> attribute -> draft`

Each paid AC item stores its `remark` before submission and its `threadId` immediately after a definitive response. A timeout, 5xx, or response without an ID becomes `submit_ambiguous`; it is reconciled by the saved remark and never automatically resubmitted.

## Fast operator path

Use one authenticated `POST /api/ad-video-campaign` with `{ "action": "advance", "limit": 6 }` and the server-side `SOCIAL_AD_CAMPAIGN_TOKEN` in `X-NF-Campaign-Token`. Never put the token in source, logs, chat, or browser storage. Repeat only while the returned `nextAction` is non-empty. The endpoint uses a Redis lock so two agents cannot advance the same campaign concurrently. One call can process several non-paid stages and several independently safe item transitions.

The browser UI should call `advance` on a short background timer and render the returned counts. It should not issue one request per book or pretend that a request is complete before the durable state changes.

## Recovery

- `localization_failed`: fix the model configuration or prompt, then use `retry_localization`.
- AC `failed`: use `repair_failed` once. The repair saves `priorThreadId` and `priorRemark`, creates a new revision remark, and requires one fresh paid submission.
- AC `submit_ambiguous`: reconcile by remark; never resubmit automatically.
- SocialEcho `publish_ambiguous`: search the exact account and caption, then reconcile; never create a second draft.

## Routing

- English: NovelFlow Code pool `40000-49999`; Facebook short link allowed.
- Portuguese: AstraNovel, `Portuguese / BR`, Code pool `60000-69999`; Facebook short link allowed.
- Spanish: AstraNovel, `Spanish / MX`, Code pool `60000-69999`; Facebook short link allowed.
- Every draft uses Romance Story House account `13943486`, Facebook Reels, and SocialEcho `status: 0`.
- Captions never contain Code or a URL; export them separately in the attribution table.
