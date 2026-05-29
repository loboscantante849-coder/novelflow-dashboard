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
| 前端 | 单页HTML (app-v2.html, ~70KB) | 原生JS，零框架依赖，4 Tab SPA |
| 后端 | Vercel Serverless Functions | Node.js，`/api/*.js`，23个端点 |
| 数据存储 | GitHub Contents API (submissions.json) | 轻量级持久化，通过PAT认证读写 |
| 缓存/KV | Upstash Redis | Token缓存、密码存储、书籍缓存、限流计数 |
| 认证 | 自建JWT + OIDC代理 | 用户系统+书城API代理双重认证 |
| 部署 | Vercel (自动) + GitHub Pages (手动) | main分支触发Vercel自动部署 |

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

**视频创建请求体**:
```javascript
{
  template: 'Ad_Plot_Video_V3',  // 📖默认 | 🔥PPT_Porn | 🎥Ad_Plot_Video_V2
  relatedBook: { book_id },
  num: 3,
  language: 'English',
  start_chapter / end_chapter,   // 可选：章节范围
  build_requirement,             // 可选：自然语言描述需求
  aspect_ratio: '9:16',
  tts_audio_voice: 'Female_cur1',
  is_generate_img: 'true',
  copy_type: '原创'
}
```

**额度控制**: 7条/人/天。前端`getReelsDailyCount()`读localStorage，后端`checkReelsDailyLimit()`按username/IP限流。

**状态条设计**: `🎬 X reels · Y left today + View all →`

#### 子模块3: My Reels资产

替代原Asset Library（XMP逻辑已删除），展示用户自己生成的reels。调用 `/api/ac-list` + `/api/ac-result` 获取状态和结果。

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
| `/api/auth/check-password` | POST | 检查用户是否设了密码 | 无 |
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
| `/api/ac-create` | POST | 创建视频任务 | AC Token (KV→env→header) |
| `/api/ac-list` | GET | 列出用户视频任务 | AC Token |
| `/api/ac-result` | GET | 获取任务结果 | AC Token |
| `/api/ac-health` | GET | AC服务健康检查 | 无 |
| `/api/ac-refresh` | POST | 刷新AC Token | AC Token |
| `/api/ac-interrupt` | POST | 中断任务 | AC Token |
| `/api/ac-retry` | POST | 重试任务 | AC Token |
| `/api/ac-kv` | POST | 设置KV存储的Token | admin key |

**AC API代理架构**:
```
前端 → /api/ac-create → 后端代理 → ac.beidou.win/api/v1/creative/by-user
                               ↑
                        Token来源优先级:
                        1. Upstash Redis (ac_token key)
                        2. AC_TOKEN 环境变量
                        3. 请求头 x-ac-token (⚠️待移除)
```

**Token轮换**: AC API曾通过response header返回新 `accesstoken`，后端自动存Redis。目前轮换已失效，Token主要靠环境变量。

**视频额度后端限流**: 内存Map，7条/username/天（⚠️Serverless环境下Map每次重置，需迁移Redis）。

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

### 5.2 Auto Creative (ac.beidou.win)

**基础URL**: `https://ac.beidou.win/api/v1`

**核心接口**: `POST /creative/by-user`

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

**注意**: beidou.win的Token ≠ ac.beidou.win的Token，两套独立。

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
| `AC_TOKEN` | ⚠️ | Auto Creative API Token（也可通过ac-kv设置） |
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
| `gh-pages` | 部署分支 | GitHub Pages（手动） |

**发布命令**: `git push origin main && git push origin main:gh-pages`（双push）

**域名**:
- `novelflow-dashboard.vercel.app` — ✅可用
- `novelflow.siphot.com` — ⚠️ NS未生效
- `tinyurl.com/4v3tkm45` — ✅分享短链

---

## 十、数据流全景

```
                         ┌──────────────────────┐
                         │   KOC浏览器           │
                         │  (app-v2.html SPA)   │
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
│GitHub   │ │NovelSpa│   │AC API   │ │GitHub    │
│Contents │ │书城API │   │(beidou) │ │data.json │
│API      │ │(OIDC)  │   │         │ │+北斗数据  │
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
