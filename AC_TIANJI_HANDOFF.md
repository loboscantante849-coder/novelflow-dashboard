# Tianji / AC Platform Integration Handoff

This document is the cross-project handoff for the Auto Creative (AC, Tianji)
platform that replaced `ac.beidou.win`. It records what was verified during the
NovelFlow migration, separates verified behaviour from platform-configurable
fields, and gives a secure integration path for another product.

## 1. Executive Summary

The public Tianji pages and its API use different paths:

| Purpose | URL / value |
| --- | --- |
| Copywriting page | `https://ac.anynovel.app/generate/copywriting?projectId=1006` |
| Video page | `https://ac.anynovel.app/generate/video?projectId=1006` |
| Landing-page page | `https://ac.anynovel.app/generate/landingPage?projectId=1006` |
| API base URL | `https://ac.anynovel.app/api/v1` |
| Default project | `1006` |
| Required client header | `x-client: beidou-web` |

Do not configure an API client with `/generate/video`; that is a browser route,
not an API prefix. Do not route new work to `ac.beidou.win`.

`1006` is the project used and verified by this migration, not a claim that an
unrelated Tianji tenant may use it. A separate product must obtain its
authorized project ID from the Tianji owner and configure it server-side.

All three generation modules share the same task lifecycle:

```text
form schema -> POST /creative/by-user -> thread ID
                                      -> GET /creative/paged-list?type=...
                                      -> GET /creative/{threadId}/result
                                      -> optional retry / interrupt
```

The migration live-verified the shared create, list, and result routes against
the current Tianji site. Its retry and interrupt proxy contracts are implemented
and test-covered, but were not invoked against a live task merely for this
migration. Completed video tasks were observed to return playable media and
cover images. The copywriting and landing-page modules use the same lifecycle
but must take their field set from the current form schema rather than reusing
the video request body blindly.

## 2. Platform Model

### 2.1 The three modules

| Module | Page | Typical template(s) observed | List filter | Product integration note |
| --- | --- | --- | --- | --- |
| Copywriting | `/generate/copywriting` | `Ad_Copy`, `Ad_Copy_V2` | `type=text` | Treat output as text/structured copy; render or export only after inspecting the result payload. |
| Video | `/generate/video` | `Ad_Plot_Video_V3`, `Ad_Plot_Video_V2`, `PPT_Porn`, `Ad_Plot_Seedance` | `type=video` | Fully integrated in NovelFlow. Completed task results require media URL extraction. |
| Landing page | `/generate/landingPage` | `Landing_Page` | `type=landing_page` | Treat output as page/copy assets; do not mix it into video history. |

The platform's form UI is schema-driven. `GET /form-schema` is the observed
schema endpoint. Templates, options, required fields, and allowed values can
change by account, project, or platform release. Fetch and cache the current
schema server-side or in an authenticated admin tool before building a new
module. The schema is the source of truth for copywriting and landing-page
payloads.

### 2.2 Common upstream endpoints and confidence

All paths below are relative to `https://ac.anynovel.app/api/v1`.

| Method | Path | Verified use | Important inputs / output |
| --- | --- | --- | --- |
| `GET` | `/form-schema` | Form discovery | Use current schema to build a template-specific request. |
| `POST` | `/creative/by-user` | Create a task | JSON body including `template`; accepted creation responses can expose a task ID as `threadId`, `thread_id`, `task_id`, or `id`, sometimes inside `data` or `creative`. |
| `GET` | `/creative/paged-list?PageSize=N&PageIndex=N&type=TYPE` | List a module's tasks | Returns an object with `items`; pagination fields observed include `total` and `pageCount`. |
| `GET` | `/creative/{threadId}/result` | Read a task's output | Result wrappers vary. Parse known result containers and media fields defensively. |
| `POST` | `/creative/{threadId}/interrupt` | Proxy route and UI action observed; implementation test-covered | Only expose after application-level ownership authorization; validate live with a disposable task before first rollout. |
| `POST` | `/creative/{threadId}/retry` | Proxy route and UI action observed; implementation test-covered | Only expose after application-level ownership authorization; validate live with a disposable task before first rollout. |

The Tianji UI also exposes action route names `continue`, `re-do-video`, and
`re-push` below the same `/creative/{threadId}/...` namespace. They were not
needed by NovelFlow's end-user proxy. Treat them as unverified operational
actions: test them with a disposable task and account before exposing them in
another product.

## 3. Authentication, Headers, and Token Rotation

Every upstream request made by the migration uses these headers:

```http
Authorization: Bearer <Tianji access token>
x-client: beidou-web
X-Project-Id: 1006
Content-Type: application/json        # add for JSON POST requests
```

`Authorization`, `x-client`, and `X-Project-Id` are protocol headers, not
user-controlled client input. A correct project ID is part of the capability
boundary: do not allow a browser caller to select an arbitrary project.

### Token handling rules

1. Keep the Tianji access token in server-only secret storage. In NovelFlow it
   is read from Redis key `ac_token`, falling back to deployment secret
   `AC_TOKEN`.
2. Never send it to a browser, `localStorage`, an API response, analytics,
   exception text, screenshots, or command history. The retired browser-side
   `x-ac-token` / localStorage pattern must not be restored.
3. Tianji may return a replacement token in the response header
   `accesstoken`. Normalize it, then persist it server-side before the next
   request. The header is case-insensitive in HTTP but query it as
   `response.headers.get('accesstoken')` in Fetch.
4. During a migration, a stored Redis token can be stale. On a definite
   upstream `401`, retry the same request once with the independently stored
   `AC_TOKEN`; if the fallback reaches any non-`401` upstream response, repair
   `ac_token`. Do not retry
   timeouts, connection failures, `5xx`, or any ambiguous create request,
   because that can produce duplicate paid work.
5. Convert an upstream Tianji `401` to a local `502` at your proxy boundary.
   A local frontend normally interprets `401` as its own login expiry; an AC
   service credential failure should not log a user out of the host product.

Recommended server configuration:

```dotenv
AC_API_BASE_URL=https://ac.anynovel.app/api/v1
AC_PROJECT_ID=1006
AC_TOKEN=<server-only-tianji-token>
KV_REST_API_URL=<server-only-redis-url>
KV_REST_API_TOKEN=<server-only-redis-token>
```

`AC_API_BASE_URL` takes precedence over the legacy compatibility alias
`AC_BASE_URL`. If another deployment has an old `AC_BASE_URL` pointing at
`ac.beidou.win`, remove it or replace it with the Tianji `/api/v1` URL. A
safe implementation should accept only HTTPS `/api/v1` origins and reject
credentials, private IPs, `localhost`, query strings, fragments, and retired
hosts.

The authorized Tianji browser session currently keeps its access state in
browser storage under `access-token`, but that is an implementation detail of
the Tianji web app, not a client integration mechanism. Do not make a host
product read, relay, or persist that browser value. Provision a server secret
through an approved operator flow and rotate/revoke it through the platform
owner when access changes.

## 4. Request Recipes

### 4.1 A safe shared request helper (Node.js)

This is intentionally a server-side helper. Give `readToken()` and
`persistRotatedToken()` access to secret storage only.

```js
const AC_BASE = process.env.AC_API_BASE_URL || 'https://ac.anynovel.app/api/v1';
const AC_PROJECT_ID = process.env.AC_PROJECT_ID || '1006';

function acHeaders(token, extra = {}) {
  if (!token) throw new Error('Tianji token is not configured');
  return {
    ...extra,
    Authorization: `Bearer ${String(token).replace(/^Bearer\\s+/i, '').trim()}`,
    'x-client': 'beidou-web',
    'X-Project-Id': AC_PROJECT_ID,
  };
}

async function acFetch(path, options = {}) {
  const token = await readToken(); // Redis first, deployment secret fallback
  const response = await fetch(`${AC_BASE}${path}`, {
    ...options,
    headers: acHeaders(token, options.headers),
    signal: AbortSignal.timeout(8000),
  });
  const rotated = response.headers.get('accesstoken');
  if (rotated) await persistRotatedToken(rotated);
  return response;
}
```

Production code should also validate `AC_BASE`, normalize quoted/`Bearer`
prefixed secrets, and implement the single-retry policy described above.

### 4.2 List tasks by module

```js
const type = 'video'; // 'text' for copywriting; 'landing_page' for landing pages
const query = new URLSearchParams({ PageSize: '50', PageIndex: '1', type });
const response = await acFetch(`/creative/paged-list?${query}`);
if (!response.ok) throw new Error(`Tianji list failed: ${response.status}`);
const page = await response.json();
const items = Array.isArray(page.items) ? page.items : [];
```

The precise parameter capitalization above matters: the verified traffic uses
`PageSize` and `PageIndex`. Bound them in your own API. NovelFlow accepts a
client page size only in the range 5-100 and never lets ordinary users query
another module's list.

For a one-off server-side diagnostic, use a placeholder only. Do not paste a
production credential into a shared terminal, shell history, CI log, or ticket.

```bash
curl --fail-with-body -sS \
  'https://ac.anynovel.app/api/v1/creative/paged-list?PageSize=20&PageIndex=1&type=video' \
  -H 'Authorization: Bearer <SERVER_SIDE_TOKEN>' \
  -H 'x-client: beidou-web' \
  -H 'X-Project-Id: 1006'
```

### 4.3 Verified video creation body

The following body is the concrete NovelFlow video contract. It is suitable as
a starting point for the listed video templates; validate available templates
and required fields with `form-schema` before enabling a different template.

```json
{
  "template": "Ad_Plot_Video_V3",
  "relatedBook": { "book_id": "BOOK_ID_FROM_YOUR_BOOK_SYSTEM" },
  "num": 1,
  "language": "English",
  "country": "US",
  "ad_platform": "Facebook",
  "start_chapter": "1",
  "end_chapter": "5",
  "tts_audio_voice": "Female_cur1",
  "user_age_range": "35-40岁",
  "user_gender": "女",
  "units_per_second": "5",
  "aspect_ratio": "9:16",
  "is_generate_img": "true",
  "copy_type": "原创",
  "build_requirement": "",
  "ad_copy": "",
  "word_count": "200词",
  "reference_picture_list": [],
  "remark": "yourapp_alice_1710000000000"
}
```

Send it to `POST /creative/by-user` with the JSON headers in section 3.
Accepted responses have used more than one task-ID shape, so normalize all of
these before saving the task:

```js
function taskIdOf(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  for (const key of ['thread_id', 'threadId', 'task_id', 'taskId', 'id']) {
    if (String(value[key] ?? '').trim()) return String(value[key]).trim();
  }
  for (const key of ['data', 'creative', 'task', 'result', 'item']) {
    const id = taskIdOf(value[key], seen);
    if (id) return id;
  }
  return '';
}
```

Important video-specific findings:

- `is_generate_img` must remain the string `'true'` for the verified
  NovelFlow request. Completed Tianji tasks using this value produced playable
  video; do not change it to `false` on the assumption that it suppresses a
  required image step.
- NovelFlow permits `num` from 1 through 3, `English` or `Spanish`, only
  `9:16`, chapter ranges no wider than 100, up to four reference images, and
  a 4,000-character `ad_copy`. These are host-product safety limits, not a
  promise that all Tianji accounts share the same limits.
- `reference_picture_list` must contain trusted HTTPS media. NovelFlow only
  accepts its Vercel Blob host or an explicit allowlist. Never turn this into
  an unrestricted user-supplied URL fetch.

### 4.4 Copywriting and landing-page creation

Both modules use `POST /creative/by-user`, but the video fields above are not
a generic schema. A safe integration sequence is:

1. Request `GET /form-schema` using the target project headers.
2. Select the desired template (`Ad_Copy` / `Ad_Copy_V2` or `Landing_Page`).
3. Render or validate only the fields required by that current schema.
4. Add a namespaced ownership `remark` and send the schema-backed JSON body to
   `/creative/by-user`.
5. List with `type=text` or `type=landing_page`, then resolve the shared task
   result endpoint.

Do not fabricate field names from the visual form. If the schema changes,
update the server validator and automated tests before deploying it to users.

## 5. Polling, Status, Result Parsing, and Media Delivery

### 5.1 Polling algorithm

1. On successful creation, persist the normalized `threadId`, local owner,
   module type, template, and enough display metadata for a fallback card.
2. Refresh only the appropriate list type; do not use an all-type list for a
   video gallery.
3. Treat `completed`, `done`, `success`, and `2` as terminal success values;
   treat `failed`, `fail`, `interrupted`, and `-1` as terminal failure. Keep
   unknown values in a processing state, because Tianji status vocabulary can
   evolve.
4. For a completed task, call `GET /creative/{threadId}/result`. Do not call
   the result endpoint for every pending card.
5. Poll at a bounded cadence. NovelFlow uses 30 seconds while work is in
   progress, stops when no task is processing, and limits concurrent result
   fetches. Respect `429`, add exponential backoff on `5xx`, and provide a
   manual refresh control.

Do not assume a task will finish within a fixed time. The old UI displayed an
approximate 25 minutes only as a user hint, not as an API guarantee.

### 5.2 Result shapes observed in Tianji

The result endpoint is stable; its JSON shape is not. Live completed tasks
have returned video and cover data through wrappers including:

```text
final_result[].video_url
final_result[].cover_image_url
result_json.video_result.videos[].video_url
final_video_result
processed_video_url
final_video_url
```

Some wrappers may be JSON strings rather than already-parsed objects. The
following compact extractor is the compatibility strategy used by NovelFlow.
It intentionally traverses only known result containers, not every arbitrary
object property.

```js
const WRAPPERS = [
  'final_result', 'finalResult', 'final_video_result', 'finalVideoResult',
  'result_json', 'resultJson', 'video_result', 'videoResult',
  'processed_video_result', 'processedVideoResult', 'media_records',
  'mediaRecords', 'videos', 'materials', 'items', 'results', 'result',
  'data', 'media', 'assets', 'output',
];

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function extractVideoMedia(result) {
  const candidates = [];
  const seen = new Set();
  const visit = (raw) => {
    const value = parseMaybeJson(raw);
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) return value.forEach(visit);
    candidates.push(value);
    WRAPPERS.forEach((key) => visit(value[key]));
  };
  const videoUrl = (item) => {
    const v = item.video;
    return item.final_video_url || item.finalVideoUrl ||
      item.processed_video_url || item.processedVideoUrl ||
      (typeof item.final_video_result === 'string' && item.final_video_result) ||
      (typeof item.video_result === 'string' && item.video_result) ||
      item.video_url || item.videoUrl || item.file_url || item.fileUrl ||
      item.media_url || item.mediaUrl || item.download_url || item.downloadUrl ||
      (typeof v === 'string' && v) || v?.video_url || v?.videoUrl || v?.url ||
      v?.file_url || item.url || '';
  };
  visit(result);
  const item = candidates.find((candidate) => typeof videoUrl(candidate) === 'string' && videoUrl(candidate));
  if (!item) return { videoUrl: '', coverUrl: '' };
  return {
    videoUrl: videoUrl(item),
    coverUrl: item.cover_image_url || item.coverImageUrl || item.cover_url ||
      item.coverUrl || item.thumbnail_url || item.thumbnailUrl ||
      item.poster_url || item.posterUrl || item.preview_image_url ||
      item.previewImageUrl || item.first_frame_url || item.firstFrameUrl ||
      item.video?.cover_image_url || item.video?.thumbnail_url || '',
  };
}
```

Validate any returned URL before putting it into `<video>`, `<img>`, download,
or redirect paths. Require HTTPS, reject credentials and unsafe schemes, and
apply your application's media-host policy. Tianji output URLs may be signed
or short-lived; if durable delivery is necessary and the platform agreement
allows it, copy the completed asset into controlled object storage.

For text and landing pages, use the same wrapper walk but look for the module's
actual text fields. NovelFlow preserves fallback text candidates
`creative_text`, `dialogue_content`, and `landing_page_copy`; another project
should retain the raw result for audit and add schema-specific rendering tests.

## 6. Recommended Host-Product Proxy Contract

Do not expose Tianji directly to a public web client. A narrow host proxy lets
the host product apply its own authentication, ownership, quotas, audit trail,
and response normalization.

| Host endpoint | Upstream route | Required host controls |
| --- | --- | --- |
| `POST /api/ac-create` | `POST /creative/by-user` | Host session, server token, input validation, quota reservation, ownership record, safe `remark`. |
| `GET /api/ac-list` | `GET /creative/paged-list?type=video` | Host session, module filter, strict owner filter, bounded pagination/cache. |
| `GET /api/ac-result?threadId=...` | `GET /creative/{threadId}/result` | Host session, validated ID, owner/admin check before upstream call. |
| `POST /api/ac-retry` | `POST /creative/{threadId}/retry` | Host session, owner/admin check, action rate limit. |
| `POST /api/ac-interrupt` | `POST /creative/{threadId}/interrupt` | Host session, owner/admin check, action rate limit. |
| `POST /api/ac-refresh` | Small `paged-list` probe | Admin-only server credential health check; never accept a browser-provided AC token. |

NovelFlow's useful reference implementation is:

| Responsibility | File |
| --- | --- |
| API base, project ID, header construction, secret normalization | `api/_lib/ac-config.js` |
| Timeout, token fallback, response-token rotation, thread-ID validation | `api/_lib/ac-request.js` |
| Create and video input validation | `api/ac-create.js` |
| Type-filtered, owner-filtered list aggregation | `api/ac-list.js` |
| Result ownership and upstream result proxy | `api/ac-result.js` |
| Retry / interrupt authorization | `api/ac-retry.js`, `api/ac-interrupt.js` |
| Browser status normalization and media extraction | `index.html` |

### Ownership design

At creation, save `threadId -> username` with a bounded TTL. Also put a
namespaced `remark` in each upstream task, for example:

```text
nf_<exact-lowercase-username>_<numeric-timestamp>
```

When listing historical work, filter by the complete parsed remark format,
not a prefix test. `nf_ann_...` must not authorize access to
`nf_ann_x_...`. If an ownership record expires, an optional slow recovery path
can scan only the caller's correct module list and restore ownership after an
exact remark match. Rate-limit that recovery tightly.

## 7. Limits, Timeouts, and Operations

NovelFlow-specific controls are sensible baseline values, not platform-wide
Tianji quotas:

| Area | NovelFlow value | Reason |
| --- | --- | --- |
| Create quota | 7 videos/user/Los Angeles day; 30/IP/day | Prevent one account or network from draining shared capacity. |
| Create batch | 1-3 | Bound cost and fanout. |
| List | 6 requests/user/minute; 30/IP/minute | Listing can scan up to 30 upstream pages. |
| Result reads | 120/user/minute; 360/IP/minute | Supports active cards with a bounded budget. |
| Retry | 10/user/hour; 30/IP/hour | Prevent retry storms. |
| Interrupt | 30/user/hour; 90/IP/hour | Avoid action abuse. |
| Upstream timeout | 8 seconds per proxy request | Avoid indefinite serverless work. |
| List cache | 45 seconds | Avoid repeated page fanout during UI refresh. |
| Task owner metadata | 180 days | Supports delayed video completion/history. |

Reserve create quota atomically before the upstream call. Count failed attempts
too: otherwise repeated failure paths can be used to consume expensive
capacity. Because reservation can make an attempted but failed create count
against quota, communicate that policy plainly in the host UI and log enough
metadata for support.

## 8. Error Mapping and Troubleshooting

| Symptom | Likely cause | What to check / do |
| --- | --- | --- |
| Browser requests `401` then signs the user out | Proxy passed through Tianji credential failure | Map upstream AC `401` to `502`; keep host-session `401` distinct. |
| Upstream returns `401` | Expired/revoked/stale Tianji token or wrong headers/project | Verify server secret, `x-client`, project ID; use one safe environment-token fallback only. |
| Works on page but fails in code | API base was set to a `/generate/...` browser URL | Use `https://ac.anynovel.app/api/v1`. |
| Video history contains copy or landing tasks | No `type=video` query filter | Include `type=video`; use `text` or `landing_page` in their own views. |
| Create succeeds but no local card appears | Task ID expected only in one field | Normalize `threadId`, `thread_id`, `task_id`, `taskId`, and `id`, including wrappers. |
| Card says complete but has no video | Result was read from the wrong wrapper | Use known-wrapper traversal and log redacted key names/shape, not tokens or full sensitive output. |
| User can see another user's task | List/result proxy lacks ownership enforcement | Save ownership at creation, exact-match `remark`, and check it before result/retry/interrupt. |
| Duplicate expensive jobs | Retried a timed-out or ambiguous `POST` | Never automatically replay an unresolved create; show the task list and let a user/admin decide. |
| Intermittent result/list failures | Excess polling, rate limits, short-lived token/media URL, upstream latency | Bound concurrency, cache lists, back off, rotate response token, and re-fetch result only when appropriate. |
| Reference-image SSRF or unexpected asset | Arbitrary URL accepted | Upload to controlled storage or enforce an HTTPS host allowlist before sending `reference_picture_list`. |

For a platform issue that cannot be reproduced from the proxy, use a dedicated
test account and a minimal task. Record request method, path, non-secret
headers (`x-client`, project ID), status, timing, template, and redacted
response shape. Do not include bearer tokens, cookies, signed URLs, book
content that should remain private, or a full production request body in a
ticket.

## 9. New-Project Integration Checklist

1. Confirm the owning Tianji account can access the intended project and all
   three page routes.
2. Store a server-only Tianji token and configure the API base exactly as
   `https://ac.anynovel.app/api/v1`.
3. Build one shared server HTTP client with the three required headers,
   8-second timeout, response `accesstoken` rotation, and one-only `401`
   fallback policy.
4. Start with a read-only `paged-list` health probe for each module type.
5. Fetch and snapshot `form-schema`; implement template-specific validation
   for copywriting and landing pages before allowing user submits.
6. Implement video creation using the verified body above, with a unique,
   exact-match ownership remark and a server-side task record.
7. Implement list, polling, task-ID normalization, and result parsing before
   exposing the Create button.
8. Add owner/admin authorization and rate limits to result, retry, interrupt,
   and any future `continue`/`re-do-video`/`re-push` action.
9. Test one controlled task through create -> list -> result -> media playback;
   then test failed/retry/interrupt flows without creating unbounded work.
10. Add automated tests for headers, URL validation, stale-token fallback,
    task-ID variants, result wrappers, exact remark ownership, and upstream
    `401` mapping.

## 10. Evidence and Maintenance Notes

The migration was validated with the current logged-in Tianji environment:
the three browser modules were inspected, the shared create/list/result routes
were observed, and multiple completed video tasks were checked for playable
video and cover output without creating new paid video work. NovelFlow's
migration test suite covers Tianji base configuration, header construction,
token rotation/fallback, ownership boundaries, type filtering, and media
compatibility.

Tianji is an evolving product. Treat this document as an integration baseline,
not a substitute for the active `form-schema` or a new low-cost verification
run when templates or result formats change. Update this document and the
corresponding contract tests together whenever a new template, output wrapper,
or action is adopted.
