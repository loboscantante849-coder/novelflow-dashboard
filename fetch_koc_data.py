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
    """获取日期范围：从4月28号开始，截止到当天"""
    now = datetime.now(timezone(timedelta(hours=8)))
    # 从2026-04-28开始
    start_date = now.replace(year=2026, month=4, day=28, hour=0, minute=0, second=0, microsecond=0)
    start = start_date.strftime("%Y-%m-%d 00:00")
    end = now.strftime("%Y-%m-%d 23:59")
    date_from = start_date.strftime("%Y-%m-%d")
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
    调用投放报表API获取单个广告系列的汇总数据（campaign级别）
    
    Args:
        campaignid: 广告系列ID
        date_from: 开始日期 (YYYY-MM-DD)
        date_to: 结束日期 (YYYY-MM-DD)
        token: Bearer Token
    
    Returns:
        dict: {
            'campaignid': str,
            'h5landingpageclickusernum': int,
            'newusernum': int,
            'd7income': float
        }
    """
    payload = {
        "filters": {
            "productline": [],
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
        "groupings": ["campaignid"]
    }
    
    headers = {**PUTREPORT_HEADERS, "Authorization": f"Bearer {token}"}
    
    try:
        resp = requests.post(PUTREPORT_API, json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        result = resp.json()
        
        if result.get("code") != 200:
            print(f"    API error: code={result.get('code')}, msg={result.get('msg', 'unknown')}")
            return None
        
        data_list = result.get("data", [])
        if not data_list:
            print(f"    No data returned for campaign {campaignid}")
            return None
        
        item = data_list[0]
        h5 = item.get("h5landingpageclickusernum", 0) or 0
        new = item.get("newusernum", 0) or 0
        d7 = item.get("d7income", 0.0) or 0.0
        
        print(f"    Unique: {h5}, New: {new}, D7: ${d7:.2f}")
        
        return {
            "campaignid": campaignid,
            "h5landingpageclickusernum": h5,
            "newusernum": new,
            "d7income": round(d7, 2)
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
            results[cid] = data
        else:
            print(f"    Failed to fetch data")
        # 避免请求过快
        time.sleep(0.5)
    
    print(f"\n  Successfully fetched: {len(results)}/{len(campaign_ids)} campaigns")
    return results


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
    
    # 获取有投放报表数字ID的活跃广告系列（只有这些才能查Putreport API）
    putreport_campaigns = []
    for c in campaign_config.get("campaign_ids", []):
        if c.get("is_active", False) and c.get("putreport_id"):
            putreport_campaigns.append({"channel_id": c["id"], "putreport_id": c["putreport_id"], "koc_username": c.get("koc_username", "")})
    active_campaigns = [pc["putreport_id"] for pc in putreport_campaigns]
    print(f"\nActive Putreport campaigns (with numeric IDs): {len(active_campaigns)}")
    for pc in putreport_campaigns:
        print(f"  - {pc['koc_username']}: {pc['putreport_id']}")

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
    # STEP 1: 获取投放报表数据 (Unique + New Users)
    # ================================================
    putreport_results = {}
    if active_campaigns:
        putreport_results = fetch_all_putreport_data(active_campaigns, date_from, date_to)
    
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
    
    # 构建putreport_id -> koc_username映射（用数字ID做key）
    cid_to_koc = {}
    for c in campaign_config.get("campaign_ids", []):
        prid = c.get("putreport_id", "")
        if prid:
            cid_to_koc[prid] = c.get("koc_username", "")
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
        
        # 提取汇总数据
        total_unique = putreport_data.get("h5landingpageclickusernum", 0)
        total_new_users = putreport_data.get("newusernum", 0)
        total_d7income = putreport_data.get("d7income", 0.0)
        
        # 旧值
        old_unique = existing_unique.get(mapped_name, 0)
        old_new_users = existing_new_users.get(mapped_name, 0)
        
        # === UNIQUE数据保护 ===
        if total_unique > 0:
            data["users"][mapped_name]["link_unique"] = total_unique
            data["users"][mapped_name]["unique_last_success"] = get_ny_time_str()
            putreport_had_data = True
            print(f"  {mapped_name}: unique={total_unique} (from putreport)")
        elif old_unique > 0:
            data["users"][mapped_name]["link_unique"] = old_unique
            print(f"  {mapped_name}: unique={old_unique} (putreport=0, kept existing)")
        else:
            data["users"][mapped_name]["link_unique"] = 0
            print(f"  {mapped_name}: unique=0 (confirmed zero)")
        
        # === New Users数据保护 ===
        if total_new_users > 0:
            data["users"][mapped_name]["new_users"] = total_new_users
            print(f"    new_users={total_new_users} (from putreport)")
        elif old_new_users > 0:
            data["users"][mapped_name]["new_users"] = old_new_users
            print(f"    new_users={old_new_users} (putreport=0, kept existing)")
        else:
            data["users"][mapped_name]["new_users"] = 0
            print(f"    new_users=0 (confirmed zero)")
        
        # === D7收入 ===
        old_d7income = data["users"][mapped_name].get("d7income", 0.0)
        if total_d7income > 0:
            data["users"][mapped_name]["d7income"] = total_d7income
            print(f"    d7income=${total_d7income:.2f} (from putreport)")
        elif old_d7income > 0:
            data["users"][mapped_name]["d7income"] = old_d7income
            print(f"    d7income=${old_d7income:.2f} (putreport=0, kept existing)")
        else:
            data["users"][mapped_name]["d7income"] = 0.0
            print(f"    d7income=$0.00 (confirmed zero)")
        
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

    # Git push
    print("\n--- Git Push ---")
    import subprocess
    subprocess.run(["git", "add", "data.json", "dashboard.html", "fetch_koc_data.py", "campaign_config.json"], 
                   cwd=REPO_DIR, capture_output=True)
    result = subprocess.run(["git", "commit", "-m", 
                           f"Update KOC data with Putreport API (Unique/New Users) {data['last_updated']}"], 
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


if __name__ == "__main__":
    main()
