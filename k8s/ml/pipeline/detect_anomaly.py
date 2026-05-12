"""
detect_anomaly.py — Real-time Anomaly Scoring
Schedule: every 15 minutes (*/15 * * * *)

Downloads the latest IsolationForest model from S3 (cached locally),
scores the last 15-min request window from DuckDB,
writes anomaly_flags.parquet to S3 and registers DuckDB view.

This job is SCORE ONLY — no training. See train_anomaly.py for training.
"""

import os
import logging
import joblib
import numpy as np
import pandas as pd
from datetime import datetime, timezone, timedelta

from common import (
    duckdb_query, duckdb_table_exists, duckdb_load_parquet,
    s3_download, s3_key_exists, s3_upload,
    model_s3_key, parquet_s3_key, parquet_s3_uri,
    write_parquet, log,
)

log = logging.getLogger("detect-anomaly")

MODEL_NAME = "anomaly"
MODEL_CACHE = "/tmp/anomaly_model_cache.pkl"
ANOMALY_PARQUET = "anomaly_flags"
ALERT_WEBHOOK = os.getenv("ANOMALY_ALERT_WEBHOOK", "")  # optional ntfy/slack URL


def load_model():
    """Load anomaly model from local cache or S3."""
    s3_key = model_s3_key(MODEL_NAME, "latest")

    # Re-download if cache is older than 2 hours or missing
    cache_stale = True
    if os.path.exists(MODEL_CACHE):
        age_seconds = (datetime.now(timezone.utc).timestamp()
                       - os.path.getmtime(MODEL_CACHE))
        cache_stale = age_seconds > 7200  # 2 hours

    if cache_stale:
        if s3_key_exists(s3_key):
            log.info("Downloading fresh anomaly model from S3...")
            s3_download(s3_key, MODEL_CACHE)
        else:
            log.warning("No anomaly model in S3 yet. Skipping scoring.")
            return None

    return joblib.load(MODEL_CACHE)


def get_recent_windows() -> pd.DataFrame:
    """Get request aggregates for the last 15-minute window."""
    if duckdb_table_exists("features_requests"):
        # Fetch last 4 windows (1 hour) for context
        rows = duckdb_query(
            "SELECT * FROM features_requests "
            "ORDER BY window DESC LIMIT 400"  # up to 400 endpoint×window combos
        )
        df = pd.DataFrame(rows)
    else:
        # No data yet — return empty
        log.info("features_requests not available — no data to score")
        return pd.DataFrame()

    if df.empty:
        return df

    df["window"] = pd.to_datetime(df["window"], utc=True)
    # Focus on latest window
    latest = df["window"].max()
    df = df[df["window"] >= latest - timedelta(minutes=15)]
    return df


def send_alert(anomalies: pd.DataFrame) -> None:
    """POST to ntfy or Slack webhook if anomalies detected."""
    if not ANOMALY_ALERT_WEBHOOK or anomalies.empty:
        return
    try:
        import requests
        msg = (f"⚠️ Anomaly detected at {datetime.now(timezone.utc).strftime('%H:%M UTC')}\n"
               f"Endpoints: {anomalies['endpoint'].tolist()}\n"
               f"Windows: {anomalies['window'].astype(str).tolist()}")
        requests.post(ANOMALY_ALERT_WEBHOOK, data=msg.encode("utf-8"), timeout=5)
        log.info(f"Alert sent to webhook: {len(anomalies)} anomalies")
    except Exception as e:
        log.warning(f"Alert webhook failed: {e}")


def main():
    log.info("=== Anomaly Detection scoring run ===")

    model_data = load_model()
    if model_data is None:
        log.info("No model available. Exiting cleanly.")
        return

    pipeline = model_data["pipeline"]
    threshold = model_data["threshold"]
    feature_cols = model_data["feature_cols"]

    df = get_recent_windows()
    if df.empty:
        log.info("No recent request data to score.")
        return

    log.info(f"Scoring {len(df)} endpoint-window combinations...")

    # Ensure all feature cols exist
    for col in feature_cols:
        if col not in df.columns:
            df[col] = 0.0
    # Derived feature
    if "latency_ratio" not in df.columns:
        if "p95_ms" in df.columns and "p50_ms" in df.columns:
            df["latency_ratio"] = df["p95_ms"] / (df["p50_ms"].clip(lower=1))
        else:
            df["latency_ratio"] = 1.0

    X = df[feature_cols].fillna(0).values.astype(float)
    scores = pipeline.named_steps["model"].score_samples(
        pipeline.named_steps["scaler"].transform(X)
    )

    df["anomaly_score"] = scores
    df["is_anomaly"] = scores < threshold
    df["flagged_at"] = datetime.now(timezone.utc).isoformat()

    n_flagged = int(df["is_anomaly"].sum())
    log.info(f"Flagged: {n_flagged} anomalies out of {len(df)} windows "
             f"(threshold={threshold:.4f})")

    # Output all windows (not just anomalies) for Metabase history
    output_cols = ["window", "endpoint", "request_count", "error_rate",
                   "p95_ms", "anomaly_score", "is_anomaly", "flagged_at"]
    output_cols = [c for c in output_cols if c in df.columns]
    output_df = df[output_cols].copy()
    output_df["window"] = output_df["window"].astype(str)

    # Write to local parquet + upload to S3
    local_path = f"/tmp/{ANOMALY_PARQUET}.parquet"
    write_parquet(output_df, local_path)
    s3_key = parquet_s3_key(ANOMALY_PARQUET)
    s3_upload(local_path, s3_key)
    duckdb_load_parquet(parquet_s3_uri(ANOMALY_PARQUET), ANOMALY_PARQUET)

    # Alert on anomalies
    if n_flagged > 0:
        anomalies = df[df["is_anomaly"]]
        log.warning(f"ANOMALY: {anomalies[['window', 'endpoint', 'anomaly_score']].to_dict('records')}")
        send_alert(anomalies)

    log.info("=== Anomaly scoring complete ===")


if __name__ == "__main__":
    main()
