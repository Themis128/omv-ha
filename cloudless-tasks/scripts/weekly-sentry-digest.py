#!/usr/bin/env python3
"""Weekly Sentry digest — top 10 unresolved issues by frequency → Slack."""
import os, json, urllib.request, urllib.error, datetime

slack_url = os.environ["SLACK_WEBHOOK_URL"]
sentry_token = os.environ["SENTRY_AUTH_TOKEN"]
sentry_org = os.environ["SENTRY_ORG"]
sentry_project = os.environ["SENTRY_PROJECT"]

def api_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
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

def relative_time(iso_str):
    try:
        dt = datetime.datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        now = datetime.datetime.now(datetime.timezone.utc)
        delta = now - dt
        days = delta.days
        if days == 0:
            hours = delta.seconds // 3600
            return f"{hours}h ago" if hours > 0 else "just now"
        elif days == 1:
            return "1 day ago"
        elif days < 30:
            return f"{days} days ago"
        else:
            return dt.strftime("%Y-%m-%d")
    except Exception:
        return iso_str[:10] if iso_str else "?"

url = (f"https://sentry.io/api/0/projects/{sentry_org}/{sentry_project}"
       f"/issues/?query=is:unresolved&limit=10&sort=freq")
issues = api_get(url, {"Authorization": f"Bearer {sentry_token}"})

if not isinstance(issues, list):
    print(f"Sentry API error: {issues}")
    raise SystemExit(1)

print(f"Fetched {len(issues)} issues from Sentry")

if not issues:
    slack(":white_check_mark: *Weekly Sentry Digest — cloudless.gr*: No unresolved issues!")
    print("No issues — Slack notified.")
    raise SystemExit(0)

# Sort: fatal first, then error, then warning, then info
level_order = {"fatal": 0, "error": 1, "warning": 2, "info": 3, "debug": 4}
issues.sort(key=lambda i: (level_order.get(i.get("level", "error"), 5), -int(i.get("count", 0))))

level_emoji = {"fatal": ":skull:", "error": ":red_circle:", "warning": ":warning:", "info": ":information_source:"}

lines = []
for i in issues:
    level = i.get("level", "error")
    emoji = level_emoji.get(level, ":red_circle:")
    title = i.get("title", "Unknown error")[:80]
    count = i.get("count", "?")
    last_seen = relative_time(i.get("lastSeen", ""))
    lines.append(f"{emoji} *{title}* — {count} events, last seen {last_seen}")

total_url = (f"https://sentry.io/api/0/projects/{sentry_org}/{sentry_project}"
             f"/issues/?query=is:unresolved&limit=1")
try:
    total_hdr = api_get(total_url, {"Authorization": f"Bearer {sentry_token}"})
    # Sentry returns X-Hits header but not in body; use issue count as proxy
    total_note = f"Showing top {len(issues)}"
except Exception:
    total_note = f"Top {len(issues)}"

now = datetime.datetime.utcnow().strftime("%Y-%m-%d")
header = f"*Weekly Sentry Digest — cloudless.gr ({now})*\n{total_note} unresolved issues by frequency:\n"
msg = header + "\n".join(lines)

slack(msg)
print(f"Sentry digest sent — {len(issues)} issues.")
