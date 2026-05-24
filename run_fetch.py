import os, sys

# Override paths for sandbox execution
REPO_DIR = "/tmp/nf7"

# Monkey-patch the paths in fetch_koc_data
import fetch_koc_data as fkd
fkd.REPO_DIR = REPO_DIR
fkd.BEIDOU_INFO = os.path.join(REPO_DIR, "beidou-api-info.md")
fkd.MONTHLY_REF = os.path.join(REPO_DIR, "beidou-koc-monthly-data.json")
fkd.ANYSTORIES_INFO = os.path.join(REPO_DIR, "anystories-api-info.md")
fkd.CAMPAIGN_CONFIG = os.path.join(REPO_DIR, "campaign_config.json")

# Also need beidou-api-info.md
# Let me check if it exists
if not os.path.exists(fkd.BEIDOU_INFO):
    print(f"Warning: {fkd.BEIDOU_INFO} not found")
    # Try workspace
    ws_bei = "./beidou-api-info.md"
    if os.path.exists(ws_bei):
        import shutil
        shutil.copy(ws_bei, fkd.BEIDOU_INFO)
        print(f"Copied from workspace")

if not os.path.exists(fkd.MONTHLY_REF):
    ws_monthly = "./beidou-koc-monthly-data.json"
    if os.path.exists(ws_monthly):
        import shutil
        shutil.copy(ws_monthly, fkd.MONTHLY_REF)

fkd.main()
