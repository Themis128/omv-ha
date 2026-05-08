#!/usr/bin/env python3
"""cloudless-tasks orchestrator — fetches SSM creds, runs task script directly. No Anthropic needed."""
import sys, os, subprocess, boto3, datetime

TASK_ID = sys.argv[1] if len(sys.argv) > 1 else None
REGION = "us-east-1"
SNS_TOPIC = "arn:aws:sns:us-east-1:278585680617:cloudless-alerts"
SCRIPTS_DIR = "/usr/local/lib/cloudless-tasks/scripts"

SSM_KEYS = [
    "ANTHROPIC_API_KEY", "NOTION_API_KEY", "NOTION_SUBMISSIONS_DB_ID",
    "NOTION_GSC_REPORTS_DB_ID", "NOTION_TASKS_DB_ID",
    "SLACK_WEBHOOK_URL", "SLACK_BOT_TOKEN", "SLACK_DEFAULT_CHANNEL",
    "SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT",
    "STRIPE_SECRET_KEY", "GOOGLE_PRIVATE_KEY", "GOOGLE_CLIENT_EMAIL",
    "GSC_SITE_URL", "META_ACCESS_TOKEN", "LINKEDIN_ACCESS_TOKEN",
]

def get_creds():
    ssm = boto3.client("ssm", region_name=REGION)
    env = {}
    for k in SSM_KEYS:
        try:
            r = ssm.get_parameter(Name=f"/cloudless/production/{k}", WithDecryption=True)
            env[k] = r["Parameter"]["Value"]
        except Exception:
            pass
    return env

def fetch_script_from_ssm(task_id):
    """Self-bootstrap: fetch script from SSM if not on disk yet."""
    import base64
    ssm = boto3.client("ssm", region_name=REGION)
    r = ssm.get_parameter(Name=f"/cloudless/tasks/script-{task_id}")
    os.makedirs(SCRIPTS_DIR, exist_ok=True)
    script_path = f"{SCRIPTS_DIR}/{task_id}.py"
    with open(script_path, "wb") as f:
        f.write(base64.b64decode(r["Parameter"]["Value"]))
    os.chmod(script_path, 0o755)
    print(f"Fetched {task_id}.py from SSM")
    return script_path

def notify(msg):
    try:
        ts = datetime.datetime.utcnow().isoformat() + "+00:00"
        boto3.client("sns", region_name=REGION).publish(
            TopicArn=SNS_TOPIC,
            Subject=f"Task {TASK_ID} failed",
            Message=f"Task {TASK_ID} failed at {ts}\nError: {msg}"
        )
    except Exception:
        pass

if not TASK_ID:
    print("Usage: orchestrator.py <task-id>")
    sys.exit(1)

script = f"{SCRIPTS_DIR}/{TASK_ID}.py"

if not os.path.exists(script):
    try:
        script = fetch_script_from_ssm(TASK_ID)
    except Exception as e:
        notify(f"Script not found and SSM fetch failed: {e}")
        print(f"ERROR: Script not found and SSM fetch failed: {e}")
        sys.exit(1)

try:
    creds = get_creds()
    env = {**os.environ, **creds}
    print(f"[{datetime.datetime.utcnow().isoformat()}] Running task: {TASK_ID}")
    rc = subprocess.run([sys.executable, script], env=env).returncode
    if rc != 0:
        notify(f"Script exited with code {rc}")
    sys.exit(rc)
except Exception as e:
    notify(str(e))
    print(f"Orchestrator error: {e}")
    sys.exit(1)
