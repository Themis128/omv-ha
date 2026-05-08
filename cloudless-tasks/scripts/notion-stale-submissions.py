#!/usr/bin/env python3
"""Alert Slack when any Notion submission has been in 'New' status for 3+ days."""
import os, json, urllib.request, urllib.error, datetime

slack_url = os.environ["SLACK_WEBHOOK_URL"]
notion_key = os.environ["NOTION_API_KEY"]
db_id = os.environ["NOTION_SUBMISSIONS_DB_ID"]

NOTION_HEADERS = {
    "Authorization": f"Bearer {notion_key}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}
STALE_DAYS = 3

def notion_query(database_id, payload):
    url = f"https://api.notion.com/v1/databases/{database_id}/query"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers=NOTION_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

def slack(text):
    data = json.dumps({"text": text}).encode()
    urllib.request.urlopen(
        urllib.request.Request(slack_url, data=data, headers={"Content-Type": "application/json"}),
        timeout=10
    )

def get_prop(page, key, prop_type):
    props = page.get("properties", {})
    prop = props.get(key, {})
    try:
        if prop_type == "title":
            return prop["title"][0]["text"]["content"] if prop.get("title") else ""
        elif prop_type == "email":
            return prop.get("email", "")
        elif prop_type == "rich_text":
            return prop["rich_text"][0]["text"]["content"] if prop.get("rich_text") else ""
    except (KeyError, IndexError, TypeError):
        return ""
    return ""

payload = {
    "filter": {"property": "Status", "select": {"equals": "New"}},
    "page_size": 50,
}

result = notion_query(db_id, payload)

if "results" not in result:
    print(f"Notion API error: {result}")
    raise SystemExit(1)

pages = result["results"]
print(f"Found {len(pages)} New submission(s) total")

now = datetime.datetime.now(datetime.timezone.utc)
cutoff = now - datetime.timedelta(days=STALE_DAYS)

stale = []
for page in pages:
    created_str = page.get("created_time", "")
    if not created_str:
        continue
    try:
        created = datetime.datetime.fromisoformat(created_str.replace("Z", "+00:00"))
    except ValueError:
        continue
    if created < cutoff:
        days_waiting = (now - created).days
        name = (get_prop(page, "Name", "title") or
                get_prop(page, "Full Name", "title") or
                get_prop(page, "Contact", "title") or "?")
        email = get_prop(page, "Email", "email") or get_prop(page, "Email Address", "email") or "?"
        submitted = created.strftime("%Y-%m-%d")
        stale.append((name, email, days_waiting, submitted))

print(f"Stale (>{STALE_DAYS} days): {len(stale)}")

if not stale:
    print("No stale submissions — no Slack alert needed.")
    raise SystemExit(0)

lines = [f"• {name} ({email}) — {days}d waiting, submitted {date}"
         for name, email, days, date in stale]

msg = (f":warning: *Stale Submissions Alert* — {len(stale)} submission(s) "
       f"in New status for {STALE_DAYS}+ days:\n" + "\n".join(lines))
slack(msg)
print(f"Slack alert sent — {len(stale)} stale submission(s).")
