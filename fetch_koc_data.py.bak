import json
import requests
import time
import re
import sys
from datetime import datetime, timezone, timedelta

# --- Config ---
API_BASE = "https://beidou.win"
PROJECT_ID = "1006"
REPO_DIR = "/root/novelflow-dashboard"

# Read token from beidou-api-info.md
def get_token():
    with open("/app/data/所有对话/主对话/beidou-api-info.md", "r") as f:
        content = f.read()
    # Find token after "当前Token"
    match = re.search(r'当前Token[^:]*:\s*`?([a-zA-Z0-9_\-\.]+)`?', content)
    if match:
        return match.group(1)
    raise Exception("Token not found in beidou-api-info.md")

# Date range: current month 1st to today
def get_date_range():
    now = datetime.now(timezone(timedelta(hours=8)))  # Beijing time
    first_day = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    start = first_day.strftime("%Y-%m-%d 00:00")
    end = now.strftime("%Y-%m-%d 23:59")
    start_date = first_day.strftime("%Y-%m-%d")
    end_date = now.strftime("%Y-%m-%d")
    return start, end, start_date, end_date

# Build filter for KOC campaigns (CONTAIN KOC_, NOT CONTAIN KOC-RW)
def build_koc_filter():
    return {
        "relation": "and",
        "conditions": [
            {"field": "e.product_line", "function": "EQUAL", "paramDatas": ["NovelFlow"]},
            {"field": "e.self_campaign_name", "function": "CONTAIN", "paramDatas": ["KOC_"]}
        ],
        "filters": [
            {
                "relation": "and",
                "conditions": [
                    {"field": "e.self_campaign_name", "function": "NOT_CONTAIN", "paramDatas": ["KOC-RW"]}
                ],
                "filters": []
            }
        ]
    }

# Build byFieldParams
def build_by_field_params():
    return [{
        "fieldName": "e.self_campaign_name",
        "propNmCh": "广告系列名称（自建）",
        "propNm": "self_campaign_name",
        "field": "e.self_campaign_name",
        "fieldLabel": "广告系列名称（自建）",
        "groupByDataType": "STRING",
        "dataTypeValue": "STRING",
        "reportPropType": "EventProp",
        "canAccessData": True,
        "id": 694111718764677,
        "proType": "2",
        "sqlExpression": "",
        "isVisible": "1"
    }]

# Build measures
def build_measures(field="BodyCount", aggregator="BodyCount", name="总link日拉活", alias="measure_6"):
    return [{
        "event_name": "app_launch",
        "event_id": 225,
        "metadata": {"color": "success", "origiName": name},
        "field": field,
        "aggregator": aggregator,
        "name": name,
        "measureAliasName": alias,
        "bucketId": 1,
        "fieldLabel": "实体数"
    }]

# Call API with retry for async
def call_api(token, body, max_retries=5, wait_seconds=15):
    url = f"{API_BASE}/api/v1/event-analysis-report/query-report"
    headers = {
        "Authorization": f"Bearer {token}",
        "x-project-id": PROJECT_ID,
        "Content-Type": "application/json"
    }
    
    for attempt in range(max_retries):
        resp = requests.post(url, json=body, headers=headers, timeout=60)
        if resp.status_code == 401:
            raise Exception("TOKEN_EXPIRED")
        
        data = resp.json()
        if data.get("is_done"):
            return data
        
        # Not done yet, wait and retry
        print(f"  API async, attempt {attempt+1}, waiting {wait_seconds}s...")
        time.sleep(wait_seconds)
    
    raise Exception(f"API still not done after {max_retries} retries")

# Extract KOC username from campaign name
# e.g. "NovelFlow_SocialMedia_KOC_ConsEspher" -> "ConsEspher"
# e.g. "NovelFlow_SocialMedia_KOC_Boochick5" -> "Boochick5"
def extract_koc_username(campaign_name):
    # Find KOC_ prefix
    match = re.search(r'KOC_([A-Za-z0-9_/]+)$', campaign_name)
    if match:
        return match.group(1).replace("/", " ")
    return None

# Map KOC username from campaign name to data.json username
# The data.json has slightly different formatting (spaces, case)
def map_koc_username(campaign_username, data_users):
    # Direct match
    if campaign_username in data_users:
        return campaign_username
    
    # Case-insensitive match
    for u in data_users:
        if u.lower().replace(" ", "").replace("/", "") == campaign_username.lower().replace(" ", "").replace("/", ""):
            return u
    
    # Try without special chars
    campaign_clean = campaign_username.lower().replace(" ", "").replace("/", "").replace("-", "")
    for u in data_users:
        u_clean = u.lower().replace(" ", "").replace("/", "").replace("-", "")
        if u_clean == campaign_clean:
            return u
    
    return None

# Parse daily visits data from API response
def parse_daily_data(resp_data):
    """Parse response with unit=DAY, return {campaign_name: {date: visits}}"""
    result = {}
    if not resp_data or not resp_data.get("items"):
        return result
    
    item = resp_data["items"][0]
    detail = item.get("detailResult", {})
    series = detail.get("series", [])  # ["26-05-08", "26-05-07", ...]
    rows = detail.get("rows", [])
    
    # Convert series to full dates: "26-05-08" -> "2026-05-08"
    full_dates = []
    for s in series:
        if s.startswith("26-"):
            full_dates.append("20" + s)
        else:
            full_dates.append(s)
    
    for row in rows:
        campaign_name = row["byValues"][0]
        values = row["values"]  # [[1043], [1468], ...]
        
        daily = {}
        for i, date in enumerate(full_dates):
            if i < len(values):
                val = values[i][0] if values[i] else 0
                if val > 0:
                    daily[date] = val
        
        result[campaign_name] = daily
    
    return result

# Parse monthly unique data from API response
def parse_monthly_data(resp_data):
    """Parse response with unit=MONTH, return {campaign_name: unique_count}"""
    result = {}
    if not resp_data or not resp_data.get("items"):
        return result
    
    item = resp_data["items"][0]
    detail = item.get("detailResult", {})
    rows = detail.get("rows", [])
    
    for row in rows:
        campaign_name = row["byValues"][0]
        sum_values = row.get("sumValues", [0])
        result[campaign_name] = sum_values[0] if sum_values else 0
    
    return result

# Calculate link_unique_daily using ratio + largest remainder method
def calc_unique_daily(link_visits, link_unique, link_visits_daily):
    if link_visits == 0 or link_unique == 0:
        return {}
    
    ratio = link_unique / link_visits
    
    # Calculate raw values
    daily_raw = {}
    for date, visits in link_visits_daily.items():
        daily_raw[date] = visits * ratio
    
    # Largest remainder method
    int_parts = {d: int(v) for d, v in daily_raw.items()}
    remainders = {d: v - int_parts[d] for d, v in daily_raw.items()}
    
    total_allocated = sum(int_parts.values())
    remaining = link_unique - total_allocated
    
    if remaining > 0:
        # Sort by remainder descending, allocate 1 to each
        sorted_dates = sorted(remainders.keys(), key=lambda d: remainders[d], reverse=True)
        for i in range(int(remaining)):
            if i < len(sorted_dates):
                int_parts[sorted_dates[i]] += 1
    
    # Ensure no negative values
    result = {d: max(0, v) for d, v in int_parts.items()}
    
    return result

# Get current New York time
def get_ny_time_str():
    ny_tz = timezone(timedelta(hours=-4))  # EDT (Eastern Daylight Time)
    now = datetime.now(ny_tz)
    return now.strftime("%Y-%m-%d %H:%M (ET)")

# Main
def main():
    print("=== KOC Data Fetch Start ===")
    
    # 1. Get token
    token = get_token()
    print(f"Token loaded: {token[:20]}...")
    
    # 2. Get date range
    start, end, start_date, end_date = get_date_range()
    print(f"Date range: {start} ~ {end}")
    
    # 3. Load current data.json
    with open(f"{REPO_DIR}/data.json", "r") as f:
        data = json.load(f)
    
    data_users = list(data["users"].keys())
    
    # 4. Query 1: Visits (by day, not deduplicated)
    print("\n--- Query 1: Visits by Day ---")
    visits_body = {
        "approx": True,
        "sampling_factor": 1,
        "projectId": 1006,
        "timeZones": ["Etc/Greenwich", "Etc/Greenwich"],
        "analysisTypeName": "ccid",
        "byFieldParams": build_by_field_params(),
        "arith_rollup": True,
        "maxRowNumber": 2000,
        "maxGroupNumber": 500,
        "measures": build_measures("BodyCount", "BodyCount", "总link日拉活", "measure_6"),
        "filter": build_koc_filter(),
        "dateRange": [start, end],
        "unit": "DAY"
    }
    
    try:
        visits_resp = call_api(token, visits_body)
        visits_data = parse_daily_data(visits_resp)
        print(f"  Got daily visits for {len(visits_data)} campaigns")
    except Exception as e:
        if "TOKEN_EXPIRED" in str(e):
            print("ERROR: Token expired! Need re-login.")
            sys.exit(1)
        print(f"ERROR fetching visits: {e}")
        visits_data = {}
    
    # 5. Query 2: Unique (by month, deduplicated)
    print("\n--- Query 2: Unique by Month ---")
    unique_body = {
        "approx": True,
        "sampling_factor": 1,
        "projectId": 1006,
        "timeZones": ["Etc/Greenwich", "Etc/Greenwich"],
        "analysisTypeName": "ccid",
        "byFieldParams": build_by_field_params(),
        "arith_rollup": True,
        "maxRowNumber": 2000,
        "maxGroupNumber": 500,
        "measures": build_measures("UniqueBodyCount", "UniqueBodyCount", "月度去重拉活", "measure_7"),
        "filter": build_koc_filter(),
        "dateRange": [start, end],
        "unit": "MONTH"
    }
    
    try:
        unique_resp = call_api(token, unique_body)
        unique_data = parse_monthly_data(unique_resp)
        print(f"  Got monthly unique for {len(unique_data)} campaigns")
    except Exception as e:
        if "TOKEN_EXPIRED" in str(e):
            print("ERROR: Token expired! Need re-login.")
            sys.exit(1)
        print(f"ERROR fetching unique: {e}")
        unique_data = {}
    
    # 6. Process and update data.json
    print("\n--- Processing Data ---")
    updated_users = set()
    
    # Build mapping from campaign names to usernames
    for campaign_name, daily_visits in visits_data.items():
        koc_name = extract_koc_username(campaign_name)
        if not koc_name:
            continue
        
        # Skip KOC-RW
        if "KOC-RW" in campaign_name:
            continue
        
        mapped_name = map_koc_username(koc_name, data_users)
        if not mapped_name:
            print(f"  WARNING: Could not map '{koc_name}' from campaign '{campaign_name}'")
            continue
        
        # Calculate total visits
        total_visits = sum(daily_visits.values())
        
        # Get unique count from monthly data
        unique_count = unique_data.get(campaign_name, None)
        
        # Update user data
        if mapped_name in data["users"]:
            data["users"][mapped_name]["link_visits"] = total_visits
            data["users"][mapped_name]["link_visits_daily"] = daily_visits
            
            # Only update unique data if API returned it successfully
            if unique_count is not None:
                data["users"][mapped_name]["link_unique"] = unique_count
                data["users"][mapped_name]["link_unique_daily"] = calc_unique_daily(
                    total_visits, unique_count, daily_visits
                )
            elif total_visits > 0 and data["users"][mapped_name].get("link_unique", 0) > 0:
                # API failed but we have existing unique data - recalculate daily from existing total
                existing_unique = data["users"][mapped_name]["link_unique"]
                data["users"][mapped_name]["link_unique_daily"] = calc_unique_daily(
                    total_visits, existing_unique, daily_visits
                )
            
            updated_users.add(mapped_name)
            print(f"  {mapped_name}: visits={total_visits}, unique={unique_count}, days={len(daily_visits)}")
    
    # Also check unique_data for campaigns not in visits_data (zero visits but some unique?)
    for campaign_name, unique_count in unique_data.items():
        koc_name = extract_koc_username(campaign_name)
        if not koc_name or "KOC-RW" in campaign_name:
            continue
        mapped_name = map_koc_username(koc_name, data_users)
        if mapped_name and mapped_name not in updated_users and mapped_name in data["users"]:
            # This user has unique data but no visit data (edge case)
            data["users"][mapped_name]["link_unique"] = unique_count
            print(f"  {mapped_name}: unique={unique_count} (no daily visits)")
    
    # Update last_updated
    data["last_updated"] = get_ny_time_str()
    print(f"\nlast_updated: {data['last_updated']}")
    print(f"Updated {len(updated_users)} users")
    
    # 7. Save data.json
    with open(f"{REPO_DIR}/data.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print("data.json saved")
    
    # 8. Git push
    print("\n--- Git Push ---")
    import subprocess
    
    subprocess.run(["git", "add", "data.json"], cwd=REPO_DIR, capture_output=True)
    result = subprocess.run(["git", "commit", "-m", f"Update KOC data {get_ny_time_str()}"], cwd=REPO_DIR, capture_output=True, text=True)
    
    if "nothing to commit" in result.stdout or "nothing to commit" in result.stderr:
        print("No changes to commit")
    else:
        print(f"Commit: {result.stdout.strip()}")
        
        result = subprocess.run(
            ["git", "push"],
            cwd=REPO_DIR,
            capture_output=True, text=True,
            env={**__import__('os').environ, "GIT_TERMINAL_PROMPT": "0"}
        )
        if result.returncode == 0:
            print("Push successful")
        else:
            print(f"Push failed: {result.stderr}")
    
    print("\n=== Done ===")

if __name__ == "__main__":
    main()
