# Prototypes (not shipped)

These pages were written as Chinese-language concept prototypes for the NovelFlow
team. They are **not** part of the public product surface and are intentionally
blocked by `middleware.js`:

- `campaign-zh.html` — reward-per-new-reader campaign landing prototype.
- `case-lab-zh.html` — "剧情审判局" hook/voting prototype.

Both are `lang="zh-CN"` while the live site serves English and Spanish, and their
handoff (`novelflow_campaign_book` in localStorage) has no consumer in
`index.html`. Before either concept can ship it needs:

1. English and Spanish copy using the existing `data-i18n` pattern.
2. Reward terms confirmed by the operator (the earlier $100 + VIP budget
   proposal was explicitly rejected as too expensive).
3. A real in-app handoff: deep-link to the matching book or the tasks tab
   instead of an unread localStorage key.
