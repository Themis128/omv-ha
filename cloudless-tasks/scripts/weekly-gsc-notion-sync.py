#!/usr/bin/env python3
"""Weekly GSC → Notion sync: push 7-day analytics to Notion GSC Reports DB + Slack confirmation."""
import os, json, urllib.request, urllib.error, urllib.parse, datetime, subprocess, sys

slack_url = os.environ["SLACK_WEBHOOK_URL"]
notion_key = os.environ["NOTION_API_KEY"]
gsc_db_id = os.environ["NOTION_GSC_REPORTS_DB_ID"]
private_key = os.environ["GOOGLE_PRIVATE_KEY"].replace("\\n", "\n")
client_email = os.environ["GOOGLE_CLIENT_EMAIL"]
site_url = os.environ["GSC_SITE_URL"]

NOTION_HEADERS = {
    "Authorization": f"Bearer {notion_key}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}

def slack(text):
    data = json.dumps({"text": text}).encode()
    urllib.request.urlopen(
        urllib.request.Request(slack_url, data=data, headers={"Content-Type": "application/json"}),
        timeout=10
    )

def get_gsc_token():
    try:
        from google.oauth2 import service_account
        import google.auth.transport.requests
    except ImportError:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "google-auth", "--break-system-packages", "-q"],
            check=True
        )
        from google.oauth2 import service_account
        import google.auth.transport.requests

    info = {
        "type": "service_account",
        "client_email": client_email,
        "private_key": private_key,
        "token_uri": "https://oauth2.googleapis.com/token",
    }
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/webmasters.readonly"]
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token

def gsc_query(token, payload):
    encoded = urllib.parse.quote(site_url, safe="")
    url = f"https://www.googleapis.com/webmasters/v3/sites/{encoded}/searchAnalytics/query"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

def notion_create_page(payload):
    url = "https://api.notion.com/v1/pages"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers=NOTION_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

today = datetime.date.today()
end_date = (today - datetime.timedelta(days=1)).isoformat()
start_date = (today - datetime.timedelta(days=7)).isoformat()

print(f"Fetching GSC data {start_date} → {end_date}")
token = get_gsc_token()

# Totals (no dimensions)
totals_resp = gsc_query(token, {
    "startDate": start_date,
    "endDate": end_date,
    "rowLimit": 1,
})
rows = totals_resp.get("rows", [])
if rows:
    r = rows[0]
    clicks = int(r.get("clicks", 0))
    impressions = int(r.get("impressions", 0))
    ctr = round(r.get("ctr", 0), 4)          # store as decimal e.g. 0.0312
    avg_pos = round(r.get("position", 0), 2)
else:
    clicks = impressions = 0
    ctr = avg_pos = 0.0

print(f"Totals: {clicks} clicks, {impressions} impressions, CTR {ctr:.2%}, pos {avg_pos}")

# Top 5 keywords
kw_resp = gsc_query(token, {
    "startDate": start_date,
    "endDate": end_date,
    "dimensions": ["query"],
    "rowLimit": 5,
})
kw_rows = kw_resp.get("rows", [])
top_keywords = ", ".join(row["keys"][0] for row in kw_rows) if kw_rows else ""
print(f"Top keywords: {top_keywords}")

# Create Notion page
week_label = f"{start_date} to {end_date}"
page_payload = {
    "parent": {"database_id": gsc_db_id},
    "properties": {
        "Week": {"title": [{"text": {"content": week_label}}]},
        "Clicks": {"number": clicks},
        "Impressions": {"number": impressions},
        "CTR": {"number": ctr},
        "Avg Position": {"number": avg_pos},
        "Top Keywords": {"rich_text": [{"text": {"content": top_keywords}}]},
    },
}

result = notion_create_page(page_payload)

if "id" in result:
    print(f"Notion page created: {result['id']}")
    msg = (f"GSC weekly sync complete :white_check_mark: "
           f"*{start_date} → {end_date}*: "
           f"{clicks} clicks, {impressions} impressions logged to Notion.")
else:
    print(f"Notion page creation failed: {result}")
    msg = f":warning: GSC weekly sync failed — Notion page not created. Error: {str(result)[:200]}"

slack(msg)
print("Slack confirmation sent.")
