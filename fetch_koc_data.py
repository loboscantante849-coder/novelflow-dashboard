import json
import requests
import time
import re
import sys
import os
from datetime import datetime, timezone, timedelta

API_BASE = "https://beidou.win"
PROJECT_ID = "1006"
REPO_DIR = os.path.expanduser("~/novelflow-dashboard")
BEIDOU_INFO = "/app/data/所有对话/主对话/beidou-api-info.md"
MONTHLY_REF = "/app/data/所有对话/主对话/beidou-koc-monthly-data.json"

def get_token():
    with open(BEIDOU_INFO, "r") as f:
        content = f.read()
    match = re.search(r'当前Token[^:]*:\s*`?([a-zA-Z0-9_\-\.]+)`?', content)
    if match:
        return match.group(1)
    raise Exception("Token not found")

def get_date_range():
    now = datetime.now(timezone(timedelta(hours=8)))
    first_day = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    start = first_day.strftime("%Y-%m-%d 00:00")
    end = now.strftime("%Y-%m-%d 23:59")
    return start, end

def build_koc_filter():
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
    return [{
        "fieldName": "e.self_campaign_name", "propNmCh": "广告系列名称（自建）",
        "propNm": "self_campaign_name", "field": "e.self_campaign_name",
        "fieldLabel": "广告系列名称（自建）", "groupByDataType": "STRING",
        "dataTypeValue": "STRING", "reportPropType": "EventProp",
        "canAccessData": True, "id": 694111718764677, "proType": "2",
        "sqlExpression": "", "isVisible": "1"
    }]

def build_measures(field, aggregator, name, alias):
    return [{
        "event_name": "app_launch", "event_id": 225,
        "metadata": {"color": "success", "origiName": name},
        "field": field, "aggregator": aggregator, "name": name,
        "measureAliasName": alias, "bucketId": 1, "fieldLabel": "实体数"
    }]

def call_api(token, body, max_retries=5, wait_seconds=12):
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

def extract_koc_username(campaign_name):
    match = re.search(r'KOC_([A-Za-z0-9_/]+)$', campaign_name)
    return match.group(1).replace("/", " ") if match else None

def map_koc_username(campaign_username, data_users):
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
    ny_tz = timezone(timedelta(hours=-4))
    return datetime.now(ny_tz).strftime("%Y-%m-%d %H:%M (ET)")

def load_monthly_ref():
    """Load reference monthly unique data as fallback"""
    try:
        with open(MONTHLY_REF, "r") as f:
            return json.load(f).get("data", {})
    except:
        return {}

def update_fallback_data(data):
    """Replace FALLBACK_DATA in dashboard.html with current data.json content."""
    import os as _os
    html_path = _os.path.join(REPO_DIR, "dashboard.html")
    if not _os.path.exists(html_path):
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
    
    # Build new FALLBACK_DATA, remove runtime metadata
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
    token = get_token()
    print(f"Token: {token[:20]}...")
    start, end = get_date_range()
    print(f"Date: {start} ~ {end}")

    with open(f"{REPO_DIR}/data.json", "r") as f:
        data = json.load(f)
    data_users = list(data["users"].keys())

    # === BULLETPROOF: Snapshot ALL existing unique data before any modification ===
    existing_unique = {}
    existing_unique_daily = {}
    for name, u in data["users"].items():
        if u.get("link_unique", 0) > 0:
            existing_unique[name] = u["link_unique"]
        if u.get("link_unique_daily") and len(u.get("link_unique_daily", {})) > 0:
            existing_unique_daily[name] = dict(u["link_unique_daily"])

    # Query 1: Visits by Day
    print("\n--- Query 1: Visits (BodyCount DAY) ---")
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
        visits_resp = call_api(token, visits_body)
        visits_data = parse_daily_data(visits_resp)
        print(f"  Got {len(visits_data)} campaigns")
    except Exception as e:
        if "TOKEN_EXPIRED" in str(e):
            print("TOKEN EXPIRED!"); sys.exit(1)
        print(f"ERROR: {e}"); visits_data = {}

    # Query 2: Unique by Month (BodyCount MONTH)
    print("\n--- Query 2: Unique (BodyCount MONTH) ---")
    unique_body = {
        "approx": True, "sampling_factor": 1, "projectId": 1006,
        "timeZones": ["Etc/Greenwich", "Etc/Greenwich"],
        "analysisTypeName": "ccid",
        "byFieldParams": build_by_field_params(),
        "arith_rollup": True, "maxRowNumber": 2000, "maxGroupNumber": 500,
        "measures": build_measures("BodyCount", "BodyCount", "月度去重拉活", "measure_6"),
        "filter": build_koc_filter(),
        "dateRange": [start, end],
        "unit": "MONTH"
    }
    unique_data = {}
    try:
        unique_resp = call_api(token, unique_body, max_retries=6, wait_seconds=15)
        unique_data = parse_monthly_data(unique_resp)
        print(f"  Got {len(unique_data)} campaigns")
        for k, v in unique_data.items():
            print(f"    {k}: {v}")
    except Exception as e:
        if "TOKEN_EXPIRED" in str(e):
            print("TOKEN EXPIRED!"); sys.exit(1)
        print(f"  Monthly query failed: {e}")

    # Load fallback
    if not unique_data:
        print("  Loading fallback from beidou-koc-monthly-data.json")
        monthly_ref = load_monthly_ref()
        for koc_key, val in monthly_ref.items():
            # koc_key is like "KOC_ConsEspher"
            koc_name = koc_key.replace("KOC_", "")
            campaign_name = f"NovelFlow_SocialMedia_KOC_{koc_name}"
            if val > 0:
                unique_data[campaign_name] = val
        print(f"  Fallback: {len(unique_data)} campaigns")
        for k, v in unique_data.items():
            print(f"    {k}: {v}")

    # Process
    # === BULLETPROOF UNIQUE DATA PROTECTION ===
    # Rules:
    #   - API returns positive unique → accept it
    #   - API returns 0 but existing > 0 → REJECT API, keep existing (the recurring bug!)
    #   - API returns None (campaign missing) → keep existing, recalculate daily if visits updated
    #   - Never overwrite positive link_unique or non-empty link_unique_daily with 0/empty
    #   - Track unique_last_success timestamp per user
    print("\n--- Processing ---")
    updated_users = set()
    unique_api_had_positive = False
    
    for campaign_name, daily_visits in visits_data.items():
        koc_name = extract_koc_username(campaign_name)
        if not koc_name or "KOC-RW" in campaign_name:
            continue
        mapped_name = map_koc_username(koc_name, data_users)
        if not mapped_name:
            print(f"  WARN: Cannot map '{koc_name}'")
            continue
        total_visits = sum(daily_visits.values())
        
        # Determine unique count with bulletproof logic
        api_unique = unique_data.get(campaign_name, None)
        old_unique = existing_unique.get(mapped_name, 0)
        old_unique_daily = existing_unique_daily.get(mapped_name, {})
        
        if mapped_name in data["users"]:
            # Always update visits (visits API is reliable)
            data["users"][mapped_name]["link_visits"] = total_visits
            data["users"][mapped_name]["link_visits_daily"] = daily_visits
            
            # === UNIQUE DATA PROTECTION ===
            if api_unique is not None and api_unique > 0:
                # Case 1: API returned valid positive → accept
                data["users"][mapped_name]["link_unique"] = api_unique
                data["users"][mapped_name]["link_unique_daily"] = calc_unique_daily(total_visits, api_unique, daily_visits)
                data["users"][mapped_name]["unique_last_success"] = get_ny_time_str()
                unique_api_had_positive = True
                print(f"  {mapped_name}: visits={total_visits}, unique={api_unique} (API OK)")
                
            elif api_unique == 0 and old_unique > 0:
                # Case 2: API returned 0 but we have existing positive → REJECT API, keep existing
                # This is THE bug that keeps recurring: API intermittently returns 0
                data["users"][mapped_name]["link_unique"] = old_unique
                data["users"][mapped_name]["link_unique_daily"] = calc_unique_daily(total_visits, old_unique, daily_visits)
                print(f"  {mapped_name}: visits={total_visits}, unique={old_unique} (API=0 REJECTED, kept existing)")
                
            elif api_unique is None and old_unique > 0:
                # Case 3: API didn't return this campaign → keep existing, update daily with new visits
                data["users"][mapped_name]["link_unique"] = old_unique
                data["users"][mapped_name]["link_unique_daily"] = calc_unique_daily(total_visits, old_unique, daily_visits)
                print(f"  {mapped_name}: visits={total_visits}, unique={old_unique} (API N/A, kept existing)")
                
            else:
                # Case 4: API=0 and existing=0 → confirmed zero
                data["users"][mapped_name]["link_unique"] = 0
                data["users"][mapped_name]["link_unique_daily"] = {}
                print(f"  {mapped_name}: visits={total_visits}, unique=0 (confirmed zero)")
            
            updated_users.add(mapped_name)

    # Also update unique for campaigns in unique_data not in visits_data
    for campaign_name, unique_count in unique_data.items():
        koc_name = extract_koc_username(campaign_name)
        if not koc_name or "KOC-RW" in campaign_name:
            continue
        mapped_name = map_koc_username(koc_name, data_users)
        if mapped_name and mapped_name not in updated_users and mapped_name in data["users"]:
            old_unique = existing_unique.get(mapped_name, 0)
            if unique_count > 0:
                data["users"][mapped_name]["link_unique"] = unique_count
                data["users"][mapped_name]["unique_last_success"] = get_ny_time_str()
                print(f"  {mapped_name}: unique={unique_count} (no daily visits, API OK)")
            elif unique_count == 0 and old_unique > 0:
                print(f"  {mapped_name}: unique={old_unique} (API=0 REJECTED, no visits)")
            else:
                print(f"  {mapped_name}: unique=0 (confirmed zero, no visits)")

    data["last_updated"] = get_ny_time_str()
    print(f"\nlast_updated: {data['last_updated']}")
    print(f"Updated {len(updated_users)} users")
    print(f"Unique API had positive data: {unique_api_had_positive}")

    with open(f"{REPO_DIR}/data.json", "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print("data.json saved")
    
    # Update FALLBACK_DATA in dashboard.html to match data.json
    print("\n--- Updating FALLBACK_DATA ---")
    update_fallback_data(data)

    # Git push
    print("\n--- Git Push ---")
    import subprocess
    subprocess.run(["git", "add", "data.json", "dashboard.html", "fetch_koc_data.py"], cwd=REPO_DIR, capture_output=True)
    result = subprocess.run(["git", "commit", "-m", f"Update KOC data {data['last_updated']}"], cwd=REPO_DIR, capture_output=True, text=True)
    if "nothing to commit" in result.stdout or "nothing to commit" in result.stderr:
        print("No changes")
    else:
        print(f"Committed")
        result = subprocess.run(["git", "push", "origin", "main"], cwd=REPO_DIR, capture_output=True, text=True, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        if result.returncode == 0:
            print("Push successful")
        else:
            print(f"Push failed: {result.stderr}")
    print("\n=== Done ===")

if __name__ == "__main__":
    main()
