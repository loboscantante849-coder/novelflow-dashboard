# NovelFlow书籍推荐官 — 平台技术设计说明书

**项目名称**: NovelFlow书籍推荐官（CPS聚合推广平台）  
**技术负责人**: 徐敬涛  
**文档版本**: v1.0  
**日期**: 2026-05-26  

---

## 一、产品定位与设计逻辑

### 1.1 一句话定义

NovelFlow书籍推荐官是一个面向海外社媒KOC的**CPS分销聚合平台**，核心目标是让小说爱好者以最低门槛生成推广链接、追踪收益数据、生产推广内容，形成「推书→引流→付费→分佣」的闭环。

### 1.2 为什么做聚合站（而不是直接用书城后台）

| 问题 | 书城后台的痛点 | 聚合站的解法 |
|------|--------------|------------|
| KOC不会用书城后台 | 后台是管理员视角，操作复杂 | 一站式：搜索→生成链接→复制，3步完成 |
| 数据不透明 | KOC看不到自己推的数据 | 实时数据面板，每条链接的点击/注册/收入可见 |
| 内容生产力低 | KOC自己剪视频成本高 | AI视频一键生成，7条/天免费额度 |
| 身份归属感弱 | KOC只是个推广渠道 | 积分/VIP/签到体系，推荐官身份感 |
| 多语言障碍 | 书城后台只有中文 | EN/ES一键切换，西语市场独立适配 |

### 1.3 核心业务流程

```
KOC登录 → 搜索书籍 → 生成专属链接+邀请码 → 社媒推广
                                              ↓
读者点击链接/输入码 → 进入App阅读 → 产生付费/广告收入
                                              ↓
平台统计D14数据 → 按佣金阶梯结算 → KOC提现
```

---

## 二、系统架构

### 2.1 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | 单页HTML (`index.html`) | 原生JS，零框架依赖，4 Tab SPA；旧 `/app-v2*` 路径由 Vercel rewrite 兼容 |
| 后端 | Vercel Serverless Functions | Node.js，`/api/*.js` |
| 数据存储 | Upstash Redis + 只读流水线快照 | 用户、推广与钱包状态存入 Redis；统计快照由自动化流水线更新 |
| 缓存/KV | Upstash Redis | Token缓存、密码存储、书籍缓存、限流计数 |
| 认证 | 自建JWT + OIDC代理 | 用户系统+书城API代理双重认证 |
| 部署 | Vercel | `main` 分支触发生产部署，审核分支生成 Preview |

### 2.2 前端页面结构

4个Tab，对应KOC的4个核心场景：

```
┌─────────────────────────────────────────┐
│  Home  |  Earn  |  Tasks  |  Profile    │
├─────────────────────────────────────────┤
│ 书籍发现  链接生成  任务激励  个人中心    │
│ &推荐    &数据    &积分    &设置         │
└─────────────────────────────────────────┘
```

---

## 三、功能模块详解

### 3.1 Tab 1: Home（书籍发现与推荐）

**功能**: 书籍浏览、搜索、一键推荐

**核心函数**:
- `loadBooks()` — 加载书籍列表，4层fallback策略
- `searchBooks(query)` — 搜索书籍，调用 `/api/books/search`
- `renderBookList()` / `renderBookScroll()` / `renderRankList()` — 不同展示模式
- `openRecommendModal(bookId)` — 打开推荐弹窗
- `confirmRecommend()` — 确认推荐，调用 `/api/confirm`
- `generateRecommendText(book)` — 自动生成推书文案

**数据加载4层Fallback**:
```
1. trending-books API (带语言参数) →
2. trending-books API (不带语言) →
3. books/search API →
4. featured-books.json (本地静态文件)
```

**设计逻辑**: CPS场景下KOC只推免费可读的书。搜索已屏蔽可购买书籍——付费书会伤转化率和KOC对用户的信任度。

---

### 3.2 Tab 2: Earn（链接生成 + AI视频 + My Reels）

#### 子模块1: 链接生成

**核心函数**:
- `handleSubmit()` — 提交书籍搜索→候选匹配→创建链接
- `createLink(book, discordUsername)` — 调用 `/api/confirm` 创建链接+码
- `showCandidates(candidates, discordUsername)` — 展示搜索候选
- `selectCandidateAndCreate(index, discordUsername)` — 选中后创建

**创建链接流程**:
```
前端搜索 → /api/books/search 获取候选
  → 用户选择书籍
  → POST /api/confirm (bookName, bookId, discordUsername, lang)
  → 后端: 保存submissions.json + 调书城API创建code + 创建短链
  → 返回: code + shortUrl + linkId
```

#### 子模块2: AI视频生成（AC Reels）

**核心函数**:
- `doCreateReel(bookId)` — 创建视频任务，调用 `/api/ac-create`
- `switchReelMode(mode)` — 切换视频模板
- `loadMyReelsAssets()` — 加载用户reels资产
- `updateReelsDailyInfo()` / `updateReelsStatusBar()` — 额度状态条
- `listMyReels()` — 列出所有reels

**当前站内调用链**:

```
Earn → doCreateReel()
  → POST /api/ac-create（站内 JWT，不接收客户端 AC Token）
  → 服务端读取 Redis ac_token（回退 AC_TOKEN）
  → POST https://ac.anynovel.app/api/v1/creative/by-user
  → 返回 thread_id
  → My Reels 调 /api/ac-list（type=video）
  → 已完成任务再调 /api/ac-result
```

**视频创建请求体**:
```javascript
{
  template: 'Ad_Plot_Video_V3',  // 📖默认 | 🔥PPT_Porn | 🎥Ad_Plot_Video_V2
  relatedBook: { book_id },       // 服务端由 book_id 组装
  num: 1,
  language: 'English',
  start_chapter / end_chapter,   // 可选：章节范围
  build_requirement,             // 可选：自然语言描述需求
  aspect_ratio: '9:16',
  tts_audio_voice: 'Female_cur1',
  user_age_range: '35-40岁',
  user_gender: '女',
  units_per_second: '5',
  is_generate_img: 'false',       // 天机字段含义是“是否只生成图片”
  copy_type: '原创'
}
```

**额度控制**: 7条/人/天。前端 `getReelsDailyCount()` 仅用于提示；后端以 Redis 原子计数按 username/IP 强制限流。

**状态条设计**: `🎬 X reels · Y left today + View all →`

#### 子模块3: My Reels资产

替代原Asset Library（XMP逻辑已删除），展示用户自己生成的reels。调用 `/api/ac-list` + `/api/ac-result` 获取状态和结果；前端兼容天机返回的 `final_video_result.video_url`、`video_result.videos[].video_url`、`processed_video_url`、`final_video_url` 等形态。

> 文案生成和落地页生成属于天机平台的另外两个入口（见 5.2），NovelFlow 当前只开放视频创作与 My Reels，不会把这两类任务混入视频列表。

---

### 3.3 Tab 3: Tasks（签到 + 任务 + 积分 + VIP兑换）

**核心函数**:
- `doCheckinV2()` — 执行签到
- `claimMission(missionId)` — 领取任务奖励
- `exchangeVIP()` — 积分兑换VIP（100pts → 3天VIP，需绑定NF ID）
- `getUserPoints()` / `addUserPoints(pts)` — 积分读写
- `computePointsChecksum()` / `verifyPointsIntegrity()` — 积分校验和防篡改
- `renderMilestoneTrack()` — 里程碑轨道UI
- `submitBindId()` — 绑定NovelFlow ID（兑换VIP前置条件）

**积分体系**:

| 来源 | 积分 | 说明 |
|------|------|------|
| 每日签到 D1-D5 | 5/天 | 连续签到递增 |
| D6 | 10 | |
| D7 | 15 | 周日里程碑 |
| 分享1本书 | 20 | 推荐书籍任务 |
| 分享3本书 | 50 | 进阶任务 |
| 绑定NF ID | 30 | 一次性 |
| 分享App | 50 | 一次性 |
| VIP兑换 | -100 | 100pts→3天VIP |

**设计逻辑**: 积分是KOC的"软激励"，让推荐官有佣金之外的留存动力。门槛100pts+必须绑定NF ID防止薅羊毛。当前校验在前端（checksum机制），后端校验待加固。

**积分保护机制**:
- `MAX_POINTS = 5000` 上限
- `computePointsChecksum()` SHA256校验和
- `verifyPointsIntegrity()` 每次读取时验证
- UTC时间戳防止时区作弊
- ⚠️ 前端校验可被绕过，后端校验为P0优先级（见安全审计）

---

### 3.4 Tab 4: Profile（个人中心）

**核心函数**:
- `checkLoginStatus()` — 检查JWT登录态，调用 `/api/auth/me`
- `handleLocalRegister()` — 注册，调用 `/api/auth/register`
- `handleSplashLogin()` — 登录（支持纯用户名/用户名+密码），有fallback离线登录
- `handleLogout()` — 登出，调用 `/api/auth/logout`
- `loadUserStats(username)` — 加载用户推广数据，调用 `/api/my-stats`
- `loadMyBooks()` / `saveMyBooks()` — 我的书籍管理
- `updateProfileUI()` — 更新Profile界面

**子模块**:
- **My Books**: 用户创建过链接的书籍，支持复制链接、重新创建
- **PayPal Withdrawal**: 提现入口（开发中🚧），点击弹窗提示Coming Soon
- **Set Password**: 设置/修改密码弹窗，调用 `/api/auth/set-password`
- **数据面板**: 调用 `/api/my-stats` 展示点击/注册/D14收入

---

## 四、后端API清单

### 4.1 认证系统 (`/api/auth/*`)

| 端点 | 方法 | 说明 | 认证方式 |
|------|------|------|---------|
| `/api/auth/register` | POST | 注册（支持可选password） | 无 |
| `/api/auth/login` | POST | 用户名+密码登录 | 无 |
| `/api/auth/logout` | POST | 登出，清除Cookie | 无 |
| `/api/auth/me` | GET | 检查当前登录态 | JWT Cookie |
| `/api/auth/check-password` | REMOVED | Password status is exposed only to the authenticated user via `/api/auth/me` | N/A |
| `/api/auth/set-password` | POST | 设置/修改密码 | JWT Cookie |
| `/api/auth/callback` | GET | Discord OAuth回调 | Discord OAuth |
| `/api/auth/discord-activity` | GET | Discord活动数据 | Discord API |

**认证流程**:
```
1. 新用户: POST /register {username} → JWT写入Cookie + localStorage
2. 有密码用户: POST /login {username, password} → 校验Redis哈希 → JWT
3. 已登录: Cookie中nf_token自动验证，/api/me确认身份
4. 设密码: POST /set-password {password} → SHA256+盐哈希 → 存Redis nf_user_pass:{username}
```

**JWT结构**:
```javascript
payload = {
  type: 'local',
  username: cleanUsername,
  novelFlowId: 'NF' + timestamp后6位 + 4位随机,
  iat: timestamp
}
// HS256签名，密钥来自JWT_SECRET环境变量
```

---

### 4.2 链接与推广

| 端点 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/api/submit` | POST | 提交书籍搜索请求 | 无 |
| `/api/confirm` | POST | 确认推荐→创建链接+码 | IP限流5次/小时 |
| `/api/submissions` | GET | 获取submissions列表 | admin key看完整数据 |
| `/api/books/search` | GET | 搜索书籍 | 无 |

**`/api/confirm` 核心流程**:
```
1. IP限流检查 (5次/小时, 内存Map)
2. 读取 submissions.json (GitHub Contents API, GET)
3. 追加新submission (status: "processing")
4. 保存到GitHub (PUT GitHub Contents API，需SHA乐观锁)
5. 调书城API创建搜索码 (POST /book/savebookpromotionkeywords)
   - 码从STARTING_CODE=4670递增，尝试直到成功
6. 调书城API创建短链 (生成 social.novelplatform.vip/s/{hash})
7. 更新submission为completed (code + link + linkId + campaignId)
8. 返回 code + shortUrl + linkId
```

---

### 4.3 数据与统计

| 端点 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/api/my-stats` | GET/POST | 获取用户推广数据 | username参数 |
| `/api/update-stats` | POST | 更新统计数据 | admin key |
| `/api/trending-books` | GET | 获取热门书籍(带Redis缓存) | 无 |

**`/api/my-stats` 数据聚合逻辑**:
```
1. 读取GitHub data.json (fetch_koc_data.py每日更新，含北斗+putreport数据)
2. 读取 link-stats.json (89条链接统计)
3. 读取 submissions.json (用户创建的链接记录，按username筛选)
4. 合并计算: unique users / new users / D14收入 / 北斗visits
5. 当userData为null或totals=0时，从link-stats聚合fallback
```

**`/api/trending-books` 缓存策略**:
- Redis缓存24小时，key: `trending_v3_{lang}_{category}`
- 参数: `mode=trending|category|browse`, `lang=en|es`, `limit=20-50`
- 数据源: NovelSpa `/book/booklist?orderBy=uv&orderType=desc`

---

### 4.4 AI视频系统 (`/api/ac-*`)

| 端点 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/api/ac-create` | POST | 创建视频任务 | 站内 JWT；AC Token 仅服务端读取（KV→env） |
| `/api/ac-list` | GET | 列出用户视频任务 | 站内 JWT |
| `/api/ac-result` | GET | 获取任务结果 | 站内 JWT |
| `/api/ac-health` | GET | AC服务健康检查 | 无 |
| `/api/ac-refresh` | POST | 校验并轮换 AC Token | 管理员 JWT 或 admin key |
| `/api/ac-interrupt` | POST | 中断任务 | 站内 JWT + 任务所有权 |
| `/api/ac-retry` | POST | 重试任务 | 站内 JWT + 任务所有权 |
| `/api/ac-kv` | POST | 设置KV存储的Token | admin key |

**AC API代理架构**:
```
前端 → /api/ac-create → 后端代理 → 天机 /api/v1/creative/by-user
                               ↑
                        Token来源优先级:
                        1. Upstash Redis (ac_token key)
                        2. AC_TOKEN 环境变量
```

所有上游请求都带 `Authorization: Bearer …`、`x-client: beidou-web`、`X-Project-Id: 1006`。天机响应若返回 `accesstoken`，六个代理会在服务端轮换写回 Redis；客户端永远看不到该 Token。

迁移兼容：若 Redis 中残留的旧 Token 被天机明确返回 `401`，代理只对同一请求使用 `AC_TOKEN` 重试一次，并在成功接受后修复 `ac_token`；超时、断线等不确定结果不会自动重试。

**视频额度后端限流**: Redis 原子计数，7条/username/天、30条/IP/天；`/api/ac-list`、`/api/ac-result`、重试和中断另有读/动作限流。

---

## 五、外部系统集成

### 5.1 NovelSpa书城后台 (admin.novelspa.app)

**认证**: 钉钉OIDC Password Grant自动刷新

```
OIDC Token URL: https://sts.anystories.app/connect/token
Client ID: AuthClient
Grant Type: password
Scope: openid profile roles email offline_access
```

**调用链**: `api/_lib/oidc-token.js` → `getFreshToken()` → `getBookstoreToken()`

**Token缓存**: 内存缓存，过期前5分钟自动刷新。失败则fallback到 `NOVELSPA_TOKEN` 环境变量。

**调用的API**:
- `GET /novelmanage/book/booklist` — 书籍搜索（参数: `bookName`, `applicationId=642fc1ace309494378a774a6`, `languageCode`, `orderBy=uv`）
- `POST /novelmanage/book/savebookpromotionkeywords` — 创建搜索码+短链

### 5.2 Auto Creative / 天机平台 (ac.anynovel.app)

**网页入口**: `https://ac.anynovel.app/generate/video`

**API基础URL**: `https://ac.anynovel.app/api/v1`（网页路径 `/generate/video` 不是 API 前缀）。可用 `AC_API_BASE_URL` 覆盖，但生产应保留天机地址。

**三大生成模块**:

| 模块 | 网页入口 | 常用模板/接口 |
|------|----------|---------------|
| 文案生成 | `/generate/copywriting` | `Ad_Copy` / `Ad_Copy_V2`，`POST /creative/by-user` |
| 视频生成 | `/generate/video` | `Ad_Plot_Video_V3`、`Ad_Plot_Video_V2`、`Ad_Plot_Seedance` 等，`POST /creative/by-user` |
| 落地页生成 | `/generate/landingPage` | `Landing_Page`，`POST /creative/by-user` |

字段与选项由 `GET /form-schema` 驱动；三类任务共享线程、列表和结果接口。天机文案与落地页列表分别使用 `type=text`、`type=landing_page`；NovelFlow 的视频代理固定传 `type=video`，从而不会混入其它模块。

**核心接口**:

- `POST /creative/by-user` — 创建任务
- `GET /creative/paged-list?PageSize=…&PageIndex=…&type=video` — 分页列表
- `GET /creative/{thread_id}/result` — 结果
- `POST /creative/{thread_id}/interrupt|retry|continue|re-do-video|re-push` — 任务操作

**请求头**:
```
Authorization: Bearer {token}
x-client: beidou-web
X-Project-Id: 1006
Content-Type: application/json
```

**视频模板**:

| 模板名 | 说明 | 适用场景 |
|--------|------|---------|
| `Ad_Plot_Video_V3` | 📖剧情视频 | 默认，通用推书 |
| `PPT_Porn` | 🔥爆款模板 | 强情绪冲击 |
| `Ad_Plot_Video_V2` | 🎥剧情V2 | 备用模板 |

**注意**: `/api/ac-*` 只在服务端代理天机 API；不要恢复旧的浏览器 `localStorage` / `x-ac-token` 注入方案。

### 5.3 北斗数据分析 (beidou.win)

**项目ID**: 1006

**用途**: 推广链接的visits/unique visitors数据，用于 `/api/my-stats` 数据聚合。

**数据更新**: `fetch_koc_data.py` 每日从putreport API拉取，更新 `data.json`。

### 5.4 GitHub Contents API

**仓库**: `loboscantante849-coder/novelflow-dashboard`

**用途**: 持久化存储（submissions.json / data.json / link-stats.json）

**认证**: `GITHUB_TOKEN` 环境变量（PAT，需repo权限）

**操作**:
- `GET /repos/{owner}/{repo}/contents/{path}` — 读取文件+获取SHA
- `PUT /repos/{owner}/{repo}/contents/{path}` — 写入文件（需SHA做乐观锁）

### 5.5 Upstash Redis

**环境变量**: `KV_REST_API_URL` + `KV_REST_API_TOKEN`

**用途**:

| Key | 说明 | TTL |
|-----|------|-----|
| `ac_token` | AC API Token缓存 | 永久 |
| `nf_user_pass:{username}` | 用户密码哈希 | 永久 |
| `trending_v3_{lang}_{category}` | 书籍列表缓存 | 24小时 |

---

## 六、环境变量清单

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `JWT_SECRET` | ✅ | JWT签名密钥，至少32字符随机串 |
| `GITHUB_TOKEN` | ✅ | GitHub PAT，读写submissions.json |
| `OIDC_USERNAME` | ✅ | NovelSpa后台OIDC用户名 |
| `OIDC_PASSWORD` | ✅ | NovelSpa后台OIDC密码 |
| `KV_REST_API_URL` | ✅ | Upstash Redis URL |
| `KV_REST_API_TOKEN` | ✅ | Upstash Redis Token |
| `AC_TOKEN` | ⚠️ | 天机 API Token 回退值（也可通过 `/api/ac-kv` 写入 Redis `ac_token`） |
| `AC_API_BASE_URL` | 可选 | 天机 API 根地址，默认 `https://ac.anynovel.app/api/v1` |
| `AC_PROJECT_ID` | 可选 | 天机项目 ID，默认 `1006` |
| `AC_BASE_URL` | 迁移时检查 | 历史兼容别名；若已存在旧北斗值，须删除或改为天机 `/api/v1`，否则会覆盖默认地址 |
| `DISCORD_CLIENT_ID` | 可选 | Discord OAuth Client ID |
| `DISCORD_CLIENT_SECRET` | 可选 | Discord OAuth Client Secret |
| `ADMIN_KEY` | 可选 | 管理员接口密钥 |
| `NOVELSPA_TOKEN` | 可选 | OIDC fallback token |

---

## 七、CORS与安全配置

### 7.1 CORS白名单

```javascript
const ALLOWED_ORIGINS = [
  'https://novelflow-dashboard.vercel.app',
  'https://loboscantante849-coder.github.io',
  'http://localhost:3000',   // ⚠️ 待移除
  'http://localhost:8080'    // ⚠️ 待移除
];
// 匹配方式: startsWith() — ⚠️存在子域名滥用风险，需改为精确匹配
```

### 7.2 Cookie安全

```javascript
// nf_token — 已加固
`nf_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
// nf_user — ⚠️缺少 HttpOnly/Secure/SameSite
`nf_user=${JSON.stringify({username})}; Path=/; Max-Age=2592000`
```

### 7.3 限流

| 端点 | 限制 | 实现方式 | 问题 |
|------|------|---------|------|
| `/api/confirm` | 5次/IP/小时 | 内存Map | Serverless每次重置 |
| `/api/ac-create` | 7次/用户/天 | 内存Map | 同上 |
| 其他 | 无 | — | 无限流 |

---

## 八、i18n国际化

### 8.1 实现方式

HTML元素加 `data-i18n` 属性，JS维护 `I18N` 翻译字典：

```javascript
const I18N = {
  en: { nav_home: 'Home', nav_earn: 'Earn', ... },
  es: { nav_home: 'Inicio', nav_earn: 'Ganar', ... }
};
function getText(key) { return I18N[AppState.currentLang]?.[key] || key; }
```

### 8.2 语言切换

右上角固定按钮，`switchLang('es')` → `applyTranslations()` → 遍历所有 `data-i18n` 元素更新文本。搜索API的 `lang` 参数同步切换。

---

## 九、部署与发布

| 分支 | 用途 | 部署目标 |
|------|------|---------|
| `main` | 代码分支 | Vercel自动部署（production） |
| `codex/*` | 审核分支 | Vercel Preview，通过后合并到 `main` |

**发布流程**: 推送审核分支 → 验证 Vercel Preview → 合并 PR → Vercel 自动发布生产。

**域名**:
- `novelflow.top` — 正式站点
- `novelflow-dashboard.vercel.app` — Vercel 项目域名

---

## 十、数据流全景

```
                         ┌──────────────────────┐
                         │   KOC浏览器           │
                         │   (index.html SPA)   │
                         └──────┬───────────────┘
                                │
                 ┌──────────────┼──────────────┐
                 │              │              │
          ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
          │ /api/confirm │ │/api/ac-* │ │/api/my-stats│
          │  链接创建    │ │ 视频代理  │ │  数据查询    │
          └──────┬──────┘ └────┬─────┘ └──────┬──────┘
                 │              │              │
     ┌───────────┤              │        ┌─────┘
     │           │              │        │
┌────▼────┐ ┌───▼────┐   ┌────▼────┐ ┌──▼───────┐
│Upstash  │ │NovelSpa│   │AC API   │ │GitHub    │
│Redis    │ │书城API │   │(beidou) │ │统计快照   │
│业务状态 │ │(OIDC)  │   │         │ │(只读)    │
└─────────┘ └────────┘   └─────────┘ └──────────┘
     │           │              │
     ▼           ▼              ▼
 submissions.json         ac_token (Redis)
 (推广记录+code+link)
```

---

## 十一、已知安全待加固项

详见 [SECURITY_AUDIT.md](./SECURITY_AUDIT.md)，优先级摘要：

| 级别 | 问题 | 状态 |
|------|------|------|
| P0 | OIDC凭证硬编码在oidc-token.js | ❌ 待修 |
| P0 | 积分/VIP/签到前端可篡改 | ❌ 待加后端校验 |
| P0 | JWT_SECRET弱默认值 | ❌ 待移除fallback |
| P1 | 密码哈希SHA256→bcrypt | ❌ 待升级 |
| P1 | CORS startsWith→精确匹配 | ❌ 待修 |
| P1 | 限流内存Map→Redis | ❌ 待迁移 |
| P1 | nf_user Cookie缺HttpOnly | ❌ 待修 |
| P1 | 注册无防刷机制 | ❌ 待加 |

---

*文档结束。如有疑问请联系徐敬涛。*
