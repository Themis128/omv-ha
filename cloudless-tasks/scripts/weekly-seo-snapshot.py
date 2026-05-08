#!/usr/bin/env python3
"""Weekly SEO snapshot — GSC last 7 days clicks/impressions + top 10 keywords → Slack."""
import os, json, urllib.request, urllib.error, urllib.parse, datetime, subprocess, sys

slack_url = os.environ["SLACK_WEBHOOK_URL"]
private_key = os.environ["GOOGLE_PRIVATE_KEY"].replace("\\n", "\n")
client_email = os.environ["GOOGLE_CLIENT_EMAIL"]
site_url = os.environ["GSC_SITE_URL"]

def slack(text):
    data = json.dumps({"text": text}).encode()
    urllib.request.urlopen(
        urllib.request.Request(slack_url, data=data, headers={"Content-Type": "application/json"}),
        timeout=10
    )

def get_gsc_token():
    """Get OAuth2 token using service account credentials."""
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

today = datetime.date.today()
end_date = (today - datetime.timedelta(days=1)).isoformat()
start_date = (today - datetime.timedelta(days=7)).isoformat()

print(f"Fetching GSC data {start_date} → {end_date}")
token = get_gsc_token()

# Totals
totals_resp = gsc_query(token, {
    "startDate": start_date,
    "endDate": end_date,
    "rowLimit": 1,
})
rows = totals_resp.get("rows", [])
if rows:
    r = rows[0]
    total_clicks = int(r.get("clicks", 0))
    total_impressions = int(r.get("impressions", 0))
    ctr = r.get("ctr", 0) * 100
    avg_pos = r.get("position", 0)
else:
    total_clicks = total_impressions = 0
    ctr = avg_pos = 0.0

print(f"Totals: {total_clicks} clicks, {total_impressions} impressions")

# Top keywords
kw_resp = gsc_query(token, {
    "startDate": start_date,
    "endDate": end_date,
    "dimensions": ["query"],
    "rowLimit": 10,
})
kw_rows = kw_resp.get("rows", [])

kw_lines = []
for row in kw_rows:
    query = row["keys"][0]
    clicks = int(row.get("clicks", 0))
    impressions = int(row.get("impressions", 0))
    pos = round(row.get("position", 0), 1)
    kw_lines.append(f"• {query} — {clicks} clicks, {impressions} impr, pos {pos}")

header = (f"*Weekly SEO Snapshot — cloudless.gr ({start_date} → {end_date})*\n"
          f"Clicks: *{total_clicks}* | Impressions: *{total_impressions}* | "
          f"CTR: *{ctr:.1f}%* | Avg Position: *{avg_pos:.1f}*")

if kw_lines:
    msg = header + "\n\n*Top Keywords:*\n" + "\n".join(kw_lines)
else:
    msg = header + "\n\n_No keyword data available._"

slack(msg)
print("SEO snapshot sent to Slack.")
