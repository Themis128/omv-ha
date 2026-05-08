#!/usr/bin/env python3
"""Weekly agency hub status: K3s pods, Lambda, Sentry, Stripe, site health → Slack."""
import os, json, subprocess, datetime, urllib.request, urllib.error
import boto3

slack_url = os.environ["SLACK_WEBHOOK_URL"]
sentry_token = os.environ.get("SENTRY_AUTH_TOKEN", "")
sentry_org = os.environ.get("SENTRY_ORG", "")
sentry_project = os.environ.get("SENTRY_PROJECT", "")
stripe_key = os.environ.get("STRIPE_SECRET_KEY", "")

sections = []

def api_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code
    except Exception as e:
        return {"_error": str(e)}, 0

def slack(text):
    data = json.dumps({"text": text}).encode()
    urllib.request.urlopen(
        urllib.request.Request(slack_url, data=data, headers={"Content-Type": "application/json"}),
        timeout=10
    )

# 1. K3s pod health
try:
    result = subprocess.run(
        ["kubectl", "get", "pods", "-n", "cloudless", "--no-headers"],
        capture_output=True, text=True, timeout=15,
        env={**os.environ, "KUBECONFIG": "/etc/rancher/k3s/k3s.yaml"}
    )
    lines = result.stdout.strip().splitlines() if result.stdout.strip() else []
    if not lines:
        k3s_msg = ":kubernetes: K3s: no pods in cloudless namespace"
    else:
        not_running = [l for l in lines if not any(s in l for s in ("Running", "Completed"))]
        total = len(lines)
        if not_running:
            k3s_msg = f":kubernetes: K3s: {total} pods — :warning: {len(not_running)} not Running:\n" + "\n".join(f"  `{l.split()[0]} {l.split()[2]}`" for l in not_running)
        else:
            k3s_msg = f":kubernetes: K3s: {total} pods all Running :white_check_mark:"
except Exception as e:
    k3s_msg = f":kubernetes: K3s: check failed ({e})"
sections.append(k3s_msg)
print(k3s_msg)

# 2. Lambda last deploy
try:
    lc = boto3.client("lambda", region_name="us-east-1")
    cfg = lc.get_function_configuration(FunctionName="cloudless-production-server")
    last_mod = cfg.get("LastModified", "?")[:10]
    code_size_kb = cfg.get("CodeSize", 0) // 1024
    lambda_msg = f":lambda: Lambda: last deploy {last_mod}, {code_size_kb} KB"
except Exception as e:
    lambda_msg = f":lambda: Lambda: check failed ({e})"
sections.append(lambda_msg)
print(lambda_msg)

# 3. Sentry: new issues this week
if sentry_token and sentry_org and sentry_project:
    week_ago = (datetime.datetime.utcnow() - datetime.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = f"https://sentry.io/api/0/projects/{sentry_org}/{sentry_project}/issues/?is:unresolved&limit=25&sort=date"
    d, _ = api_get(url, {"Authorization": f"Bearer {sentry_token}"})
    if isinstance(d, list):
        new_this_week = [i for i in d if i.get("firstSeen", "") >= week_ago]
        sentry_msg = f":rotating_light: Sentry: {len(new_this_week)} new issue(s) this week (of {len(d)} unresolved)"
    else:
        sentry_msg = f":rotating_light: Sentry: check failed"
else:
    sentry_msg = ":rotating_light: Sentry: skipped (no credentials)"
sections.append(sentry_msg)
print(sentry_msg)

# 4. Stripe: recent events
if stripe_key:
    d, _ = api_get("https://api.stripe.com/v1/events?limit=5", {"Authorization": f"Bearer {stripe_key}"})
    if "data" in d:
        events = d["data"]
        if events:
            types = [e.get("type", "?") for e in events]
            stripe_msg = f":credit_card: Stripe: last 5 events — {', '.join(types)}"
        else:
            stripe_msg = ":credit_card: Stripe: no recent events"
    else:
        stripe_msg = f":credit_card: Stripe: check failed"
else:
    stripe_msg = ":credit_card: Stripe: skipped (no key)"
sections.append(stripe_msg)
print(stripe_msg)

# 5. Site health
try:
    req = urllib.request.Request("https://cloudless.gr/api/health")
    with urllib.request.urlopen(req, timeout=10) as r:
        body = json.loads(r.read())
        status = body.get("status", "?")
        version = body.get("version", "?")
        health_msg = f":heart: Health: {status} (v{version})"
except Exception as e:
    health_msg = f":heart: Health: check failed ({e})"
sections.append(health_msg)
print(health_msg)

# 6. Post to Slack
now = datetime.datetime.utcnow().strftime("%Y-%m-%d")
msg = f"*Weekly Agency Hub Status — cloudless.gr ({now})*\n\n" + "\n".join(sections)
slack(msg)
print("Slack alert sent.")
