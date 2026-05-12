"""
feature_engineer.py — ML Feature Engineering Pipeline
Schedule: every Sunday 01:00 UTC

Reads from DuckDB analytics tables, computes ML features,
writes Parquet files to S3, and registers DuckDB views.

If real tables don't exist yet, creates synthetic data for pipeline testing.
"""

import os
import sys
import logging
from datetime import datetime, timezone, timedelta

import pandas as pd
import numpy as np

from common import (
    duckdb_query, duckdb_table_exists, duckdb_tables,
    ensure_ml_schema, log_ml_feature, upload_scores,
    parquet_s3_uri, log,
)

log = logging.getLogger("feature-engineer")


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_synthetic_users(n: int = 500) -> pd.DataFrame:
    """Generate synthetic user data for pipeline testing when no real tables exist."""
    np.random.seed(42)
    now = datetime.now(timezone.utc)
    users = []
    for i in range(n):
        signup = now - timedelta(days=int(np.random.exponential(180)))
        last_order = signup + timedelta(days=int(np.random.exponential(60)))
        if last_order > now:
            last_order = now - timedelta(days=np.random.randint(0, 30))
        users.append({
            "user_id": f"u_{i:05d}",
            "signup_date": signup.date(),
            "last_order_date": last_order.date(),
            "total_orders": max(1, int(np.random.exponential(5))),
            "total_revenue": round(abs(np.random.normal(150, 80)), 2),
            "plan_tier": np.random.choice(["free", "starter", "pro", "enterprise"],
                                          p=[0.4, 0.3, 0.2, 0.1]),
            "payment_failures": np.random.randint(0, 3),
            "support_tickets": np.random.randint(0, 5),
        })
    return pd.DataFrame(users)


def make_synthetic_events(users_df: pd.DataFrame) -> pd.DataFrame:
    """Generate synthetic session events for collaborative filtering."""
    np.random.seed(123)
    items = [f"page_{i}" for i in range(50)]
    events = []
    for _, u in users_df.iterrows():
        n_sessions = max(1, int(np.random.exponential(3)))
        for _ in range(n_sessions):
            session_items = np.random.choice(items, size=np.random.randint(1, 6),
                                             replace=False)
            session_id = f"s_{np.random.randint(0, 999999):06d}"
            for item in session_items:
                events.append({
                    "user_id": u["user_id"],
                    "session_id": session_id,
                    "item_id": item,
                    "event_type": np.random.choice(["view", "click", "purchase"],
                                                    p=[0.7, 0.2, 0.1]),
                    "ts": datetime.now(timezone.utc) - timedelta(
                        days=np.random.randint(0, 90),
                        hours=np.random.randint(0, 24),
                    ),
                })
    return pd.DataFrame(events)


def make_synthetic_requests() -> pd.DataFrame:
    """Generate synthetic request log data for anomaly detection."""
    np.random.seed(456)
    now = datetime.now(timezone.utc)
    records = []
    endpoints = ["/api/health", "/api/users", "/api/reports", "/api/export",
                 "/api/events", "/", "/login", "/dashboard"]
    for i in range(2000):
        ts = now - timedelta(minutes=i * 0.5)
        endpoint = np.random.choice(endpoints)
        # Inject a few anomalies
        is_anomaly_window = 500 < i < 520
        records.append({
            "ts": ts,
            "endpoint": endpoint,
            "status_code": 500 if (is_anomaly_window and np.random.random() < 0.4) else
                           np.random.choice([200, 200, 200, 301, 404, 500],
                                            p=[0.85, 0.05, 0.03, 0.03, 0.02, 0.02]),
            "response_ms": int(abs(np.random.normal(80, 30))) + (
                500 if is_anomaly_window else 0
            ),
        })
    return pd.DataFrame(records)


# ── Feature computation ───────────────────────────────────────────────────────

def compute_rfm_features(users_df: pd.DataFrame) -> pd.DataFrame:
    """Compute RFM (Recency, Frequency, Monetary) features per user."""
    today = datetime.now(timezone.utc).date()

    df = users_df.copy()
    df["last_order_date"] = pd.to_datetime(df["last_order_date"]).dt.date
    df["signup_date"] = pd.to_datetime(df["signup_date"]).dt.date

    df["recency_days"] = df["last_order_date"].apply(
        lambda d: (today - d).days if pd.notna(d) else 999
    )
    df["frequency"] = df["total_orders"].clip(upper=100)
    df["monetary"] = df["total_revenue"].clip(upper=10000)
    df["days_since_signup"] = df["signup_date"].apply(
        lambda d: (today - d).days if pd.notna(d) else 0
    )
    df["computed_at"] = datetime.now(timezone.utc).isoformat()

    return df[[
        "user_id", "recency_days", "frequency", "monetary",
        "days_since_signup", "plan_tier", "payment_failures",
        "support_tickets", "computed_at",
    ]]


def compute_churn_features(users_df: pd.DataFrame) -> pd.DataFrame:
    """Compute churn prediction features with binary label."""
    today = datetime.now(timezone.utc).date()

    df = users_df.copy()
    df["last_order_date"] = pd.to_datetime(df["last_order_date"]).dt.date
    df["signup_date"] = pd.to_datetime(df["signup_date"]).dt.date

    df["recency_days"] = df["last_order_date"].apply(
        lambda d: (today - d).days if pd.notna(d) else 999
    )
    df["frequency"] = df["total_orders"].clip(upper=100)
    df["monetary"] = df["total_revenue"].clip(upper=10000)
    df["days_since_signup"] = df["signup_date"].apply(
        lambda d: (today - d).days if pd.notna(d) else 0
    )

    df["is_churned"] = (
        (df["recency_days"] > 30) & (df["plan_tier"] != "free")
    ).astype(int)

    df["plan_tier_enc"] = df["plan_tier"].map(
        {"free": 0, "starter": 1, "pro": 2, "enterprise": 3}
    ).fillna(0)

    df["computed_at"] = datetime.now(timezone.utc).isoformat()

    return df[[
        "user_id", "recency_days", "frequency", "monetary",
        "days_since_signup", "plan_tier_enc", "payment_failures",
        "support_tickets", "is_churned", "computed_at",
    ]]


def compute_collab_features(events_df: pd.DataFrame) -> pd.DataFrame:
    """Compute session co-occurrence triplets for collaborative filtering."""
    # Weight events by type
    weight_map = {"view": 1.0, "click": 2.0, "purchase": 5.0}
    events_df["weight"] = events_df["event_type"].map(weight_map).fillna(1.0)

    # Aggregate to user-item interaction matrix (long format)
    collab = (
        events_df.groupby(["user_id", "item_id"])["weight"]
        .sum()
        .reset_index()
        .rename(columns={"weight": "interaction_score"})
    )
    collab["computed_at"] = datetime.now(timezone.utc).isoformat()
    return collab


def compute_request_features(requests_df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate request logs to 15-min windows for anomaly detection."""
    df = requests_df.copy()
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df["window"] = df["ts"].dt.floor("15min")

    agg = df.groupby(["window", "endpoint"]).agg(
        request_count=("status_code", "count"),
        error_count=("status_code", lambda x: (x >= 500).sum()),
        p50_ms=("response_ms", lambda x: x.quantile(0.50)),
        p95_ms=("response_ms", lambda x: x.quantile(0.95)),
    ).reset_index()

    agg["error_rate"] = agg["error_count"] / agg["request_count"].clip(lower=1)
    agg["window"] = agg["window"].astype(str)
    agg["computed_at"] = datetime.now(timezone.utc).isoformat()
    return agg


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    log.info("=== Feature Engineer starting ===")

    # Ensure ML schema tables exist
    ensure_ml_schema()

    available = duckdb_tables()
    log.info(f"Available DuckDB tables: {available}")

    # ── Load or synthesize user data ─────────────────────────────────────────
    if "users" in available:
        log.info("Loading users from DuckDB...")
        rows = duckdb_query("SELECT * FROM users LIMIT 100000")
        users_df = pd.DataFrame(rows)
        # Normalise expected columns if they exist under different names
        if "user_id" not in users_df.columns and "id" in users_df.columns:
            users_df = users_df.rename(columns={"id": "user_id"})
        for col, default in [
            ("total_orders", 1), ("total_revenue", 0.0),
            ("plan_tier", "free"), ("payment_failures", 0),
            ("support_tickets", 0), ("signup_date", None),
            ("last_order_date", None),
        ]:
            if col not in users_df.columns:
                users_df[col] = default
    else:
        log.info("No 'users' table found — generating synthetic data for testing")
        users_df = make_synthetic_users(500)

    log.info(f"Users loaded: {len(users_df)} rows")

    # ── Load or synthesize event data ────────────────────────────────────────
    if "events" in available or "page_views" in available:
        tbl = "events" if "events" in available else "page_views"
        log.info(f"Loading events from DuckDB table: {tbl}")
        rows = duckdb_query(f"SELECT * FROM {tbl} LIMIT 500000")
        events_df = pd.DataFrame(rows)
        for col, default in [("session_id", None), ("item_id", None), ("event_type", "view")]:
            if col not in events_df.columns:
                if col == "item_id" and "page_path" in events_df.columns:
                    events_df["item_id"] = events_df["page_path"]
                elif col == "item_id" and "url" in events_df.columns:
                    events_df["item_id"] = events_df["url"]
                else:
                    events_df[col] = default
        if "session_id" not in events_df.columns or events_df["session_id"].isna().all():
            events_df["session_id"] = events_df.get("user_id", "unknown")
    else:
        log.info("No events table — generating synthetic events")
        events_df = make_synthetic_events(users_df)

    log.info(f"Events loaded: {len(events_df)} rows")

    # ── Load or synthesize request log data ──────────────────────────────────
    if "request_logs" in available or "access_logs" in available:
        tbl = "request_logs" if "request_logs" in available else "access_logs"
        rows = duckdb_query(
            f"SELECT ts, endpoint, status_code, response_ms FROM {tbl} "
            f"WHERE ts >= NOW() - INTERVAL 30 DAY LIMIT 200000"
        )
        requests_df = pd.DataFrame(rows)
        for col, default in [("endpoint", "/"), ("status_code", 200), ("response_ms", 50)]:
            if col not in requests_df.columns:
                requests_df[col] = default
    else:
        log.info("No request_logs table — generating synthetic request data")
        requests_df = make_synthetic_requests()

    # ── Compute and upload features ──────────────────────────────────────────
    features = [
        ("features_rfm", compute_rfm_features(users_df)),
        ("features_churn", compute_churn_features(users_df)),
        ("features_collab", compute_collab_features(events_df)),
        ("features_requests", compute_request_features(requests_df)),
    ]

    for name, df in features:
        log.info(f"Uploading {name}: {len(df)} rows")
        uri = upload_scores(df, name)
        log_ml_feature(name, len(df), uri)
        log.info(f"  ✓ {name} → {uri}")

    log.info("=== Feature Engineer complete ===")


if __name__ == "__main__":
    main()
