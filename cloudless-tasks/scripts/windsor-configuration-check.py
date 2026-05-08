#!/usr/bin/env python3
"""Windsor connector health check — Meta, LinkedIn, Stripe. Alerts Slack on any failure."""
import os, json, urllib.request, urllib.error

slack_url = os.environ["SLACK_WEBHOOK_URL"]
meta_token = os.environ.get("META_ACCESS_TOKEN", "")
li_token = os.environ.get("LINKEDIN_ACCESS_TOKEN", "")
stripe_key = os.environ["STRIPE_SECRET_KEY"]

failures = []

def api_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

def slack(text):
    data = json.dumps({"text": text}).encode()
    urllib.request.urlopen(
        urllib.request.Request(slack_url, data=data, headers={"Content-Type": "application/json"}),
        timeout=10
    )

# Meta
if meta_token:
    d = api_get(f"https://graph.facebook.com/v19.0/me?access_token={meta_token}")
    if "id" in d:
        print(f"Meta: OK ({d.get('name','?')})")
    else:
        failures.append(f"Meta: {d.get('error', {}).get('message', str(d)[:80])}")
else:
    print("Meta: skipped (no META_ACCESS_TOKEN)")

# LinkedIn
if li_token:
    d = api_get("https://api.linkedin.com/v2/userinfo", {"Authorization": f"Bearer {li_token}"})
    if "sub" in d:
        print(f"LinkedIn: OK ({d.get('name','?')})")
    else:
        failures.append(f"LinkedIn: {str(d)[:100]}")
else:
    print("LinkedIn: skipped (no LINKEDIN_ACCESS_TOKEN)")

# Stripe
d = api_get("https://api.stripe.com/v1/account", {"Authorization": f"Bearer {stripe_key}"})
if "id" in d:
    print(f"Stripe: OK ({d.get('email','?')})")
else:
    failures.append(f"Stripe: {d.get('error', {}).get('message', str(d)[:80])}")

if failures:
    msg = ":warning: *Connector Check Failed* — one or more connectors need attention:\n"
    msg += "\n".join(f"• {f}" for f in failures)
    slack(msg)
    print(f"FAIL — Slack alert sent ({len(failures)} failure(s))")
    raise SystemExit(1)

print("All connectors OK — no Slack alert sent")
