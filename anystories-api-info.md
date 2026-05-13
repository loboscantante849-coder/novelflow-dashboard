## 自动化脚本Token
- 当前Token: `eyJhbGciOiJSUzI1NiIsImtpZCI6IkU4QzAzQjVGMzhENjQzRTE3OTQ4MEU1NkE2REI4QkQ5IiwidHlwIjoiYXQrand0In0.eyJuYmYiOjE3NzgyNDk1NDMsImV4cCI6MTc3OTU0NTU0MywiaXNzIjoiaHR0cHM6Ly9zdHMuYW55c3Rvcmllcy5hcHAiLCJjbGllbnRfaWQiOiJBdXRoQ2xpZW50Iiwic3ViIjoiMTE2NCIsImF1dGhfdGltZSI6MTc3NzM0MDY2NCwiaWRwIjoibG9jYWwiLCJuaWNrbmFtZSI6IuW-kOaVrOa2myIsIm5hbWUiOiJ4dWp0Iiwic2lkIjoiRUU0MzJGRjNGRjMxOUZBOTZENUQzRUMxRkU4MTVFOTMiLCJpYXQiOjE3NzgyNDk1NDMsInNjb3BlIjpbIm9wZW5pZCIsInByb2ZpbGUiLCJyb2xlcyIsImVtYWlsIl0sImFtciI6WyJwd2QiXX0.e7hFrNiB1wVPWWEM-PXkY0L09h49dQa9E24nGJQ-Gc6bUV9F2mndTxVi9TJQvpQBtq32YBtXW3qwUc0JBBYNrv8RL3b1tORfzvXC17sBA995Vff-4mF5_54h1J1DssJoNcavn5kW52mrfC6xYsA3MET3__vNMXwdQpgBtBVR8MZiuZb7hGR2bHL8K056zFtUG1-0mLP_HM2JbuUkTo3S8XQ08C2nZ51ogntp_jeipYathxhnWKLMWUhFut5aNX0wshWDnZVWb1SrxEjgdFk8hpmprIXQaJ6thf1mKb_eSx6Aa1c9Mb03b5bE_HfwTtfzMLQHHAKWtd5AUdKcgGSuoA`
- Token expires ~2027-07 (exp:1779545543)

# Anystories API Documentation

## Overview

The Anystories投放中台系统 provides APIs for accessing campaign performance data including New Users, Subscription Revenue, and Ad Revenue for KOC campaigns.

## Authentication

- **Method**: OIDC Bearer Token
- **Header**: `Authorization: Bearer {token}`
- **Token Type**: JWT (RS256)
- **Token Expiry**: ~2027-07 (exp: 1779545543)
- **Token Source**: OIDC login at `https://sts.anystories.app`

## Required Headers

All API requests must include:

```
Authorization: Bearer {TOKEN}
X-OS: web
X-AppName: web-admin
X-AppIdentifier: web
X-AppVersion: 1.0.0,1
Content-Type: application/json;charset=UTF-8
Cache-Control: no-cache
```

## API Endpoints

### 1. Put Report (Main Data API)

**Endpoint**: `POST https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport`

**Purpose**: Retrieve aggregated campaign performance data with flexible groupings and filters.

**Key Parameters**:

#### Filters
- `productline`: Array (e.g., `[]` for all)
- `mediasource`: Array (e.g., `[]` for all)
- `mediasource2`: Array (e.g., `["SocialMedia"]` for KOC campaigns)
- `date`: Object with `from` and `to` in `YYYY-MM-DD` format
- `campaignid`: Array of specific campaign IDs (empty `[]` for all)
- `adsetid`: Array (empty for all)
- `adid`: Array (empty for all)
- `copywritingid`: Array (empty for all)

#### Groupings
Available grouping dimensions:
- `"date"` - Group by date
- `"campaignid"` - Group by campaign ID
- `"campaign"` - Group by campaign name (THIS IS THE KEY DISCOVERY!)
- `"campaignid"` + `"campaign"` - Get both ID and name together
- `"campaignid"` + `"campaign"` + `"date"` - Full daily breakdown with names

**Important Discovery**: The `groupings: ["campaign"]` field returns the full campaign name (e.g., `NovelFlow_SocialMedia_KOC_ConsEspher`), which allows automatic KOC username extraction without needing a separate campaign list API.

#### Response Fields (Key Metrics)
- `newusernum` → New Users (纯新增用户)
- `neworderincome` → Subscription Revenue (订阅收入)
- `newadsincome` → Ad Revenue (广告收入)
- `newinstallnum` → New Installs
- `totalincome` → Total Income
- `spend` → Ad Spend
- `d0income`, `d1income`, etc. → Daily cumulative income

**Example Request** (Get all KOC campaigns with daily data):
```json
{
  "filters": {
    "productline": [],
    "mediasource": [],
    "mediasource2": ["SocialMedia"],
    "date": {"from": "2026-05-01", "to": "2026-05-09", "datesLabel": ""},
    "campaignid": [],
    "adsetid": [],
    "adid": [],
    "copywritingid": []
  },
  "groupings": ["campaignid", "campaign", "date"]
}
```

### 2. Media Source Drop List

**Endpoint**: `GET https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/mediasource/querydroplist`

Returns available media sources: Facebook, Google, Tiktok, SocialMedia, Applovin, Moloco, etc.

### 3. Account Drop List

**Endpoint**: `GET https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/account/query/droplist/freelist`

Returns ad account list.

### 4. Country List

**Endpoint**: `GET https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/country/querylist`

Returns country list.

### 5. Campaign Tag Mappings

**Endpoint**: `GET https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/campaigntag/getallmappings?_t={timestamp}`

Returns campaign tag mappings (currently empty).

### 6. Campaign Tags

**Endpoint**: `GET https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/campaigntag/getalltags`

Returns all campaign tags (currently empty).

### 7. Menu List

**Endpoint**: `GET https://ad.anystories.app/api/Extend/GetMenus?userName={username}&version={timestamp}`

Returns the full menu structure of the admin system.

## KOC Campaign Name Format

Campaign names follow the pattern: `NovelFlow_SocialMedia_KOC_{KOCUsername}`

Examples:
- `NovelFlow_SocialMedia_KOC_ConsEspher` → KOC Username: `ConsEspher` (maps to `Cons Espher` in data.json)
- `NovelFlow_SocialMedia_KOC_DRAS` → KOC Username: `DRAS`
- `NovelFlow_SocialMedia_KOC-RW_xujt` → This is KOC-RW type, should be EXCLUDED

### KOC Username → data.json Key Mapping

The KOC username from the campaign name may differ slightly from the data.json key:
- `ConsEspher` → `Cons Espher` (space added)
- `DRAS` → `DRAS` (exact match)

Use fuzzy matching (case-insensitive, ignore spaces) when mapping.

## Campaign ID → KOC Mapping

See `campaignid-koc-mapping.json` for the full mapping.

### Known Campaign IDs (as of 2026-05-09)

| Campaign ID | Campaign Name | KOC Username | Has Data |
|---|---|---|---|
| 699ef7b8194eb218db3c2270 | NovelFlow_SocialMedia_Facebook-grounp_Facebook_xujt | (non-KOC) | Yes |
| 690dc4d8f12f26c746c245b3 | NovelFlow_SocialMedia_Facebook-romance_zhangth | (non-KOC) | Yes |
| 690afae3f12f26c746c24553 | NovelFlow_SocialMedia_Facebook_Facebook_jiangjx | (non-KOC) | Yes |
| 69ce09725815cec55a7f9302 | NovelFlow_SocialMedia_KOC-RW_xujt | KOC-RW (exclude) | Yes |
| 69eb4db7642f664f4642479a | NovelFlow_SocialMedia_INT_xujt | (non-KOC) | Yes |
| 694ca8495351adbc02818388 | NovelFlow_SocialMedia_Facebook-romance_Facebook_zhangshang | (non-KOC) | Yes |
| 690dc4b4b56236e8c8efbc9f | NovelFlow_SocialMedia_TikTok_zhangth | (non-KOC) | Yes |
| 692fa0b7c56782cca5c2d162 | NovelFlow_SocialMedia_Facebook-werewolf_Facebook_jiangjx | (non-KOC) | Yes |
| 69f42260362028a0ac10b770 | NovelFlow_SocialMedia_KOC_ConsEspher | ConsEspher | Yes |
| 69f94be3e71c030eb9032000 | NovelFlow_SocialMedia_KOC_DRAS | DRAS | Yes |
| 69f94c51792d0e9430167102 | (new, no data yet) | TBD | No |
| 69f94b99362028a0ac10b793 | (new, no data yet) | TBD | No |

## Data Pipeline

1. Call putreport API with `groupings: ["campaignid", "campaign", "date"]` and `mediasource2: ["SocialMedia"]`
2. Filter results where campaign name matches `NovelFlow_SocialMedia_KOC_*` (excluding `KOC-RW`)
3. Extract KOC username from campaign name
4. Aggregate: newusernum → new_users, neworderincome → subscription_revenue, newadsincome → ad_revenue
5. Build daily breakdowns from date grouping
6. Match KOC username to data.json keys (fuzzy match)
7. Write to data.json

## Token Management

- Current token stored in schedule task description
- Token expires ~2027-04, no immediate refresh needed
- To get a new token: Login at https://ad.anystories.app via OIDC, extract from localStorage key `oidc.user:https://sts.anystories.app:AuthClient`
