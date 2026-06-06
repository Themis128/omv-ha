#!/usr/bin/env python3
"""
cognito-users.py — List all Cognito users for cloudless.gr

Usage:
    AWS_PROFILE=admin COGNITO_POOL_ID=us-east-1_XXXX python3 cognito-users.py
    AWS_PROFILE=admin COGNITO_POOL_ID=us-east-1_XXXX python3 cognito-users.py --active
    AWS_PROFILE=admin COGNITO_POOL_ID=us-east-1_XXXX python3 cognito-users.py --json

Options:
    --active     Show only CONFIRMED + enabled users
    --json       Output raw JSON (pipe to jq for further filtering)
    --groups     Also fetch group membership per user (slower — one API call per user)
    --since N    Only show users created in the last N days (e.g. --since 7)
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta

try:
    import boto3
    from botocore.exceptions import ClientError, NoCredentialsError, ProfileNotFound
except ImportError:
    print("boto3 not installed. Run: pip3 install boto3")
    sys.exit(1)


REGION = os.environ.get("AWS_REGION", "us-east-1")
POOL_ID = os.environ.get("COGNITO_POOL_ID", "")
PROFILE = os.environ.get("AWS_PROFILE", "admin")

STATUS_ICON = {
    "CONFIRMED": "✅",
    "UNCONFIRMED": "📧",
    "FORCE_CHANGE_PASSWORD": "🔑",
    "RESET_REQUIRED": "🔄",
    "DISABLED": "🚫",
    "ARCHIVED": "📦",
    "UNKNOWN": "❓",
}


def get_client():
    if not POOL_ID:
        print("❌  COGNITO_POOL_ID environment variable is not set.")
        print("    Export it before running:")
        print("    export COGNITO_POOL_ID=us-east-1_XXXXXXXXX")
        sys.exit(1)
    try:
        session = boto3.Session(profile_name=PROFILE, region_name=REGION)
        client = session.client("cognito-idp")
        # Smoke-test credentials
        client.describe_user_pool(UserPoolId=POOL_ID)
        return client
    except ProfileNotFound:
        print(f"❌  AWS profile '{PROFILE}' not found.")
        print(f"    Available profiles: {boto3.Session().available_profiles}")
        sys.exit(1)
    except NoCredentialsError:
        print("❌  No AWS credentials found. Configure ~/.aws/credentials or set AWS_ACCESS_KEY_ID.")
        sys.exit(1)
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code == "ResourceNotFoundException":
            print(f"❌  User Pool '{POOL_ID}' not found in region {REGION}.")
        elif code == "AccessDeniedException":
            print(f"❌  Access denied. Profile '{PROFILE}' lacks cognito-idp:DescribeUserPool on this pool.")
        else:
            print(f"❌  AWS error: {e}")
        sys.exit(1)


def list_all_users(client, filter_str=None):
    """Paginate through all users in the pool."""
    users = []
    kwargs = {"UserPoolId": POOL_ID, "Limit": 60}
    if filter_str:
        kwargs["Filter"] = filter_str
    while True:
        resp = client.list_users(**kwargs)
        users.extend(resp["Users"])
        token = resp.get("PaginationToken")
        if not token:
            break
        kwargs["PaginationToken"] = token
    return users


def get_user_groups(client, username):
    groups = []
    kwargs = {"UserPoolId": POOL_ID, "Username": username}
    while True:
        resp = client.admin_list_groups_for_user(**kwargs)
        groups.extend(g["GroupName"] for g in resp.get("Groups", []))
        token = resp.get("NextToken")
        if not token:
            break
        kwargs["NextToken"] = token
    return groups


def attr(user, name):
    for a in user.get("Attributes", []):
        if a["Name"] == name:
            return a["Value"]
    return ""


def fmt_date(dt):
    if not dt:
        return ""
    if isinstance(dt, str):
        return dt[:10]
    return dt.strftime("%Y-%m-%d")


def print_table(users, show_groups=False):
    rows = []
    for u in users:
        email = attr(u, "email") or u["Username"]
        status = u.get("UserStatus", "UNKNOWN")
        enabled = "✅" if u.get("Enabled", True) else "❌"
        created = fmt_date(u.get("UserCreateDate"))
        groups = ", ".join(u.get("_groups", [])) or "—"
        rows.append((
            STATUS_ICON.get(status, "❓"),
            email,
            status,
            enabled,
            created,
            groups,
        ))

    # Column widths
    col_email = max(len(r[1]) for r in rows) if rows else 30
    col_status = max(len(r[2]) for r in rows) if rows else 20
    col_date = 10

    header = (
        f"  {'Email':<{col_email}}  {'Status':<{col_status}}  {'On':<3}  {'Created':<{col_date}}"
    )
    if show_groups:
        header += "  Groups"
    print(header)
    print("  " + "─" * (col_email + col_status + col_date + 15))

    for icon, email, status, enabled, created, groups in rows:
        line = f"{icon} {email:<{col_email}}  {status:<{col_status}}  {enabled}   {created:<{col_date}}"
        if show_groups:
            line += f"  {groups}"
        print(line)


def print_summary(all_users, active_users):
    from collections import Counter
    status_counts = Counter(u.get("UserStatus", "UNKNOWN") for u in all_users)
    enabled_count = sum(1 for u in all_users if u.get("Enabled", True))

    print("\n── Summary ─────────────────────────────")
    print(f"  Total users:   {len(all_users)}")
    print(f"  Enabled:       {enabled_count}")
    print(f"  Active (CONFIRMED + enabled): {len(active_users)}")
    print()
    print("  By status:")
    for status, count in sorted(status_counts.items(), key=lambda x: -x[1]):
        icon = STATUS_ICON.get(status, "❓")
        print(f"    {icon}  {status:<30} {count}")
    print("─" * 42)


def main():
    parser = argparse.ArgumentParser(description="List Cognito users for cloudless.gr")
    parser.add_argument("--active", action="store_true", help="Show only active (CONFIRMED + enabled) users")
    parser.add_argument("--json", action="store_true", dest="json_out", help="Output raw JSON")
    parser.add_argument("--groups", action="store_true", help="Fetch group membership (slower)")
    parser.add_argument("--since", type=int, metavar="DAYS", help="Only show users created in the last N days")
    args = parser.parse_args()

    client = get_client()

    print(f"\n🔍  Querying pool: {POOL_ID}  ({REGION})\n")

    all_users = list_all_users(client)

    # Apply --since filter
    if args.since:
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.since)
        all_users = [u for u in all_users if u.get("UserCreateDate", datetime.min.replace(tzinfo=timezone.utc)) >= cutoff]

    # Fetch groups if requested
    if args.groups:
        print(f"  Fetching group membership for {len(all_users)} users…")
        for u in all_users:
            u["_groups"] = get_user_groups(client, u["Username"])
    else:
        for u in all_users:
            u["_groups"] = []

    active_users = [
        u for u in all_users
        if u.get("UserStatus") == "CONFIRMED" and u.get("Enabled", True)
    ]

    if args.json_out:
        output = []
        for u in (active_users if args.active else all_users):
            output.append({
                "username": u["Username"],
                "email": attr(u, "email"),
                "email_verified": attr(u, "email_verified"),
                "status": u.get("UserStatus"),
                "enabled": u.get("Enabled", True),
                "created": fmt_date(u.get("UserCreateDate")),
                "groups": u.get("_groups", []),
            })
        print(json.dumps(output, indent=2))
        return

    if args.active:
        print(f"── Active users ({len(active_users)}) ─────────────────────────────────")
        if active_users:
            print_table(active_users, show_groups=args.groups)
        else:
            print("  No active users found.")
    else:
        print(f"── All users ({len(all_users)}) ────────────────────────────────────────")
        if all_users:
            print_table(all_users, show_groups=args.groups)
        else:
            print("  No users found.")
        print()
        print(f"── Active users ({len(active_users)}) ─────────────────────────────────")
        if active_users:
            print_table(active_users, show_groups=args.groups)
        else:
            print("  No active users found.")

    print_summary(all_users, active_users)


if __name__ == "__main__":
    main()
