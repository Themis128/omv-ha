#!/usr/bin/env python3
"""Daily leads digest — Notion Status=New submissions → Slack."""
import os, json, urllib.request, urllib.error, datetime

slack_url = os.environ["SLACK_WEBHOOK_URL"]
notion_key = os.environ["NOTION_API_KEY"]
db_id = os.environ["NOTION_SUBMISSIONS_DB_ID"]

NOTION_HEADERS = {
    "Authorization": f"Bearer {notion_key}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}

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
    """Safely extract a property value from a Notion page."""
    props = page.get("properties", {})
    prop = props.get(key, {})
    try:
        if prop_type == "title":
            return prop["title"][0]["text"]["content"] if prop.get("title") else ""
        elif prop_type == "email":
            return prop.get("email", "")
        elif prop_type == "rich_text":
            return prop["rich_text"][0]["text"]["content"] if prop.get("rich_text") else ""
        elif prop_type == "select":
            return prop["select"]["name"] if prop.get("select") else ""
        elif prop_type == "created_time":
            return page.get("created_time", "")[:10]
    except (KeyError, IndexError, TypeError):
        return ""
    return ""

payload = {
    "filter": {"property": "Status", "select": {"equals": "New"}},
    "sorts": [{"timestamp": "created_time", "direction": "descending"}],
    "page_size": 20,
}

result = notion_query(db_id, payload)

if "results" not in result:
    print(f"Notion API error: {result}")
    raise SystemExit(1)

pages = result["results"]
print(f"Found {len(pages)} New submission(s)")

if not pages:
    slack("Daily Leads Digest: No new submissions today. :white_check_mark:")
    print("No submissions — Slack notified.")
    raise SystemExit(0)

lines = []
for page in pages:
    # Try common property names — adapt if your DB uses different names
    name = (get_prop(page, "Name", "title") or
            get_prop(page, "Full Name", "title") or
            get_prop(page, "Contact", "title") or "?")
    email = (get_prop(page, "Email", "email") or
             get_prop(page, "Email Address", "email") or "?")
    service = (get_prop(page, "Service", "select") or
               get_prop(page, "Message", "rich_text") or
               get_prop(page, "Subject", "rich_text") or "")
    date = get_prop(page, "Created", "created_time") or page.get("created_time", "")[:10]

    excerpt = service[:60] + ("…" if len(service) > 60 else "")
    lines.append(f"• {name} ({email}) — {excerpt} — {date}")

today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
msg = f"*Daily Leads Digest — {len(pages)} new submission(s) ({today})*\n" + "\n".join(lines)
slack(msg)
print(f"Digest sent — {len(pages)} submissions.")
