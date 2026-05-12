"""
train_rfm.py — RFM Segmentation Model
Schedule: every Sunday 03:00 UTC (after feature_engineer at 01:00)

Reads features_rfm from DuckDB, trains KMeans (k=5) on normalized RFM features,
assigns segments, writes scores_rfm.parquet to S3, registers DuckDB view.
"""

import os
import logging
import joblib
import numpy as np
import pandas as pd
from datetime import datetime, timezone
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

from common import (
    duckdb_query, duckdb_table_exists, ensure_ml_schema,
    upload_scores, s3_upload, log_ml_run, model_s3_key,
    parquet_s3_uri, log,
)

log = logging.getLogger("train-rfm")

MODEL_NAME = "rfm"
N_CLUSTERS = 5
SEGMENT_LABELS = {0: "hibernating", 1: "at_risk", 2: "loyal", 3: "champions", 4: "new"}


def label_segment(cluster_id: int, cluster_centers: np.ndarray) -> str:
    """Assign human-readable labels based on cluster center values.

    Centers shape: (n_clusters, n_features) where features are:
    [recency_days_scaled, frequency_scaled, monetary_scaled]
    Lower recency = better, higher frequency/monetary = better.
    """
    centers = cluster_centers
    # Score each cluster: lower recency is good, higher freq/monetary is good
    scores = -centers[:, 0] + centers[:, 1] + centers[:, 2]
    ranking = np.argsort(np.argsort(scores))  # 0=worst, n-1=best
    labels = {
        0: "hibernating",
        1: "at_risk",
        2: "promising",
        3: "loyal",
        4: "champions",
    }
    return labels.get(int(ranking[cluster_id]), f"segment_{cluster_id}")


def main():
    log.info("=== RFM Training starting ===")
    ensure_ml_schema()

    # Load features
    if not duckdb_table_exists("features_rfm"):
        log.error("features_rfm view not found. Run feature_engineer first.")
        raise SystemExit(1)

    rows = duckdb_query("SELECT * FROM features_rfm LIMIT 200000")
    df = pd.DataFrame(rows)
    log.info(f"Loaded {len(df)} rows from features_rfm")

    if len(df) < 10:
        log.warning("Too few rows for meaningful clustering. Using all available data.")

    # Prepare features
    feature_cols = ["recency_days", "frequency", "monetary"]
    for col in feature_cols:
        if col not in df.columns:
            df[col] = 0.0
    X = df[feature_cols].fillna(0).values.astype(float)

    # Build and train pipeline
    n_clusters = min(N_CLUSTERS, max(2, len(df) // 5))
    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("kmeans", KMeans(n_clusters=n_clusters, n_init=10, random_state=42, max_iter=300)),
    ])

    log.info(f"Fitting KMeans (k={n_clusters}) on {len(X)} users...")
    pipeline.fit(X)

    cluster_ids = pipeline.predict(X)
    centers_scaled = pipeline.named_steps["kmeans"].cluster_centers_

    # Build output scores
    df["cluster_id"] = cluster_ids
    df["segment"] = [label_segment(c, centers_scaled) for c in cluster_ids]

    # RFM score: rank-based quintile (1–5) — robust to duplicate values
    scaler = pipeline.named_steps["scaler"]
    X_scaled = scaler.transform(X)

    def quintile(arr, invert=False):
        s = pd.Series(-arr if invert else arr)
        return np.ceil(s.rank(pct=True, method="average") * 5).clip(1, 5)

    df["r_score"] = quintile(X_scaled[:, 0], invert=True)  # lower recency = better
    df["f_score"] = quintile(X_scaled[:, 1])
    df["m_score"] = quintile(X_scaled[:, 2])
    df["rfm_score"] = df["r_score"] + df["f_score"] + df["m_score"]

    df["scored_at"] = datetime.now(timezone.utc).isoformat()

    scores_df = df[[
        "user_id", "segment", "rfm_score", "r_score", "f_score", "m_score",
        "recency_days", "frequency", "monetary", "scored_at",
    ]]

    # Segment distribution
    seg_dist = scores_df["segment"].value_counts().to_dict()
    log.info(f"Segment distribution: {seg_dist}")

    # Upload scores
    log.info("Uploading scores_rfm...")
    upload_scores(scores_df, "scores_rfm")

    # Save and upload model
    model_path = "/tmp/rfm_model.pkl"
    joblib.dump(pipeline, model_path)
    s3_key = model_s3_key(MODEL_NAME, "latest")
    s3_uri = s3_upload(model_path, s3_key)

    # Also save versioned backup
    date_key = model_s3_key(MODEL_NAME, datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    s3_upload(model_path, date_key)

    # Metrics
    inertia = float(pipeline.named_steps["kmeans"].inertia_)
    metrics = {
        "inertia": round(inertia, 2),
        "n_clusters": n_clusters,
        "training_rows": len(df),
        "segment_distribution": seg_dist,
    }

    log_ml_run(MODEL_NAME, metrics, s3_uri, len(df))
    log.info(f"=== RFM Training complete — {len(df)} users segmented ===")


if __name__ == "__main__":
    main()
