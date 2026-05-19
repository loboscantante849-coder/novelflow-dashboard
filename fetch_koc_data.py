import json
import requests
import time
import re
import sys
import os
from datetime import datetime, timezone, timedelta

API_BASE = "https://beidou.win"
PROJECT_ID = "1006"
REPO_DIR = "/app/data/所有对话/主对话/novelflow-dashboard"
BEIDOU_INFO = "/app/data/所有对话/主对话/beidou-api-info.md"
MONTHLY_REF = "/app/data/所有对话/主对话/beidou-koc-monthly-data.json"
ANYSTORIES_INFO = os.path.join(REPO_DIR, "anystories-api-info.md")
CAMPAIGN_CONFIG = os.path.join(REPO_DIR, "campaign_config.json")

# === 投放报表API配置 ===
PUTREPORT_API = "https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport"
PUTREPORT_HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json;charset=UTF-8",
    "X-OS": "web",
    "X-AppName": "web-admin",
    "X-AppIdentifier": "web",
    "X-AppVersion": "1.0.0,1",
    "Cache-Control": "no-cache"
}

# === 书城后台API配置 ===
BOOKSTORE_API_BASE = "https://admin.novelspa.app/api/v1/novelmanage"


def get_beidou_token():
    """获取北斗API Token"""
    with open(BEIDOU_INFO, "r") as f:
        content = f.read()
    match = re.search(r'当前Token[^:]*:\s*`?([a-zA-Z0-9_\-\.]+)`?', content)
    if match:
        return match.group(1)
    raise Exception("Beidou Token not found")


def get_putreport_token():
    """获取投放报表API的OIDC Token"""
    # 尝试多个位置
    possible_paths = [
        "/app/data/所有对话/主对话/anystories-api-info.md",
        "/root/novelflow-dashboard/anystories-api-info.md",
        "anystories-api-info.md",
        "./anystories-api-info.md",
        os.path.join(os.path.dirname(__file__), "anystories-api-info.md")
    ]
    
    for path in possible_paths:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    content = f.read()
                match = re.search(r'当前Token[^:]*:\s*`?([a-zA-Z0-9_\-\.]+)`?', content)
                if match:
                    return match.group(1)
            except:
                continue
    
    raise Exception("Putreport Token not found")


def load_campaign_config():
    """加载广告系列配置"""
    # 尝试多个位置
    possible_paths = [
        CAMPAIGN_CONFIG,
        os.path.join(os.path.dirname(__file__), "campaign_config.json"),
        "campaign_config.json",
        "./campaign_config.json",
        "/root/novelflow-dashboard/campaign_config.json"
    ]
    
    for path in possible_paths:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    return json.load(f)
            except Exception as e:
                print(f"  WARN: Error loading {path}: {e}")
                continue
    
    print("  WARN: campaign_config.json not found, using default config")
    return {
        "campaign_ids": [
            {"id": "69f42260362028a0ac10b770", "koc_username": "ConsEspher", "is_active": True},
            {"id": "69f94be3e71c030eb9032000", "koc_username": "DRAS", "is_active": True}
        ],
        "historical_campaign_ids": []
    }


def get_date_range():
    """获取当月日期范围"""
    now = datetime.now(timezone(timedelta(hours=8)))
    first_day = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    start = first_day.strftime("%Y-%m-%d 00:00")
    end = now.strftime("%Y-%m-%d 23:59")
    date_from = first_day.strftime("%Y-%m-%d")
    date_to = now.strftime("%Y-%m-%d")
    return start, end, date_from, date_to


def build_koc_filter():
    """构建北斗API的KOC过滤器"""
    return {
        "relation": "and",
        "conditions": [
            {"field": "e.product_line", "function": "EQUAL", "paramDatas": ["NovelFlow"]},
            {"field": "e.self_campaign_name", "function": "CONTAIN", "paramDatas": ["KOC_"]}
        ],
        "filters": [{
            "relation": "and",
            "conditions": [
                {"field": "e.self_campaign_name", "function": "NOT_CONTAIN", "paramDatas": ["KOC-RW"]}
            ],
            "filters": []
        }]
    }


def build_by_field_params():
    """构建字段参数"""
    return [{
        "fieldName": "e.self_campaign_name", "propNmCh": "广告系列名称（自建）",
        "propNm": "self_campaign_name", "field": "e.self_campaign_name",
        "fieldLabel": "广告系列名称（自建）", "groupByDataType": "STRING",
        "dataTypeValue": "STRING", "reportPropType": "EventProp",
        "canAccessData": True, "id": 694111718764677, "proType": "2",
        "sqlExpression": "", "isVisible": "1"
    }]


def build_measures(field, aggregator, name, alias):
    """构建指标"""
    return [{
        "event_name": "app_launch", "event_id": 225,
        "metadata": {"color": "success", "origiName": name},
        "field": field, "aggregator": aggregator, "name": name,
        "measureAliasName": alias, "bucketId": 1, "fieldLabel": "实体数"
    }]


def call_beidou_api(token, body, max_retries=5, wait_seconds=12):
    """调用北斗API"""
    url = f"{API_BASE}/api/v1/event-analysis-report/query-report"
    headers = {
        "Authorization": f"Bearer {token}",
        "x-project-id": PROJECT_ID,
        "Content-Type": "application/json"
    }
    for attempt in range(max_retries):
        resp = requests.post(url, json=body, headers=headers, timeout=90)
        if resp.status_code == 401:
            raise Exception("TOKEN_EXPIRED")
        data = resp.json()
        if data.get("is_done"):
            return data
        print(f"  Async, attempt {attempt+1}, waiting {wait_seconds}s...")
        time.sleep(wait_seconds)
    raise Exception(f"API not done after {max_retries} retries")


def fetch_putreport_data(campaignid, date_from, date_to, token):
    """
    调用投放报表API获取单个广告系列的Unique和New Users数据
    
    Args:
        campaignid: 广告系列ID
        date_from: 开始日期 (YYYY-MM-DD)
        date_to: 结束日期 (YYYY-MM-DD)
        token: Bearer Token
    
    Returns:
        dict: {
            'campaignid': str,
            'date': str,
            'h5landingpageclickusernum': int,  # Unique (H5落地页点击用户数)
            'newusernum': int,  # New Users (纯新增用户数)
            'd14income': float,  # D14收入
            'daily': [{'date': str, 'h5landingpageclickusernum': int, 'newusernum': int, 'd14income': float}]
        }
    """
    payload = {
        "filters": {
            "productline": ["NovelFlow"],
            "mediasource": [],
            "mediasource2": ["SocialMedia"],
            "date": {
                "from": date_from,
                "to": date_to,
                "datesLabel": ""
            },
            "campaignid": [campaignid],
            "adsetid": [],
            "adid": [],
            "copywritingid": []
        },
        "groupings": ["date"]
    }
    
    headers = {**PUTREPORT_HEADERS, "Authorization": f"Bearer {token}"}
    
    try:
        resp = requests.post(PUTREPORT_API, json=payload, headers=headers, timeout=180)
        resp.raise_for_status()
        result = resp.json()
        
        if result.get("code") != 200:
            print(f"    API error: code={result.get('code')}, msg={result.get('msg', 'unknown')}")
            return None
        
        data_list = result.get("data", [])
        if not data_list:
            print(f"    No data returned for campaign {campaignid}")
            return None
        
        # 提取daily数据
        daily = []
        total_h5 = 0
        total_new = 0
        total_d14income = 0.0
        
        for item in data_list:
            h5 = item.get("h5landingpageclickusernum", 0) or 0
            new = item.get("newusernum", 0) or 0
            d14 = item.get("d14income", 0.0) or 0.0
            date = item.get("date", "")
            
            daily.append({
                "date": date,
                "h5landingpageclickusernum": h5,
                "newusernum": new,
                "d14income": d14
            })
            total_h5 += h5
            total_new += new
            total_d14income += d14
        
        return {
            "campaignid": campaignid,
            "total_h5landingpageclickusernum": total_h5,
            "total_newusernum": total_new,
            "total_d14income": round(total_d14income, 2),
            "daily": daily
        }
        
    except requests.exceptions.Timeout:
        print(f"    Timeout for campaign {campaignid}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"    Request error for campaign {campaignid}: {e}")
        return None
    except Exception as e:
        print(f"    Error for campaign {campaignid}: {e}")
        return None


def fetch_putreport_by_adid(campaignid, date_from, date_to, token):
    """
    调用投放报表API，按adid分组获取每个推广链接的独立数据
    
    Args:
        campaignid: 广告系列ID
        date_from: 开始日期 (YYYY-MM-DD)
        date_to: 结束日期 (YYYY-MM-DD)
        token: Bearer Token
    
    Returns:
        dict: {
            'campaignid': str,
            'ad_data': {
                'adid1': {
                    'unique_users': int,
                    'new_users': int,
                    'd14_income': float
                },
                ...
            }
        }
    """
    payload = {
        "filters": {
            "productline": ["NovelFlow"],
            "mediasource": [],
            "mediasource2": ["SocialMedia"],
            "date": {
                "from": date_from,
                "to": date_to,
                "datesLabel": ""
            },
            "campaignid": [campaignid],
            "adsetid": [],
            "adid": [],  # 空数组表示获取所有adid
            "copywritingid": []
        },
        "groupings": ["adid"]  # 按adid分组
    }
    
    headers = {**PUTREPORT_HEADERS, "Authorization": f"Bearer {token}"}
    
    try:
        resp = requests.post(PUTREPORT_API, json=payload, headers=headers, timeout=180)
        resp.raise_for_status()
        result = resp.json()
        
        if result.get("code") != 200:
            print(f"    [adid] API error: code={result.get('code')}, msg={result.get('msg', 'unknown')}")
            return None
        
        data_list = result.get("data", [])
        if not data_list:
            print(f"    [adid] No data returned for campaign {campaignid}")
            return {"campaignid": campaignid, "ad_data": {}}
        
        # 解析adid分组数据
        ad_data = {}
        for item in data_list:
            adid = item.get("adid", "")
            if not adid:
                continue
            
            unique = item.get("h5landingpageclickusernum", 0) or 0
            new_users = item.get("newusernum", 0) or 0
            d14_income = item.get("d14income", 0.0) or 0.0
            
            ad_data[adid] = {
                "unique_users": unique,
                "new_users": new_users,
                "d14_income": round(d14_income, 2)
            }
        
        print(f"    [adid] Found {len(ad_data)} adids for campaign {campaignid}")
        return {"campaignid": campaignid, "ad_data": ad_data}
        
    except requests.exceptions.Timeout:
        print(f"    [adid] Timeout for campaign {campaignid}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"    [adid] Request error for campaign {campaignid}: {e}")
        return None
    except Exception as e:
        print(f"    [adid] Error for campaign {campaignid}: {e}")
        return None


def fetch_bookstore_link_by_adid(adid, token):
    """
    通过书城后台API查询adid对应的链接信息（shortUrl）
    
    Args:
        adid: 推广链接ID (SocialMediaLinkConfig ID)
        token: Bearer Token
    
    Returns:
        dict or None: {
            'shortUrl': str,
            'id': str,
            ...
        }
    """
    url = f"{BOOKSTORE_API_BASE}/SocialMediaLinkConfig/{adid}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        resp.raise_for_status()
        result = resp.json()
        
        # 从 data 字段中提取信息
        data = result.get("data", {})
        if not data:
            return None
        
        # 返回包含关键字段的字典
        return {
            "id": data.get("id"),
            "shortUrl": data.get("shortUrl"),
            "linkName": data.get("linkName"),
            "contentName": data.get("contentName"),
            "channelNameId": data.get("channelNameId")
        }
    except requests.exceptions.Timeout:
        print(f"      [bookstore] Timeout for adid {adid}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"      [bookstore] Error for adid {adid}: {e}")
        return None
    except Exception as e:
        print(f"      [bookstore] Error for adid {adid}: {e}")
        return None


def fetch_all_putreport_data(campaign_ids, date_from, date_to):
    """
    批量获取所有广告系列的投放报表数据
    
    Args:
        campaign_ids: 广告系列ID列表
        date_from: 开始日期
        date_to: 结束日期
    
    Returns:
        dict: {campaignid: putreport_data}
    """
    print("\n--- Fetching Putreport Data (Unique & New Users) ---")
    token = get_putreport_token()
    print(f"Token: {token[:20]}...")
    print(f"Date range: {date_from} ~ {date_to}")
    print(f"Campaigns: {len(campaign_ids)}")
    
    results = {}
    for i, cid in enumerate(campaign_ids):
        print(f"\n  [{i+1}/{len(campaign_ids)}] Fetching campaign: {cid}")
        data = fetch_putreport_data(cid, date_from, date_to, token)
        if data:
            print(f"    Total Unique: {data['total_h5landingpageclickusernum']}")
            print(f"    Total New Users: {data['total_newusernum']}")
            print(f"    Daily records: {len(data['daily'])}")
            results[cid] = data
        else:
            print(f"    Failed to fetch data")
        # 避免请求过快
        time.sleep(0.5)
    
    print(f"\n  Successfully fetched: {len(results)}/{len(campaign_ids)} campaigns")
    return results


def fetch_all_putreport_by_adid(campaign_ids, date_from, date_to):
    """
    批量获取所有广告系列按adid分组的数据
    
    Args:
        campaign_ids: 广告系列ID列表
        date_from: 开始日期
        date_to: 结束日期
    
    Returns:
        dict: {campaignid: {adid: ad_stats}}
    """
    print("\n--- Fetching Putreport Data by AdID ---")
    token = get_putreport_token()
    print(f"Token: {token[:20]}...")
    print(f"Date range: {date_from} ~ {date_to}")
    print(f"Campaigns: {len(campaign_ids)}")
    
    results = {}
    for i, cid in enumerate(campaign_ids):
        print(f"\n  [{i+1}/{len(campaign_ids)}] Fetching adid data for campaign: {cid}")
        data = fetch_putreport_by_adid(cid, date_from, date_to, token)
        if data:
            ad_count = len(data.get("ad_data", {}))
            print(f"    Found {ad_count} adids")
            if ad_count > 0:
                for adid, stats in list(data["ad_data"].items())[:3]:
                    print(f"      {adid}: unique={stats['unique_users']}, new={stats['new_users']}, d14=${stats['d14_income']:.2f}")
                if ad_count > 3:
                    print(f"      ... and {ad_count - 3} more")
            results[cid] = data
        else:
            print(f"    Failed to fetch adid data")
        # 避免请求过快
        time.sleep(0.5)
    
    print(f"\n  Successfully fetched adid data: {len(results)}/{len(campaign_ids)} campaigns")
    return results


def backfill_submissions_linkid(putreport_adid_data, submissions):
    """
    Backfill submissions.json 中缺失的 linkId 和 campaignId
    
    流程:
    1. 收集所有 adid
    2. 对每个 adid 调用书城API获取 shortUrl
    3. 匹配到 submissions 中 link 包含该 shortUrl 的记录
    4. 写入 linkId 和 campaignId
    
    Args:
        putreport_adid_data: 按campaign分组的adid数据
        submissions: submissions列表
    
    Returns:
        tuple: (updated_submissions, adid_to_url_mapping)
    """
    print("\n--- Backfilling Submissions LinkID ---")
    token = get_putreport_token()
    
    # 收集所有 adid
    all_adids = set()
    for cid, data in putreport_adid_data.items():
        for adid in data.get("ad_data", {}).keys():
            all_adids.add(adid)
    
    print(f"  Total adids to query: {len(all_adids)}")
    
    # 查询每个adid的shortUrl
    adid_to_url = {}
    for i, adid in enumerate(all_adids):
        print(f"  [{i+1}/{len(all_adids)}] Querying adid: {adid}")
        link_info = fetch_bookstore_link_by_adid(adid, token)
        if link_info:
            short_url = link_info.get("shortUrl", "")
            if short_url:
                adid_to_url[adid] = short_url
                print(f"      shortUrl: {short_url}")
        # 避免请求过快，timeout=10s
        time.sleep(0.2)
    
    print(f"  Successfully mapped {len(adid_to_url)} adids to shortUrls")
    
    # 匹配 submissions
    updated_submissions = []
    matched_count = 0
    
    for sub in submissions:
        sub_copy = dict(sub)
        link = sub_copy.get("link", "")
        short_url = sub_copy.get("shortUrl", "")
        current_link_id = sub_copy.get("linkId", "")
        current_campaign_id = sub_copy.get("campaignId", "")
        
        # 如果已经有 linkId，跳过
        if current_link_id:
            updated_submissions.append(sub_copy)
            continue
        
        # 尝试通过 shortUrl 匹配
        matched_adid = None
        for adid, su in adid_to_url.items():
            if su and (short_url == su or (link and su in link)):
                matched_adid = adid
                break
        
        if matched_adid:
            # 找到该 adid 属于哪个 campaign
            for cid, data in putreport_adid_data.items():
                if matched_adid in data.get("ad_data", {}):
                    sub_copy["linkId"] = matched_adid
                    sub_copy["campaignId"] = cid
                    matched_count += 1
                    print(f"    Matched: {sub_copy.get('bookName', 'unknown')} -> {matched_adid}")
                    break
        
        updated_submissions.append(sub_copy)
    
    print(f"  Matched {matched_count} submissions")
    return updated_submissions, adid_to_url


def extract_koc_username(campaign_name):
    """从北斗广告系列名称提取KOC用户名"""
    match = re.search(r'KOC_([A-Za-z0-9_/]+)$', campaign_name)
    return match.group(1).replace("/", " ") if match else None


def map_koc_username(campaign_username, data_users):
    """映射KOC用户名到data.json中的用户名"""
    # Direct match
    if campaign_username in data_users:
        return campaign_username
    # Case-insensitive, no-space, no-slash match
    cu_clean = campaign_username.lower().replace(" ", "").replace("/", "").replace("-", "")
    for u in data_users:
        u_clean = u.lower().replace(" ", "").replace("/", "").replace("-", "").replace("♡", "")
        if u_clean == cu_clean:
            return u
    return None


def parse_daily_data(resp_data):
    """解析北斗API的daily数据"""
    result = {}
    if not resp_data or not resp_data.get("items"):
        return result
    detail = resp_data["items"][0].get("detailResult", {})
    series = detail.get("series", [])
    rows = detail.get("rows", [])
    full_dates = [("20" + s if s.startswith("26-") else s) for s in series]
    for row in rows:
        campaign_name = row["byValues"][0]
        values = row["values"]
        daily = {}
        for i, date in enumerate(full_dates):
            if i < len(values) and values[i]:
                val = values[i][0] if values[i] else 0
                if val > 0:
                    daily[date] = val
        result[campaign_name] = daily
    return result


def parse_monthly_data(resp_data):
    """解析北斗API的monthly数据"""
    result = {}
    if not resp_data or not resp_data.get("items"):
        return result
    rows = resp_data["items"][0].get("detailResult", {}).get("rows", [])
    for row in rows:
        campaign_name = row["byValues"][0]
        sum_values = row.get("sumValues", [0])
        result[campaign_name] = sum_values[0] if sum_values else 0
    return result


def calc_unique_daily(link_visits, link_unique, link_visits_daily):
    """根据总Unique和daily visits计算daily unique（比例分配）"""
    if link_visits == 0 or link_unique == 0:
        return {}
    ratio = link_unique / link_visits
    daily_raw = {d: v * ratio for d, v in link_visits_daily.items()}
    int_parts = {d: int(v) for d, v in daily_raw.items()}
    remainders = {d: v - int_parts[d] for d, v in daily_raw.items()}
    total_allocated = sum(int_parts.values())
    remaining = link_unique - total_allocated
    if remaining > 0:
        sorted_dates = sorted(remainders.keys(), key=lambda d: remainders[d], reverse=True)
        for i in range(int(remaining)):
            if i < len(sorted_dates):
                int_parts[sorted_dates[i]] += 1
    return {d: max(0, v) for d, v in int_parts.items()}


def get_ny_time_str():
    """获取纽约时间字符串"""
    ny_tz = timezone(timedelta(hours=-4))
    return datetime.now(ny_tz).strftime("%Y-%m-%d %H:%M (ET)")


def load_monthly_ref():
    """加载月度参考数据（北斗月报）"""
    try:
        with open(MONTHLY_REF, "r") as f:
            return json.load(f).get("data", {})
    except:
        return {}


def update_fallback_data(data):
    """更新dashboard.html中的FALLBACK_DATA"""
    html_path = os.path.join(REPO_DIR, "dashboard.html")
    if not os.path.exists(html_path):
        print(f"  WARNING: {html_path} not found, skipping FALLBACK_DATA update")
        return
    
    with open(html_path, "r", encoding="utf-8") as f:
        content = f.read()
    
    start_marker = "const FALLBACK_DATA = {"
    start_idx = content.find(start_marker)
    if start_idx == -1:
        print("  WARNING: FALLBACK_DATA not found in dashboard.html, skipping")
        return
    
    # Count braces to find the matching closing };
    brace_count = 0
    end_idx = None
    for i in range(start_idx, len(content)):
        if content[i] == '{':
            brace_count += 1
        elif content[i] == '}':
            brace_count -= 1
            if brace_count == 0:
                remaining = content[i:]
                semi_idx = remaining.find(';')
                if semi_idx is not None and semi_idx < 5:
                    end_idx = i + semi_idx + 1
                else:
                    end_idx = i + 1
                break
    
    if end_idx is None:
        print("  WARNING: Could not find FALLBACK_DATA end, skipping")
        return
    
    # Build new FALLBACK_DATA
    clean_data = json.loads(json.dumps(data))
    for uname in clean_data.get("users", {}):
        clean_data["users"][uname].pop("unique_last_success", None)
    
    new_fallback = "const FALLBACK_DATA = " + json.dumps(clean_data, indent=4, ensure_ascii=False) + ";"
    new_content = content[:start_idx] + new_fallback + content[end_idx:]
    
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    
    print(f"  FALLBACK_DATA updated ({len(new_fallback)} chars)")


def main():
    print("=== KOC Data Fetch Start ===")
    print("Data sources: Putreport API (Unique/New Users) + Beidou API (Visits)")
    token = get_beidou_token()
    print(f"\nBeidou Token: {token[:20]}...")
    start, end, date_from, date_to = get_date_range()
    print(f"Date: {start} ~ {end}")
    print(f"Date range for putreport: {date_from} ~ {date_to}")

    # Load data.json
    with open(f"{REPO_DIR}/data.json", "r") as f:
        data = json.load(f)
    data_users = list(data["users"].keys())

    # Load campaign config
    campaign_config = load_campaign_config()
    
    # 获取活跃的广告系列ID列表
    active_campaigns = [c["id"] for c in campaign_config.get("campaign_ids", []) if c.get("is_active", False)]
    print(f"\nActive campaigns: {len(active_campaigns)}")
    for cid in active_campaigns:
        print(f"  - {cid}")

    # === BULLETPROOF: Snapshot ALL existing unique data before any modification ===
    existing_unique = {}
    existing_unique_daily = {}
    existing_new_users = {}
    existing_new_users_daily = {}
    for name, u in data["users"].items():
        if u.get("link_unique", 0) > 0:
            existing_unique[name] = u["link_unique"]
        if u.get("link_unique_daily") and len(u.get("link_unique_daily", {})) > 0:
            existing_unique_daily[name] = dict(u["link_unique_daily"])
        if u.get("new_users", 0) > 0:
            existing_new_users[name] = u["new_users"]
        if u.get("new_users_daily") and len(u.get("new_users_daily", {})) > 0:
            existing_new_users_daily[name] = dict(u["new_users_daily"])

    # ================================================
    # STEP 1: 获取投放报表数据 (Unique + New Users) - 按campaign汇总
    # ================================================
    putreport_results = {}
    if active_campaigns:
        putreport_results = fetch_all_putreport_data(active_campaigns, date_from, date_to)
    
    # ================================================
    # STEP 1.5: 获取投放报表数据 (按adid分组)
    # ================================================
    putreport_by_adid = {}
    if active_campaigns:
        putreport_by_adid = fetch_all_putreport_by_adid(active_campaigns, date_from, date_to)
    
    # ================================================
    # STEP 2: 获取北斗API数据 (Visits)
    # ================================================
    print("\n--- Query Beidou: Visits (BodyCount DAY) ---")
    visits_body = {
        "approx": True, "sampling_factor": 1, "projectId": 1006,
        "timeZones": ["Etc/Greenwich", "Etc/Greenwich"],
        "analysisTypeName": "ccid",
        "byFieldParams": build_by_field_params(),
        "arith_rollup": True, "maxRowNumber": 2000, "maxGroupNumber": 500,
        "measures": build_measures("BodyCount", "BodyCount", "总link日拉活", "measure_6"),
        "filter": build_koc_filter(),
        "dateRange": [start, end],
        "unit": "DAY"
    }
    try:
        visits_resp = call_beidou_api(token, visits_body)
        visits_data = parse_daily_data(visits_resp)
        print(f"  Got {len(visits_data)} campaigns from Beidou")
    except Exception as e:
        if "TOKEN_EXPIRED" in str(e):
            print("Beidou TOKEN EXPIRED!"); sys.exit(1)
        print(f"ERROR: {e}"); visits_data = {}

    # ================================================
    # STEP 3: 处理数据并写入data.json
    # ================================================
    print("\n--- Processing ---")
    updated_users = set()
    putreport_had_data = False
    
    # 构建campaignid -> koc_username映射
    cid_to_koc = {}
    for c in campaign_config.get("campaign_ids", []):
        cid_to_koc[c["id"]] = c.get("koc_username", "")
    for c in campaign_config.get("historical_campaign_ids", []):
        if c["id"] not in cid_to_koc:
            cid_to_koc[c["id"]] = c.get("koc_username", "")
    
    # 处理投放报表数据
    for cid, putreport_data in putreport_results.items():
        koc_username = cid_to_koc.get(cid, "")
        if not koc_username:
            print(f"  WARN: Cannot find KOC username for campaign {cid}")
            continue
        
        # 尝试映射到data.json中的用户名
        mapped_name = map_koc_username(koc_username, data_users)
        if not mapped_name:
            print(f"  WARN: Cannot map KOC '{koc_username}' to data.json users")
            continue
        
        # 提取总量
        total_unique = putreport_data.get("total_h5landingpageclickusernum", 0)
        total_new_users = putreport_data.get("total_newusernum", 0)
        total_d14income = putreport_data.get("total_d14income", 0.0)
        daily_data = putreport_data.get("daily", [])
        
        # 构建daily字典
        unique_daily = {}
        new_users_daily = {}
        d14income_daily = {}
        for d in daily_data:
            date = d.get("date", "")
            if date:
                unique_daily[date] = d.get("h5landingpageclickusernum", 0)
                new_users_daily[date] = d.get("newusernum", 0)
                d14income_daily[date] = d.get("d14income", 0.0)
        
        # 旧值
        old_unique = existing_unique.get(mapped_name, 0)
        old_new_users = existing_new_users.get(mapped_name, 0)
        
        # === UNIQUE数据保护 ===
        if total_unique > 0:
            data["users"][mapped_name]["link_unique"] = total_unique
            data["users"][mapped_name]["link_unique_daily"] = unique_daily
            data["users"][mapped_name]["unique_last_success"] = get_ny_time_str()
            putreport_had_data = True
            print(f"  {mapped_name}: unique={total_unique} (from putreport)")
        elif old_unique > 0:
            # API返回0但旧值>0，保留旧值
            data["users"][mapped_name]["link_unique"] = old_unique
            # 用新API的daily结构更新（如果API返回了daily数据）
            if unique_daily:
                # 计算新的daily unique
                visits_daily = data["users"][mapped_name].get("link_visits_daily", {})
                if visits_daily:
                    data["users"][mapped_name]["link_unique_daily"] = calc_unique_daily(
                        sum(visits_daily.values()), old_unique, visits_daily
                    )
            print(f"  {mapped_name}: unique={old_unique} (putreport=0, kept existing)")
        else:
            data["users"][mapped_name]["link_unique"] = 0
            data["users"][mapped_name]["link_unique_daily"] = {}
            print(f"  {mapped_name}: unique=0 (confirmed zero)")
        
        # === New Users数据保护 ===
        if total_new_users > 0:
            data["users"][mapped_name]["new_users"] = total_new_users
            data["users"][mapped_name]["new_users_daily"] = new_users_daily
            print(f"    new_users={total_new_users} (from putreport)")
        elif old_new_users > 0:
            data["users"][mapped_name]["new_users"] = old_new_users
            print(f"    new_users={old_new_users} (putreport=0, kept existing)")
        else:
            data["users"][mapped_name]["new_users"] = 0
            data["users"][mapped_name]["new_users_daily"] = {}
            print(f"    new_users=0 (confirmed zero)")
        
        # === D14收入 ===
        old_d14income = data["users"][mapped_name].get("d14income", 0.0)
        if total_d14income > 0:
            data["users"][mapped_name]["d14income"] = total_d14income
            data["users"][mapped_name]["d14income_daily"] = d14income_daily
            print(f"    d14income=${total_d14income:.2f} (from putreport)")
        elif old_d14income > 0:
            data["users"][mapped_name]["d14income"] = old_d14income
            print(f"    d14income=${old_d14income:.2f} (putreport=0, kept existing)")
        else:
            data["users"][mapped_name]["d14income"] = 0.0
            data["users"][mapped_name]["d14income_daily"] = {}
            print(f"    d14income=$0.00 (confirmed zero)")
        
        updated_users.add(mapped_name)
    
    # 处理Visits数据（北斗API）
    for campaign_name, daily_visits in visits_data.items():
        koc_name = extract_koc_username(campaign_name)
        if not koc_name or "KOC-RW" in campaign_name:
            continue
        mapped_name = map_koc_username(koc_name, data_users)
        if not mapped_name:
            print(f"  WARN: Cannot map Beidou campaign '{koc_name}'")
            continue
        
        total_visits = sum(daily_visits.values())
        
        if mapped_name in data["users"]:
            data["users"][mapped_name]["link_visits"] = total_visits
            data["users"][mapped_name]["link_visits_daily"] = daily_visits
            
            # 如果unique已从putreport更新，重新计算daily unique
            if mapped_name not in updated_users:
                current_unique = data["users"][mapped_name].get("link_unique", 0)
                if current_unique > 0:
                    data["users"][mapped_name]["link_unique_daily"] = calc_unique_daily(
                        total_visits, current_unique, daily_visits
                    )
            
            print(f"  {mapped_name}: visits={total_visits}")
            updated_users.add(mapped_name)

    # 更新last_updated
    data["last_updated"] = get_ny_time_str()
    data["data_source_note"] = "Unique/New Users from Putreport API; Visits from Beidou API"
    print(f"\nlast_updated: {data['last_updated']}")
    print(f"Updated {len(updated_users)} users")
    print(f"Putreport had data: {putreport_had_data}")

    # 保存data.json
    with open(f"{REPO_DIR}/data.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print("data.json saved")
    
    # 更新FALLBACK_DATA
    print("\n--- Updating FALLBACK_DATA ---")
    update_fallback_data(data)

    # ================================================
    # STEP 4: Backfill submissions.json 并生成 link-stats.json
    # ================================================
    print("\n--- Processing Submissions & Link Stats ---")
    
    submissions_path = os.path.join(REPO_DIR, "submissions.json")
    link_stats_path = os.path.join(REPO_DIR, "link-stats.json")
    
    # 读取 submissions.json
    with open(submissions_path, "r") as f:
        submissions = json.load(f)
    
    # Backfill submissions 中缺失的 linkId
    updated_submissions, adid_to_url = backfill_submissions_linkid(putreport_by_adid, submissions)
    
    # 保存 backfill 后的 submissions.json
    with open(submissions_path, "w") as f:
        json.dump(updated_submissions, f, indent=2, ensure_ascii=False)
    print(f"submissions.json saved with backfilled linkIds")
    
    # 生成 link-stats.json
    try:
        generate_link_stats(putreport_by_adid, updated_submissions, date_from, date_to)
    except Exception as e:
        print(f"  WARN: Failed to generate link-stats.json: {e}")
        import traceback
        traceback.print_exc()
    
    # Git push
    print("\n--- Git Push ---")
    import subprocess
    subprocess.run(["git", "add", "data.json", "dashboard.html", "fetch_koc_data.py", "campaign_config.json", "link-stats.json", "submissions.json"], 
                   cwd=REPO_DIR, capture_output=True)
    result = subprocess.run(["git", "commit", "-m", 
                           f"Update KOC data with per-link Putreport data {data['last_updated']}"], 
                          cwd=REPO_DIR, capture_output=True, text=True)
    if "nothing to commit" in result.stdout or "nothing to commit" in result.stderr:
        print("No changes")
    else:
        print(f"Committed")
        result = subprocess.run(["git", "push", "origin", "main"], 
                               cwd=REPO_DIR, capture_output=True, text=True, 
                               env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        if result.returncode == 0:
            print("Push successful")
        else:
            print(f"Push failed: {result.stderr}")
    print("\n=== Done ===")


def generate_link_stats(putreport_by_adid, submissions, date_from, date_to):
    """
    生成 link-stats.json 文件，按 adid 索引统计数据
    
    流程:
    1. 收集所有 adid
    2. 对每个 adid 调用书城API获取 book 信息
    3. 使用 putreport_by_adid 获取每个 adid 的真实数据
    4. 生成按 adid 索引的统计数据（包含book_name）
    5. 保存到 link-stats.json
    """
    submissions_path = os.path.join(REPO_DIR, "submissions.json")
    link_stats_path = os.path.join(REPO_DIR, "link-stats.json")
    
    # 获取已有 link-stats.json 的数据（用于保护旧值）
    existing_stats = {}
    if os.path.exists(link_stats_path):
        try:
            with open(link_stats_path, "r") as f:
                existing_data = json.load(f)
                if "links" in existing_data:
                    existing_stats = existing_data["links"]
        except:
            pass
    
    # 获取token
    token = get_putreport_token()
    
    # 构建 adid -> shortUrl 映射（从书城API）
    print("\n  Fetching book info for each adid...")
    adid_book_info = {}
    all_adids = set()
    for campaign_id, campaign_data in putreport_by_adid.items():
        for adid in campaign_data.get("ad_data", {}).keys():
            all_adids.add(adid)
    
    for i, adid in enumerate(all_adids):
        print(f"    [{i+1}/{len(all_adids)}] Querying book info for {adid[:20]}...")
        book_info = fetch_bookstore_link_by_adid(adid, token)
        if book_info:
            adid_book_info[adid] = book_info
            print(f"      Book: {book_info.get('contentName', 'N/A')}")
        time.sleep(0.2)  # 避免请求过快
    
    # 构建新的 link-stats
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    link_stats = {
        "last_updated": now_utc,
        "date_range": {"from": date_from, "to": date_to},
        "links": {}
    }
    
    # 统计信息
    total_links = 0
    links_with_data = 0
    total_unique = 0
    total_new_users = 0
    total_d14_income = 0.0
    
    # 处理每个 campaign 的 adid 数据
    for campaign_id, campaign_data in putreport_by_adid.items():
        ad_data = campaign_data.get("ad_data", {})
        
        for adid, stats in ad_data.items():
            existing = existing_stats.get(adid, {})
            
            # 数据保护：如果API返回0但旧值>0，保留旧值
            unique = stats.get("unique_users", 0)
            new_users = stats.get("new_users", 0)
            d14_income = stats.get("d14_income", 0.0)
            
            if unique == 0 and existing.get("unique_users", 0) > 0:
                unique = existing["unique_users"]
            if new_users == 0 and existing.get("new_users", 0) > 0:
                new_users = existing["new_users"]
            if d14_income == 0 and existing.get("d14_income", 0) > 0:
                d14_income = existing["d14_income"]
            
            # 获取该 link 的 book 信息
            book_info = adid_book_info.get(adid, {})
            book_name = book_info.get("contentName", existing.get("book_name", ""))
            short_url = book_info.get("shortUrl", "")
            
            # 获取该 link 对应的 submission 信息
            sub_info = None
            for sub in submissions:
                if sub.get("linkId") == adid:
                    sub_info = sub
                    break
            
            # visits 保留旧值（目前没有 per-link visits 数据）
            visits = existing.get("visits", 0)
            
            link_stats["links"][adid] = {
                "visits": max(0, visits),
                "unique_users": max(0, unique),
                "new_users": max(0, new_users),
                "d14_income": max(0, round(d14_income, 2)),
                "campaign_id": campaign_id,
                "source": "putreport_adid",
                "book_name": book_name,
                "short_url": short_url
            }
            
            # 如果有 submission 信息，覆盖/补充字段
            if sub_info:
                link_stats["links"][adid]["koc_username"] = sub_info.get("discordUsername", "")
                link_stats["links"][adid]["status"] = sub_info.get("status", "")
            
            total_links += 1
            if unique > 0 or new_users > 0 or d14_income > 0:
                links_with_data += 1
            total_unique += unique
            total_new_users += new_users
            total_d14_income += d14_income
    

    # ================================================
    # 同步新创建的链接（来自submissions但不在投放报表中）
    # ================================================
    print("\n  Syncing new submissions to link-stats...")
    synced_from_submission = 0
    
    for sub in submissions:
        # 只处理status=completed且有link的提交
        if sub.get("status") != "completed":
            continue
        if not sub.get("link"):
            continue
        
        # 确定链接的key
        link_key = sub.get("linkId")  # 优先使用linkId
        if not link_key:
            # 如果没有linkId，使用code作为key
            code = sub.get("code")
            if code:
                link_key = f"code_{code}"
            else:
                # 如果连code都没有，跳过
                continue
        
        # 如果已存在，跳过
        if link_key in link_stats["links"]:
            continue
        
        # 新增条目
        link_stats["links"][link_key] = {
            "visits": 0,
            "unique_users": 0,
            "new_users": 0,
            "d14_income": 0.0,
            "campaign_id": sub.get("campaignId", ""),
            "source": "submission_sync",
            "book_name": sub.get("matchedBookName", sub.get("bookName", "")),
            "short_url": sub.get("shortUrl", ""),
            "koc_username": sub.get("discordUsername", ""),
            "status": sub.get("status", ""),
            "submission_id": sub.get("id", ""),
            "code": sub.get("code", "")
        }
        total_links += 1
        synced_from_submission += 1
        print(f"    Added: {link_key} ({sub.get('bookName', 'N/A')})")
    
    if synced_from_submission > 0:
        print(f"  Synced {synced_from_submission} new submissions to link-stats")

    # 添加统计摘要
    link_stats["summary"] = {
        "total_links": total_links,
        "links_with_data": links_with_data,
        "total_unique_users": total_unique,
        "total_new_users": total_new_users,
        "total_d14_income": round(total_d14_income, 2)
    }
    
    # 保存 link-stats.json
    with open(link_stats_path, "w") as f:
        json.dump(link_stats, f, indent=2, ensure_ascii=False)
    
    print(f"  link-stats.json saved:")
    print(f"    Total links: {total_links}")
    print(f"    Links with data: {links_with_data}")
    print(f"    Total unique users: {total_unique}")
    print(f"    Total new users: {total_new_users}")
    print(f"    Total d14 income: ${total_d14_income:.2f}")
    
    # 打印有数据的 link 详情
    if links_with_data > 0:
        print(f"\n  Links with data:")
        for link_id, stats in link_stats["links"].items():
            if stats["unique_users"] > 0 or stats["new_users"] > 0 or stats["d14_income"] > 0:
                book_name = stats.get("book_name", "unknown")
                print(f"    {link_id}:")
                print(f"      Book: {book_name}")
                print(f"      Unique: {stats['unique_users']}, New: {stats['new_users']}, D14: ${stats['d14_income']:.2f}")


if __name__ == "__main__":
    main()
