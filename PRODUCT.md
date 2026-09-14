# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

NovelFlow 推广员在站内选择小说、制作传播素材、创建可追踪推广链接，并根据访问与新读者数据调整推广内容。活动可面向现有推广员，也可作为新推广员的首次上手路径。

## Product Purpose

NovelFlow 把书库发现、推广素材制作、可追踪链接与二维码、发布任务、推广数据和收益管理放在同一工作流中。成功不是单次领到奖励，而是推广员能持续找到有效的“书 × 钩子 × 素材 × 渠道”组合，并带来可验证的新读者。

## Positioning

NovelFlow 的独特机制是闭合小说推广实验：推广员可以从真实书库与近期推广表现出发，生成或调用对应素材，用自己的链接发布，再回到同一平台查看归因结果并继续迭代。

## Operating Context

推广员主要在移动端浏览书目、生成链接或短视频、复制文案与二维码，随后发布到 Facebook、Instagram、TikTok、YouTube、X、Threads 等公开渠道，再回到 NovelFlow 查看推广访问、新读者、素材状态和任务进度。

## Capabilities and Constraints

- 已有书目搜索、分类推荐与基于最近 7 天实测推广访问的榜单。
- 已有推广链接和推广 code 创建、复用与归属保护。
- 已有带推广目标的二维码卡片生成。
- 已有 AI Reel 创建、个人 Reel 素材库，以及按书名查询现成视频素材的接口。
- 已有公开社交帖链接提交与人工审核流程。
- 已有推广访问、App 新读者、收益及推广员网络数据。
- 已有 Campaign Missions、签到、VIP、钱包与 Recommender 身份；这些激励不能替代推广工作流本身。
- 当前主站用户语言为英文和西班牙文；本活动策划与原型按用户要求使用中文。
- “有效新读者”的自动结算需要可靠的首次注册与阅读证据；证据不足时必须显示待核验，不能用链接存在或点击量替代。

## Brand Commitments

保留 NovelFlow 名称、真实书库内容、推广员工作台及现有功能边界。活动表达以具体操作、真实状态和可复用经验为主，不以送钱、虚假倒计时或无法证实的收益承诺吸引参与。

## Evidence on Hand

- 主应用与推广流程：`index.html`
- 书目与趋势接口：`api/books/search.js`、`api/trending-books.js`
- 二维码推广：`api/qr-promotion.js`
- 视频素材：`api/ac-create.js`、`api/ac-list.js`、`api/xmp-materials.js`
- 社交发布记录：`api/social-store.js`
- 13 本已确认书目：仓库上层 `books_13_confirmed.json` 与 `novels_full_text_13/`
- 尚无经过确认的活动转化基准、用户证言或真实剩余名额，页面不得伪造。

## Product Principles

1. 先让推广员完成一次真实推广实验，再谈奖励。
2. 每个活动步骤都复用或增强一个现有产品能力。
3. 用同一本书的多角度内容测试沉淀可复用经验，而非鼓励无差别群发。
4. 点击、注册、阅读与结算状态分别呈现，不混为一谈。
5. 活动结束后，参与者仍应留下可继续使用的链接、素材与个人推广档案。

## Accessibility & Inclusion

核心流程需适配 360–390px 移动端；主要触点至少 44px，状态不能只依赖颜色，长英文及西班牙文书名不得造成横向溢出。
