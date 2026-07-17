# NovelFlow Social Console

Standalone Vercel project for `social.novelflow.top`.

- Vercel root directory: `social-console`
- Redis keys: `nf_social:*`; promoter-site user data is never touched
- Runtime credentials: `NOVELFLOW_*` Vercel environment variables only
- Deployment protection must be enabled before the custom domain is attached

Each run is stored at `nf_social:run:<id>` and indexed in `nf_social:runs`.
The production worker will advance persisted stages so browser closes and
function timeouts cannot lose Code/link, video task ID, image task ID, or data.
