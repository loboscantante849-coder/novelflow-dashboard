# NovelFlow Social Console

Standalone Vercel project for `social.novelflow.top`.

- Vercel root directory: `social-console`
- Redis keys: `nf_social:*`; promoter-site user data is never touched
- Runtime credentials: `NOVELFLOW_*` Vercel environment variables only
- Deployment protection must be enabled before the custom domain is attached

Each run is stored at `nf_social:run:<id>` and indexed in `nf_social:runs`.
The production worker will advance persisted stages so browser closes and
function timeouts cannot lose Code/link, video task ID, image task ID, or data.

## Discord book assistant

`POST /api/discord` is a Discord Interactions endpoint. It supports the
`/find-book` and `/book-help` commands, text excerpts, image attachments, and
the `Find NovelFlow book` message context-menu action.
Requests are persisted under `nf_social:discord:*` and processed by the
existing minute worker. The matcher combines the bookstore UV list, 7/30-day
funnel performance, and content-dashboard rankings for volume, first-read,
20w retention, and profit. A candidate must be confirmed by the requester
before a Discord-specific promotion Code and short link can be created.

In the server, members can use:

- `/find-book` with a quote, title fragment, character name, plot description,
  or screenshot.
- Right-click a message and select `Apps -> Find NovelFlow book` to search the
  message text and image attachments.
- `/book-help` for the concise workflow and confidence-score explanation.

The assistant replies privately by default. It does not read every channel
message or publish social posts automatically. The executable product scope is
documented in [docs/discord-book-concierge-prd.md](docs/discord-book-concierge-prd.md).

Required Vercel environment variables:

- `DISCORD_PUBLIC_KEY` for Ed25519 webhook verification.
- `NOVELFLOW_DISCORD_CHANNEL_NAME_ID` for the authorized attribution channel.
- `NOVELFLOW_DISCORD_CHANNEL_SOURCE` and `NOVELFLOW_DISCORD_CHANNEL_CODE` when
  the bookstore uses values other than `Discord` and `DISCORD`.
- `NOVELFLOW_DISCORD_PROMOTER` for the verified operator name used by link creation.
- `NOVELFLOW_DISCORD_ALLOWED_GUILD_IDS` (comma-separated) and optionally
  `NOVELFLOW_DISCORD_ALLOWED_ROLE_IDS` to restrict access.
- `NOVELFLOW_DISCORD_OPERATOR_TOKEN` (at least 24 characters) for the private
  `GET /api/discord-jobs` audit endpoint. Send it only as the
  `X-NovelFlow-Operator-Token` request header.
- Existing `KV_REST_API_URL`/`KV_REST_API_TOKEN` or `SOCIAL_STORE_URL`/
  `SOCIAL_STORE_SECRET` for isolated Redis state.
- Existing NovelFlow OIDC variables for bookstore and ranking APIs.
- `NOVELFLOW_OCR_MODEL` and either `NOVELFLOW_OCR_API_KEY` or the configured
  copy-model key, plus optional `NOVELFLOW_OCR_BASE_URL`, for screenshot OCR.

Use `.env.example` as the non-secret setup checklist. `DISCORD_BOT_TOKEN` is
needed only on the machine that registers commands and must not be uploaded to
Vercel for this webhook-based assistant.

Before deploying, run `npm run check:discord`. It only reports missing
configuration groups and never prints secret values.

Register commands locally with `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`,
and optional `DISCORD_GUILD_ID`:

```powershell
node scripts/register-discord.js
```

Set the Discord Interactions Endpoint URL to the deployed
`https://<domain>/api/discord`. External code/link writes are persisted before
submission; an ambiguous provider response is marked for manual review and is
never retried by the worker.

`/api/discord-jobs` returns seven-day, privacy-minimized job summaries for
operators: state, candidate scores, selected title, verification state, and
errors. It intentionally excludes Discord interaction tokens, user excerpts,
and raw OCR text.
