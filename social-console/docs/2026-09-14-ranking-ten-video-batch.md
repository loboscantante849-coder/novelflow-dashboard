# Ranking ten video batch manifest

- **Purpose:** durable operator manifest for the 10 ranking-selected runs.
- **Created from:** the last read-only `/api/status?limit=12` response saved at **2026-09-14T02:05:18Z** (北京时间 10:05:18).
- **Paid video state at that observation:** `videoGenerationPaused=true`; video usage **0/40**; all ten runs had `P4.status=waiting`, no AC/Tianji thread or provider task ID, and no paid video submission.
- **Delivery rule:** the listed `scheduledAt` values are UTC; `timezone=Asia/Shanghai`; these are SocialEcho scheduled Reels intents and must not be changed to immediate publishing during recovery.
- **Poster generation:** disabled for this batch.

| # | Run ID | Title | SKU | App / product line | Platform / account (ID) | Include link | Scheduled (UTC) | Scheduled (Beijing) | Last P3 state at observation |
|---:|---|---|---|---|---|:---:|---|---|---|
| 1 | `run_47cfbfb824ac48338c545f2b93e87ae6` | The CEO's Unspoken Love | `688c5429bb6fbbd5d12ff69f` | AstraNovel / astranovel | Facebook / AstraNovel (`13943483`) | yes | `2026-09-14T12:20:00.000Z` | 2026-09-14 20:20 | failed — assigned format 0 |
| 2 | `run_e14b82a1ffb344178aaa3df8d2ceb0d8` | Signed the Divorce, Now He's Begging on His Knee | `68ee1e68af2ad710f4a375a5` | NovelFlow / novelflow | Facebook / NovelFlow (`13751295`) | yes | `2026-09-14T11:50:00.000Z` | 2026-09-14 19:50 | failed — assigned format 0 |
| 3 | `run_66af228e7f874430a8da91964bd031b1` | Badass in Disguise | `68623613b5530c32c3858ef1` | AstraNovel / astranovel | Facebook / AstraNovel (`13943483`) | yes | `2026-09-14T13:20:00.000Z` | 2026-09-14 21:20 | failed — cited evidence not exact chapter text |
| 4 | `run_3ad7a3f33b2746f18c879690a5ab7511` | Sold! To the Grizzly Don | `682343b7ec7d173f3dc8db9a` | NovelFlow / novelflow | Instagram / NovelFlow (`13943450`) | no | `2026-09-14T12:45:00.000Z` | 2026-09-14 20:45 | failed — cited evidence not exact chapter text |
| 5 | `run_e10551cbdb2644c197f4b85f6c759838` | The MC Vice President’s Stripper: Son’s Of Doom MC Book 2 | `6a8a2d58033afda73d254ef6` | MaxNovel / maxnovel | Facebook / MaxNovel (`13943482`) | no | `2026-09-14T12:00:00.000Z` | 2026-09-14 20:00 | failed — invalid DeepSeek structured output |
| 6 | `run_b847df9d21cd44d88c1e0906b4d96d15` | Tearing Down the World's Laws for My Broken Daughter | `6a7dab5bcb2231da92f6775a` | MaxNovel / maxnovel | Facebook / MaxNovel (`13943482`) | no | `2026-09-14T12:30:00.000Z` | 2026-09-14 20:30 | failed — assigned format 0 |
| 7 | `run_b896ec2c189f452883815a90f8f8118d` | He Chose Her, I Chose Me | `6a8bb75c66481836d50cc6f5` | MaxNovel / maxnovel | Facebook / MaxNovel (`13943482`) | no | `2026-09-14T13:00:00.000Z` | 2026-09-14 21:00 | failed — assigned format 0 |
| 8 | `run_6476e42807ed4b63b5481a117643ccf7` | The Lycan King's Treasured Luna | `691038500e4a69128f7d32e9` | NovelFlow / novelflow | Facebook / NovelFlow (`13751295`) | yes | `2026-09-14T14:00:00.000Z` | 2026-09-14 22:00 | waiting |
| 9 | `run_012d8e74e79c407ba244c33c392c8343` | How Not To Fall For A Dragon | `68d56a89de38dfa827fe27b6` | NovelFlow / novelflow | Facebook / NovelFlow (`13751295`) | yes | `2026-09-14T15:00:00.000Z` | 2026-09-14 23:00 | failed — invalid DeepSeek structured output |
| 10 | `run_ec239459add44575abe56d3c86447c08` | The CEO Above My Desk | `695cadd8aa733e88f9958e41` | NovelFlow / novelflow | Facebook / NovelFlow (`13751295`) | yes | `2026-09-14T14:30:00.000Z` | 2026-09-14 22:30 | waiting |

## Recovery notes

1. Treat the run IDs and SKUs above as the identity set. Do not create replacement runs for these records.
2. Repair P3 from saved book/chapter evidence and the DeepSeek-only route. Recovery must preserve each campaign `scheduledAt`, platform, account, SKU and the paid pause guard.
3. Before any future paid submission, persist the AC provider task ID, verify the intended scheduled delivery, and keep SocialEcho in scheduled mode (`status=1` with `scheduled_at`).
4. This manifest contains no credentials, provider tokens or full source text.
