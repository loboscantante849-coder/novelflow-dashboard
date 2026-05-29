#!/usr/bin/env python3
"""
KOC数据每日更新脚本
从putreport API获取KOC推广数据，更新data.json和link-stats.json
"""

import json
import os
import requests
from datetime import datetime, timedelta
import sys

# 配置
DASHBOARD_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(DASHBOARD_DIR, 'data.json')
LINK_STATS_FILE = os.path.join(DASHBOARD_DIR, 'link-stats.json')
CAMPAIGN_CONFIG_FILE = os.path.join(DASHBOARD_DIR, 'campaign_config.json')

# API配置
OIDC_ENDPOINT = "https://sts.anystories.app/connect/token"
REPORT_ENDPOINT = "https://ad.anystories.app/api/v1/novelflowmiddlegroundmanage/putreport/putreport"

# 从环境变量或硬编码获取凭证
OIDC_USERNAME = "xujt"
OIDC_PASSWORD = "9@OY9NuHX4O2"

def get_oidc_token():
    """获取OIDC访问令牌"""
    try:
        response = requests.post(
            OIDC_ENDPOINT,
            data={
                "grant_type": "password",
                "client_id": "AuthClient",
                "username": OIDC_USERNAME,
                "password": OIDC_PASSWORD,
                "scope": "openid profile roles email offline_access"
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30
        )
        if response.status_code == 200:
            return response.json().get("access_token")
        else:
            print(f"❌ Token获取失败: {response.status_code}")
            return None
    except Exception as e:
        print(f"❌ Token获取异常: {e}")
        return None

def get_campaign_data(token, start_date, end_date, groupings=None):
    """获取指定广告系列的数据"""
    headers = {
        "Authorization": f"Bearer {token}",
        "X-OS": "web",
        "X-AppName": "web-admin",
        "X-AppIdentifier": "web",
        "X-AppVersion": "1.0.0,1",
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "application/json"
    }
    
    # 活跃campaign IDs
    active_campaigns = [
        "69f42260362028a0ac10b770",  # ConsEspher
        "69f94be3e71c030eb9032000"   # DRAS
    ]
    
    # 按campaignid查
    payload = {
        "filters": {
            "productline": ["NovelFlow"],
            "mediasource": [],
            "mediasource2": ["SocialMedia"],
            "date": {"from": start_date, "to": end_date, "datesLabel": ""},
            "campaignid": active_campaigns,
            "adsetid": [],
            "adid": [],
            "copywritingid": []
        },
        "groupings": groupings or ["campaignid", "adid"]
    }
    
    try:
        resp = requests.post(REPORT_ENDPOINT, headers=headers, json=payload, timeout=30)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("code") == 200:
                return data.get("data", [])
            else:
                print(f"⚠️ API返回错误: {data.get('msg', 'Unknown error')}")
                return []
        else:
            print(f"⚠️ 请求失败: {resp.status_code} - {resp.text[:200]}")
            return []
    except Exception as e:
        print(f"❌ API异常: {e}")
        return []

def load_existing_data():
    """加载现有数据文件"""
    data = {"last_updated": None, "users": {}}
    links = {"last_updated": None, "date_range": {}, "links": {}}
    
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, 'r') as f:
                data = json.load(f)
        except Exception as e:
            print(f"⚠️ 加载data.json失败: {e}")
    
    if os.path.exists(LINK_STATS_FILE):
        try:
            with open(LINK_STATS_FILE, 'r') as f:
                links = json.load(f)
        except Exception as e:
            print(f"⚠️ 加载link-stats.json失败: {e}")
    
    return data, links

def save_data(data, links):
    """保存更新后的数据文件"""
    try:
        with open(DATA_FILE, 'w') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"✅ data.json 已更新")
    except Exception as e:
        print(f"❌ 保存data.json失败: {e}")
    
    try:
        with open(LINK_STATS_FILE, 'w') as f:
            json.dump(links, f, indent=2, ensure_ascii=False)
        print(f"✅ link-stats.json 已更新")
    except Exception as e:
        print(f"❌ 保存link-stats.json失败: {e}")

def update_data_files(raw_data, existing_data, existing_links):
    """更新数据文件，应用数据保护逻辑"""
    now_et = datetime.now().strftime("%Y-%m-%d %H:%M (ET)")
    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    
    # KOC用户名映射
    koc_mapping = {
        "69f42260362028a0ac10b770": "ConsEspher",
        "69f94be3e71c030eb9032000": "DRAS"
    }
    
    # 按用户聚合
    user_stats = {}
    # 按链接聚合
    link_stats = {}
    
    for record in raw_data:
        campaign_id = record.get("campaignid", "")
        adid = record.get("adid", "")
        unique = int(record.get("h5landingpageclickusernum", 0) or 0)
        new_users = int(record.get("newusernum", 0) or 0)
        date = record.get("date", "")
        income = float(record.get("d14income", 0) or 0)
        
        koc_username = koc_mapping.get(campaign_id, "unknown")
        
        # 按用户聚合
        if koc_username not in user_stats:
            user_stats[koc_username] = {
                "name": koc_username,
                "campaign_id": campaign_id,
                "unique_users": 0,
                "new_users": 0,
                "visits": 0,
                "d14income": 0.0,
                "last_updated": None
            }
        
        # 数据保护逻辑：API返回0但旧值>0时不覆盖
        user_data = existing_data.get("users", {}).get(koc_username)
        if user_data and unique == 0:
            old_unique = user_data.get("unique_users", 0)
            if old_unique > 0:
                unique = old_unique
        
        if user_data and new_users == 0:
            old_new = user_data.get("new_users", 0)
            if old_new > 0:
                new_users = old_new
        
        if user_data and income == 0:
            old_income = user_data.get("d14income", 0)
            if old_income > 0:
                income = old_income
        
        user_stats[koc_username]["unique_users"] += unique
        user_stats[koc_username]["new_users"] += new_users
        user_stats[koc_username]["visits"] += unique
        user_stats[koc_username]["d14income"] += income
        user_stats[koc_username]["last_updated"] = now_et
        
        # 按链接记录（如果有adid）
        if adid:
            # 数据保护
            old_link = existing_links.get("links", {}).get(adid, {})
            if unique == 0 and old_link.get("unique_users", 0) > 0:
                unique = old_link.get("unique_users", 0)
            if new_users == 0 and old_link.get("new_users", 0) > 0:
                new_users = old_link.get("new_users", 0)
            if income == 0 and old_link.get("d14_income", 0) > 0:
                income = old_link.get("d14_income", 0)
            
            link_stats[adid] = {
                "visits": 0,
                "unique_users": unique,
                "new_users": new_users,
                "d14_income": income,
                "campaign_id": campaign_id,
                "source": "putreport_adid",
                "koc_username": koc_username,
                "status": "completed"
            }
    
    # 更新data.json
    existing_data["last_updated"] = now_et
    existing_data["users"] = user_stats
    
    # 更新link-stats.json
    existing_links["last_updated"] = now_iso
    existing_links["links"] = link_stats
    
    # 计算汇总
    total_users = sum(u["unique_users"] for u in user_stats.values())
    total_visits = sum(u["visits"] for u in user_stats.values())
    total_new = sum(u["new_users"] for u in user_stats.values())
    total_income = sum(u["d14income"] for u in user_stats.values())
    
    return total_users, total_visits, total_new, total_income

def main():
    print("=" * 50)
    print("🔄 KOC数据每日更新")
    print(f"⏰ 执行时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 50)
    
    # 加载现有数据
    existing_data, existing_links = load_existing_data()
    print(f"📂 已加载现有数据")
    
    # 获取OIDC Token
    print("🔑 获取访问令牌...")
    token = get_oidc_token()
    if not token:
        print("❌ 无法获取访问令牌，退出")
        sys.exit(1)
    print("✅ Token获取成功")
    
    # 获取最近14天数据
    end_date = datetime.now().strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=14)).strftime("%Y-%m-%d")
    
    print(f"📡 从API获取数据 ({start_date} ~ {end_date})...")
    raw_data = get_campaign_data(token, start_date, end_date)
    
    if not raw_data:
        print("⚠️ API返回空数据，保留现有数据")
    else:
        print(f"📊 获取到 {len(raw_data)} 条记录")
        
        # 更新数据文件
        total_users, total_visits, total_new, total_income = update_data_files(
            raw_data, existing_data, existing_links
        )
        save_data(existing_data, existing_links)
        
        print(f"\n📈 汇总数据:")
        print(f"   - 总用户: {total_users}")
        print(f"   - 总访问: {total_visits}")
        print(f"   - 新用户: {total_new}")
        print(f"   - D14收入: ${total_income:.2f}")
    
    print("\n✅ 数据更新完成")

if __name__ == "__main__":
    main()
