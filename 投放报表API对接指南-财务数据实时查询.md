# 投放报表API对接指南 —— 财务数据实时查询

> 本文档基于NovelFlow团队实际踩坑经验整理，帮助快速对接Anystories投放报表系统，实现财务数据的实时聚合查询。

---

## 一、系统架构概览

```
┌──────────────┐     OIDC认证      ┌────────────────────┐
│  你的应用     │ ──────────────→  │ sts.anystories.app │ ← 获取Token
└──────┬───────┘                   └────────────────────┘
       │
       │ Bearer Token
       ▼
┌──────────────────────────────────────────────────┐
│  ad.anystories.app (投放报表API)                   │
│  POST /api/v1/.../putreport/putreport             │
│                                                    │
│  可查询维度:                                        │
│  ├── campaignid (广告系列/推广者)                    │
│  ├── adid (单条推广链接) ← 核心精确维度              │
│  ├── adsetid (广告组)                               │
│  ├── date (日期)                                    │
│  └── copywritingid (文案ID)                         │
└──────────────────────────────────────────────────┘
       │
       │ 同一Token
       ▼
┌──────────────────────────────────────────────────┐
│  admin.novelspa.app (书城后台API)                   │
│  GET /api/v1/novelmanage/SocialMediaLinkConfig     │
│                                                    │
│  用途: 查询链接详情(书名/短链/创建者/渠道)           │
│  关键: 链接的id字段 = 报表的adid字段 (1:1对应)       │
└──────────────────────────────────────────────────┘
```

**核心发现：书城链接ID = 报表广告ID**

| 书城后台字段 | 报表API字段 | 含义 |
|---|---|---|
| `SocialMediaLinkConfig.id` | `adid` | 每条推广链接的唯一ID，1:1精确对应 |

这是实现精确单链接数据查询的关键——用adid查putreport，就能拿到每条链接独立的收入/用户数据，而不是campaign维度的混合数据。

---

## 二、认证：OIDC Token获取

### 2.1 获取方式

```
POST https://sts.anystories.app/connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=password
&client_id=AuthClient
&username=你的用户名
&password=你的密码
&scope=openid profile roles email offline_access
```

### 2.2 返回值

```json
{
  "access_token": "eyJhbGci...",   // ← 后续所有API请求用这个
  "token_type": "Bearer",
  "expires_in": 1296000            // 15天（360小时）
}
```

### 2.3 ⚠️ 踩坑记录

| 坑 | 说明 |
|---|---|
| **Token有效期15天** | 过期后所有API返回401，必须提前刷新，不能等崩了再搞 |
| **同一Token双系统通用** | putreport和novelspa用同一个token，不需要分别认证 |
| **不要硬编码Token** | 我们早期把Token写死在代码里，15天后全线崩。正确做法是存用户名密码，过期自动重新获取 |
| **密码可能变更** | 如果密码改了，所有自动化脚本会停，需要有手动干预的机制 |

### 2.4 自动刷新代码示例（Node.js）

```javascript
async function getBookstoreToken() {
  const username = process.env.OIDC_USERNAME;
  const password = process.env.OIDC_PASSWORD;
  
  const resp = await fetch('https://sts.anystories.app/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'AuthClient',
      username, password,
      scope: 'openid profile roles email offline_access'
    })
  });
  
  const data = await resp.json();
  return data.access_token; // 15天有效
}
```

---

## 三、投放报表API（核心）

### 3.1 基本信息

```
POST https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport
Authorization: Bearer <token>
X-OS: web
X-AppName: web-admin
X-AppIdentifier: web
X-AppVersion: 1.0.0,1
Content-Type: application/json;charset=UTF-8
```

**⚠️ 请求头缺任何一个都会返回错误。必须原样带上。**

### 3.2 请求体结构

```json
{
  "filters": {
    "productline": ["NovelFlow"],
    "mediasource": [],
    "mediasource2": ["SocialMedia"],
    "date": {
      "from": "2026-05-01",
      "to": "2026-05-26",
      "datesLabel": ""
    },
    "campaignid": [],
    "adsetid": [],
    "adid": [],
    "copywritingid": []
  },
  "groupings": ["date"]
}
```

### 3.3 筛选条件详解

| 字段 | 类型 | 含义 | 示例 |
|---|---|---|---|
| `productline` | string[] | 产品线，固定填`["NovelFlow"]` | `["NovelFlow"]` |
| `mediasource2` | string[] | 媒体源二级分类 | `["SocialMedia"]` 或 `["KOC"]` |
| `date.from` | string | 开始日期 | `"2026-05-01"` |
| `date.to` | string | 结束日期 | `"2026-05-26"` |
| `campaignid` | string[] | 广告系列ID | `["69f42260362028a0ac10b770"]` |
| `adid` | string[] | 广告ID（=书城链接ID） | `["6a0a00ec0771c1ae3226f991"]` |
| `adsetid` | string[] | 广告组ID | 一般留空 |
| `copywritingid` | string[] | 文案ID | 一般留空 |

**⚠️ 所有数组字段必须传，空条件传空数组`[]`，不能省略。**

### 3.4 分组维度（groupings）

这是决定返回数据粒度的关键参数，可以组合使用：

| groupings值 | 返回粒度 | 适用场景 |
|---|---|---|
| `["date"]` | 按天聚合 | 查总趋势、画曲线图 |
| `["campaignid"]` | 按广告系列 | 查每个推广者的汇总 |
| `["adid"]` | 按单条链接 | 查每本书/每个链接的精确数据 |
| `["campaignid","date"]` | 系列×天 | 某个推广者的每日趋势 |
| `["adid","date"]` | 链接×天 | 某条链接的每日趋势 ← 最常用 |
| `["adsetid"]` | 按广告组 | 一般不用 |

### 3.5 ⚠️ 关键踩坑：groupings决定了返回哪些字段

**不是所有字段在所有分组下都有值。** 比如：
- `groupings: ["campaignid"]` → 返回campaignid字段，但不会有adid
- `groupings: ["adid","date"]` → 同时返回adid和date，每条链接每天一行

**如果查询adid但groupings里没写adid，数据会按你写的维度聚合，adid信息丢失。**

### 3.6 返回的核心财务字段

返回数据`data`是一个数组，每行包含100+字段。**财务最关心的**：

| 字段 | 含义 | 类型 | 说明 |
|---|---|---|---|
| `d14income` | D14收入 | float | 用户注册后14天内产生的收入（**核心指标**） |
| `d7income` | D7收入 | float | 7天归因收入 |
| `d30income` | D30收入 | float | 30天归因收入 |
| `d0income` | D0收入 | float | 当天收入 |
| `totalincome` | 总收入 | float | 不限归因窗口的总收入 |
| `newusernum` | 新增用户数 | int | 纯新用户（**用于计算$1注册奖**） |
| `h5landingpageclickusernum` | 独立访客数(Unique) | int | H5落地页去重点击用户 |
| `h5landingpageclicknum` | 访问次数(Visits) | int | H5落地页总点击次数（不去重） |
| `neworderincome` | 新订单收入 | float | 新用户订阅收入 |
| `newadsincome` | 新广告收入 | float | 新用户广告收入 |
| `spend` | 广告花费 | float | 如果有投放 |
| `subnumtotal` | 订阅总数 | int | |
| `date` | 日期 | string | 分组含date时出现 |
| `adid` | 链接ID | string | 分组含adid时出现 |
| `campaignid` | 广告系列ID | string | 分组含campaignid时出现 |

**完整字段列表**（100+个）包括：`d1income`~`d240income`（各归因天数收入）、`bannerarpu`/`interarpu`/`nativearpu`/`rewardarpu`（各广告类型ARPU）、`subrefundamt`（退款）等。需要什么取什么。

---

## 四、常见查询场景

### 场景1：查某个推广者的所有数据汇总

```json
{
  "filters": {
    "productline": ["NovelFlow"],
    "mediasource": [],
    "mediasource2": ["SocialMedia"],
    "date": {"from": "2026-01-01", "to": "2026-05-26", "datesLabel": ""},
    "campaignid": ["69f42260362028a0ac10b770"],
    "adsetid": [], "adid": [], "copywritingid": []
  },
  "groupings": ["campaignid"]
}
```

返回1行：该推广者的汇总数据。

### 场景2：查某个推广者每条链接的精确数据

```json
{
  "filters": {
    "productline": ["NovelFlow"],
    "mediasource": [],
    "mediasource2": ["SocialMedia"],
    "date": {"from": "2026-01-01", "to": "2026-05-26", "datesLabel": ""},
    "campaignid": ["69f42260362028a0ac10b770"],
    "adsetid": [], "adid": [], "copywritingid": []
  },
  "groupings": ["adid"]
}
```

返回N行：该campaign下每个adid（链接）各自的数据。**这就是精确到单链接的数据。**

### 场景3：用已知链接ID批量查询

```json
{
  "filters": {
    "productline": ["NovelFlow"],
    "mediasource": [],
    "mediasource2": ["SocialMedia"],
    "date": {"from": "2026-05-01", "to": "2026-05-26", "datesLabel": ""},
    "campaignid": [],
    "adsetid": [],
    "adid": ["6a0a00ec0771c1ae3226f991", "6a0b83f24710fa5d80474aae"],
    "copywritingid": []
  },
  "groupings": ["adid", "date"]
}
```

返回M行：指定链接的每日明细。**推荐用这个做实时看板。**

### 场景4：查全平台汇总

```json
{
  "filters": {
    "productline": ["NovelFlow"],
    "mediasource": [],
    "mediasource2": ["SocialMedia"],
    "date": {"from": "2026-05-01", "to": "2026-05-26", "datesLabel": ""},
    "campaignid": [], "adsetid": [], "adid": [], "copywritingid": []
  },
  "groupings": ["date"]
}
```

返回N行：全平台每天的汇总数据。

### ⚠️ 批量查询adid限制

单个请求adid数组建议不超过50个。超过时拆分多批请求，合并结果。

---

## 五、书城后台API（查链接详情）

当你从putreport拿到adid，想知道这条链接对应什么书、谁创建的，需要查书城。

### 5.1 查单条链接

```
GET https://admin.novelspa.app/api/v1/novelmanage/SocialMediaLinkConfig/{adid}
Authorization: Bearer <同一个token>
```

返回关键字段：

| 字段 | 含义 | 示例 |
|---|---|---|
| `id` | 链接ID（=报表adid） | `"6a0a00ec0771c1ae3226f991"` |
| `shortUrl` | 短链 | `"social.novelplatform.vip/s/8t6s8v"` |
| `contentNameOrSku` | 书名+ID | `"LA ESPOSA DEL CEO (6766c848...)"` |
| `contentName` | 纯书名 | `"LA ESPOSA DEL CEO"` |
| `channelName` | 渠道名(含campaign) | `"NovelFlow_SocialMedia_Facebook-grounp_Facebook_xujt"` |
| `channelNameId` | 渠道ID（=campaignid） | `"699ef7b8194eb218db3c2270"` |
| `languageCode` | 语言 | `"es"` / `"en"` |
| `operatorName` | 操作人 | `"徐敬涛"` |
| `createTime` | 创建时间戳 | `1779040492781` |
| `isEnabled` | 是否启用 | `true` |

### 5.2 按短链反查链接ID

```
GET https://admin.novelspa.app/api/v1/novelmanage/SocialMediaLinkConfig?pageSize=1&shortUrl=8t6s8v
Authorization: Bearer <token>
```

**这是补全缺失linkId的关键方法。** 我们有44条历史记录缺linkId，全部通过这个接口反查补齐。

### 5.3 分页列表

```
GET https://admin.novelspa.app/api/v1/novelmanage/SocialMediaLinkConfig?pageNum=1&pageSize=20
Authorization: Bearer <token>
```

返回 `total`（总量）+ `data[]`（当前页数据）。总链接数约1400+。

---

## 六、数据映射关系（最重要的一张图）

```
书城后台                           投放报表
────────                          ────────
SocialMediaLinkConfig.id    =    adid          (1条推广链接)
SocialMediaLinkConfig       =    campaignid    (1个广告系列/渠道)
  .channelNameId

例子:
  书城链接 id=6a0a00ec0771c1ae3226f991
  书城渠道 channelNameId=699ef7b8194eb218db3c2270

  → putreport: adid=6a0a00ec0771c1ae3226f991 → 这条链接的数据
  → putreport: campaignid=699ef7b8194eb218db3c2270 → 这个渠道下所有链接的汇总
```

**⚠️ 我们踩过的最大坑：**

早期我们只按campaignid查，一个campaign下挂了多条链接，返回的是混合数据。然后试图把campaign总收入"均摊"给每本书，结果完全不准。

**正确做法：按adid查。** 每条链接唯一对应一个adid，数据精确，不需要均摊。

| 方式 | 精确度 | 问题 |
|---|---|---|
| campaignid查 + 均摊 | ❌ 不准 | 一个campaign下多链接，均摊算不准 |
| adid查 | ✅ 精确 | 每条链接独立数据，1:1对应 |

---

## 七、已知Campaign ID映射

| Campaign ID | 推广者 | 状态 | Campaign名称 |
|---|---|---|---|
| `69f42260362028a0ac10b770` | Cons Espher | 活跃 | NovelFlow_SocialMedia_KOC_ConsEspher |
| `69f94be3e71c030eb9032000` | DRAS | 活跃 | NovelFlow_SocialMedia_KOC_DRAS |
| `699ef7b8194eb218db3c2270` | xujt | 停用 | NovelFlow_SocialMedia_Facebook-grounp_Facebook_xujt |
| `690dc4d8f12f26c746c245b3` | zhangth | 停用 | NovelFlow_SocialMedia_Facebook-romance_zhangth |
| `690afae3f12f26c746c24553` | jiangjx | 停用 | NovelFlow_SocialMedia_Facebook_Facebook_jiangjx |
| `694ca8495351adbc02818388` | zhangshang | 停用 | NovelFlow_SocialMedia_Facebook-romance_Facebook_zhangshang |
| `69ce09725815cec55a7f9302` | — | — | 内部投放系列 |
| `69eb4db7642f664f4642479a` | — | — | INT系列 |
| `69d872b51648e93e774530d2` | — | — | 其他系列 |

新推广者不再创建专属campaign，统一走app提交流程，链接自动归到对应渠道。

---

## 八、推荐的数据查询架构

```
                    ┌─────────────────┐
                    │   前端看板        │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  你的后端API      │
                    │  /api/stats      │
                    └────────┬────────┘
                             │
               ┌─────────────┼─────────────┐
               │             │             │
        ┌──────▼──────┐ ┌───▼────┐ ┌──────▼──────┐
        │ submissions │ │putreport│ │  bookstroe  │
        │ 记录归属关系 │ │ 实时数据 │ │  链接详情   │
        └─────────────┘ └────────┘ └─────────────┘
```

### 推荐查询流程

```
1. 从你的数据库获取用户的所有linkId
2. 用linkId作为adid，批量查putreport（groupings: ["adid","date"]）
3. 如果用户有老campaign映射，额外查一次campaign下所有adid
4. 合并去重，返回给前端
```

### 我们的实际实现（Vercel Serverless）

```
GET /api/per-link-stats?username=xxx

Phase 1: 用户的linkId → putreport按adid查
Phase 2: 用户的campaign → putreport按campaignid+adid查（兜底老数据）
合并 → 返回每条链接的精确数据 + 每日明细
```

---

## 九、完整代码示例

### Python版（适合财务自动化脚本）

```python
import requests

# ========== 1. 获取Token ==========
def get_token(username, password):
    resp = requests.post(
        'https://sts.anystories.app/connect/token',
        data={
            'grant_type': 'password',
            'client_id': 'AuthClient',
            'username': username,
            'password': password,
            'scope': 'openid profile roles email offline_access'
        }
    )
    return resp.json()['access_token']

# ========== 2. 查投放报表 ==========
PUTREPORT_API = 'https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport'
HEADERS_TEMPLATE = {
    'X-OS': 'web', 'X-AppName': 'web-admin',
    'X-AppIdentifier': 'web', 'X-AppVersion': '1.0.0,1',
    'Content-Type': 'application/json;charset=UTF-8',
    'Accept': 'application/json'
}

def query_putreport(token, date_from, date_to, campaignids=None, adids=None, groupings=None):
    """通用putreport查询"""
    headers = {**HEADERS_TEMPLATE, 'Authorization': f'Bearer {token}'}
    body = {
        'filters': {
            'productline': ['NovelFlow'],
            'mediasource': [],
            'mediasource2': ['SocialMedia'],
            'date': {'from': date_from, 'to': date_to, 'datesLabel': ''},
            'campaignid': campaignids or [],
            'adsetid': [],
            'adid': adids or [],
            'copywritingid': []
        },
        'groupings': groupings or ['date']
    }
    resp = requests.post(PUTREPORT_API, json=body, headers=headers, timeout=60)
    if resp.status_code == 401:
        raise Exception('Token过期，需要重新获取')
    return resp.json().get('data', [])

# ========== 3. 查链接详情 ==========
BOOKSTORE_API = 'https://admin.novelspa.app/api/v1/novelmanage/SocialMediaLinkConfig'

def get_link_info(token, adid):
    """查单条链接详情"""
    resp = requests.get(
        f'{BOOKSTORE_API}/{adid}',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        timeout=10
    )
    return resp.json().get('data')

# ========== 4. 使用示例 ==========
if __name__ == '__main__':
    token = get_token('your_username', 'your_password')
    
    # 查全平台5月每日数据
    rows = query_putreport(token, '2026-05-01', '2026-05-26', groupings=['date'])
    for row in rows:
        print(f"{row['date']}: unique={row.get('h5landingpageclickusernum')}, "
              f"new={row.get('newusernum')}, d14income=${row.get('d14income', 0):.2f}")
    
    # 查某条链接的精确数据
    rows = query_putreport(token, '2026-01-01', '2026-05-26',
                          adids=['6a0a00ec0771c1ae3226f991'],
                          groupings=['adid', 'date'])
    for row in rows:
        print(f"  {row['date']}: unique={row.get('h5landingpageclickusernum')}, "
              f"d14=${row.get('d14income', 0):.2f}")
    
    # 查链接对应什么书
    info = get_link_info(token, '6a0a00ec0771c1ae3226f991')
    print(f"书名: {info['contentName']}, 短链: {info['shortUrl']}, 创建者: {info['operatorName']}")
```

---

## 十、踩坑总表

| # | 坑 | 后果 | 解决方案 |
|---|---|---|---|
| 1 | Token 15天过期，硬编码到代码里 | 过期后全线401崩溃 | 自动刷新：存用户名密码，过期时重新调OIDC |
| 2 | 按campaign维度查数据 | 一个campaign下多链接数据混在一起，无法拆分 | 按adid维度查（adid=书城linkId） |
| 3 | campaign数据"均摊"给每本书 | 不准，有些链接流量高有些低，均摊完全失真 | adid=linkId，1:1精确查询 |
| 4 | 请求头缺字段 | API返回错误 | 必须带全：X-OS/X-AppName/X-AppIdentifier/X-AppVersion |
| 5 | groupings写错 | 返回数据维度不对，字段缺失 | 要什么维度就写什么，要adid就写["adid"] |
| 6 | 日期范围太短 | 看不到历史数据 | 建议至少90天，数据是从链接创建之日开始累计的 |
| 7 | 早期系统没存linkId | 44条记录无法关联到putreport | 用书城API按shortUrl反查linkId |
| 8 | 老KOC链接不在app提交记录里 | per-link-stats查不到 | 加campaign兜底查询 |
| 9 | putreport只返回d14income | 不含$1注册奖金 | 注册奖 = newusernum × $1，需单独计算 |
| 10 | adid批量查询无上限 | 实际超过50个可能超时 | 拆分50个一批，并行查询 |
| 11 | mediasource2要区分 | "SocialMedia"和"KOC"是不同的 | CPS推广用"SocialMedia"，内部KOC用"KOC" |
| 12 | d14income为null | 新链接或无收入时 | 代码里null要当0处理：`row.get('d14income') or 0` |

---

## 十一、数据保护原则（血的教训）

1. **API返回0但旧值>0时，不要覆盖** — putreport偶尔返回0是接口抖动，不是真没数据
2. **永远不要删数据** — 书城和北斗只读不写，弹窗确认删除一律取消
3. **先验证再上线** — 改完代码必须查线上实际效果，本地成功≠线上成功
4. **保留历史快照** — 每次数据更新前保留旧值，出问题可以回滚

---

## 十二、快速起步清单

- [ ] 用Postman/curl测试OIDC获取Token
- [ ] 用Token调putreport，验证能拿到数据
- [ ] 确定你需要哪些维度（按天？按链接？按推广者？）
- [ ] 搭建自动Token刷新机制
- [ ] 写定时脚本，每日拉取数据存本地数据库
- [ ] 做看板/报表，前端展示
