# AC Director Control Console

## Purpose

The console separates an operator's intended scene contract from the AC
service's actual execution. Saving a contract or previewing it never creates a
paid AC task. New video and image submissions remain behind their respective
operator pause gates.

## Character Assets

- Character references are generated only through the server-side Meitu/IIIT
  Images provider. The browser never receives an image provider credential.
- The operator supplies a character name, role, and short visual anchors. The
  server combines those bounded fields with the persisted book and video
  evidence into a four-view adult character sheet request.
- Each request is written as `submitting` before the provider call. A timeout
  or an accepted response without an image URL becomes `submit_ambiguous` and
  is never retried automatically.
- Only a managed Meitu asset with `status: ready` and `approved: true` can be
  selected as an AC reference. A browser-supplied image URL is never accepted.

## Template Policy

| Template | References | Policy |
| --- | ---: | --- |
| `Ad_Plot_Seedance` | 0-1 | Production baseline |
| `Ad_Plot_Video_V4` | 0-9 | Experimental, dry-run only |

The UI may show V4 so its contract can be inspected, but the worker and the
manual revision/reference routes refuse to submit it. Promote an alternative
only after a separate single-variable experiment is reviewed.

## Contract Compilation

The same compiler is used for the main P4 video, rewritten video, and
character-reference video. It enforces:

- exact SKU, `num: 1`, and `9:16`;
- a source-grounded chapter window of at most six continuous chapters;
- `enable_subtitles: false`;
- no implicit book-cover reference image;
- reference-image limits based on the selected template;
- stable SHA-256 fingerprint of the entire payload excluding `remark`;
- a deterministic `remark` derived from run ID, video kind, and fingerprint.

Changing the prompt, template, reference order, chapter window, or execution
control changes the fingerprint and remark. A prepared video may be re-frozen
only before any paid submission attempt; after that the contract is locked.

## Lineage

The UI can select only a completed local video with a known thread ID. This is
saved as trace metadata. AC `copy_parent_thread_id` and `copy_thread_id` are
sent only when both values already exist in a persisted local material trace;
the console never guesses or accepts arbitrary parent thread IDs.

## Execution Review

When AC returns a result, the console records bounded execution data from
`result_json`: subtitle state, image-generation state, model, voice, word
count, reference count, storyboard length/hash, and material trace IDs. It
does not keep the raw storyboard text.

If AC reports subtitles enabled despite the contract, or returns a different
reference count, P6 is blocked before a publication draft is created. A media
URL alone is not an approval signal; the result still needs visual fidelity
review and deterministic post-production for captions, Code, link, and CTA.
Every successfully fetched P4 result is marked `pending_manual_review` with
the five fidelity criteria so a playable URL cannot be mistaken for a pass.

## Provider Gates

- `SOCIAL_VIDEO_GENERATION_PAUSED=true` prevents new AC video submissions.
- `SOCIAL_IMAGE_GENERATION_PAUSED=true` prevents new Meitu poster submissions.
- Existing persisted thread/task IDs may still be polled while either gate is
  enabled.
- With console open access enabled, media mutations require a separate
  server-side operator token. Normal authenticated sessions do not expose
  that token to the browser.
