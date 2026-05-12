"""
train_anomaly.py — Anomaly Detection Model Training
Schedule: every Sunday 05:00 UTC

Reads features_requests (15-min window aggregates) from DuckDB,
trains IsolationForest on last 30 days, saves model to S3.
The scoring job (detect_anomaly.py) runs every 15 minutes using this model.
"""

import logging
import joblib
import numpy as np
import pandas as pd
from datetime import datetime, timezone
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

from common import (
    duckdb_query, duckdb_table_exists, ensure_ml_schema,
    s3_upload, log_ml_run, model_s3_key, log,
)

log = logging.getLogger("train-anomaly")

MODEL_NAME = "anomaly"
CONTAMINATION = 0.05   # expected fraction of anomalies in training data
FEATURE_COLS = ["request_count", "error_rate", "p95_ms"]


def main():
    log.info("=== Anomaly Model Training starting ===")
    ensure_ml_schema()

    if not duckdb_table_exists("features_requests"):
        log.error("features_requests view not found. Run feature_engineer first.")
        raise SystemExit(1)

    rows = duckdb_query("SELECT * FROM features_requests LIMIT 200000")
    df = pd.DataFrame(rows)
    log.info(f"Loaded {len(df)} request windows from features_requests")

    for col in FEATURE_COLS:
        if col not in df.columns:
            df[col] = 0.0
    df[FEATURE_COLS] = df[FEATURE_COLS].fillna(0)

    # Add derived features
    if "p50_ms" in df.columns:
        df["latency_ratio"] = df["p95_ms"] / (df["p50_ms"].clip(lower=1))
    else:
        df["latency_ratio"] = 1.0

    feature_cols_used = FEATURE_COLS + ["latency_ratio"]
    X = df[feature_cols_used].values.astype(float)

    log.info(f"Training IsolationForest on {len(X)} windows "
             f"(contamination={CONTAMINATION})...")

    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("model", IsolationForest(
            n_estimators=100,
            contamination=CONTAMINATION,
            random_state=42,
            n_jobs=2,
        )),
    ])
    pipeline.fit(X)

    # Quick self-eval: fraction flagged as anomaly
    preds = pipeline.predict(X)
    n_anomalies = int((preds == -1).sum())
    anomaly_rate = n_anomalies / max(1, len(X))
    log.info(f"Training anomaly rate: {anomaly_rate:.3f} ({n_anomalies}/{len(X)} windows)")

    # Feature importance proxy: mean absolute score contribution per feature
    scores = pipeline.named_steps["model"].score_samples(
        pipeline.named_steps["scaler"].transform(X)
    )
    log.info(f"Anomaly score stats: min={scores.min():.3f} mean={scores.mean():.3f} "
             f"max={scores.max():.3f}")

    # Determine threshold at contamination percentile
    threshold = float(np.percentile(scores, CONTAMINATION * 100))
    log.info(f"Anomaly score threshold (p{int(CONTAMINATION*100)}): {threshold:.4f}")

    model_data = {
        "pipeline": pipeline,
        "threshold": threshold,
        "feature_cols": feature_cols_used,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_training_windows": len(X),
    }

    model_path = "/tmp/anomaly_model.pkl"
    joblib.dump(model_data, model_path)
    s3_key = model_s3_key(MODEL_NAME, "latest")
    s3_uri = s3_upload(model_path, s3_key)
    s3_upload(model_path, model_s3_key(MODEL_NAME, datetime.now(timezone.utc).strftime("%Y-%m-%d")))

    metrics = {
        "n_training_windows": len(X),
        "anomaly_rate": round(anomaly_rate, 4),
        "n_anomalies_flagged": n_anomalies,
        "score_threshold": round(threshold, 4),
        "contamination": CONTAMINATION,
        "feature_cols": feature_cols_used,
    }
    log_ml_run(MODEL_NAME, metrics, s3_uri, len(X))
    log.info("=== Anomaly Training complete ===")


if __name__ == "__main__":
    main()
