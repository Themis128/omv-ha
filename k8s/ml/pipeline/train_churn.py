"""
train_churn.py — Churn Prediction Model
Schedule: every Sunday 04:00 UTC (after rfm at 03:00)

Reads features_churn from DuckDB, trains LightGBM binary classifier,
writes scores_churn.parquet to S3, registers DuckDB view.

Falls back to scikit-learn LogisticRegression if LightGBM fails.
"""

import logging
import joblib
import numpy as np
import pandas as pd
from datetime import datetime, timezone
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import cross_val_score
from sklearn.metrics import roc_auc_score, f1_score, precision_score, recall_score

from common import (
    duckdb_query, duckdb_table_exists, ensure_ml_schema,
    upload_scores, s3_upload, log_ml_run, model_s3_key, log,
)

log = logging.getLogger("train-churn")

MODEL_NAME = "churn"
FEATURE_COLS = [
    "recency_days", "frequency", "monetary",
    "days_since_signup", "plan_tier_enc",
    "payment_failures", "support_tickets",
]
LABEL_COL = "is_churned"
CHURN_THRESHOLD = 0.5


def build_lgbm_model():
    """Try to import LightGBM — returns None if unavailable."""
    try:
        import lightgbm as lgb
        return lgb.LGBMClassifier(
            n_estimators=100,
            num_leaves=15,
            learning_rate=0.05,
            min_child_samples=5,
            random_state=42,
            verbose=-1,
        )
    except ImportError:
        log.warning("LightGBM not available — falling back to LogisticRegression")
        return None


def build_lr_model():
    return LogisticRegression(max_iter=500, random_state=42, C=1.0)


def main():
    log.info("=== Churn Training starting ===")
    ensure_ml_schema()

    if not duckdb_table_exists("features_churn"):
        log.error("features_churn view not found. Run feature_engineer first.")
        raise SystemExit(1)

    rows = duckdb_query("SELECT * FROM features_churn LIMIT 200000")
    df = pd.DataFrame(rows)
    log.info(f"Loaded {len(df)} rows from features_churn")

    for col in FEATURE_COLS:
        if col not in df.columns:
            df[col] = 0.0
    if LABEL_COL not in df.columns:
        df[LABEL_COL] = 0

    X = df[FEATURE_COLS].fillna(0).values.astype(float)
    y = df[LABEL_COL].fillna(0).values.astype(int)

    n_pos = int(y.sum())
    n_neg = int((y == 0).sum())
    log.info(f"Class distribution: churned={n_pos} ({100*n_pos/max(1,len(y)):.1f}%), "
             f"retained={n_neg}")

    if len(df) < 20 or n_pos < 5:
        log.warning(f"Insufficient positive samples ({n_pos}). "
                    f"Proceeding with all available data.")

    # Choose classifier
    lgbm = build_lgbm_model()
    if lgbm is not None:
        log.info("Using LightGBM classifier")
        model = lgbm
        pipeline = Pipeline([("classifier", model)])
    else:
        log.info("Using LogisticRegression classifier")
        pipeline = Pipeline([
            ("scaler", StandardScaler()),
            ("classifier", build_lr_model()),
        ])

    # Cross-validation (skip if too few samples)
    cv_auc = None
    n_splits = min(5, max(2, n_pos))
    if len(df) >= 20 and n_pos >= n_splits:
        try:
            cv_scores = cross_val_score(pipeline, X, y, cv=n_splits, scoring="roc_auc")
            cv_auc = float(np.mean(cv_scores))
            log.info(f"CV AUC: {cv_auc:.4f} (±{np.std(cv_scores):.4f})")
        except Exception as e:
            log.warning(f"CV failed: {e}")

    # Final training on full dataset
    pipeline.fit(X, y)
    probs = pipeline.predict_proba(X)[:, 1]
    preds = (probs >= CHURN_THRESHOLD).astype(int)

    # Metrics on training set (for tracking; not validation)
    auc = float(roc_auc_score(y, probs)) if n_pos > 0 and n_neg > 0 else 0.0
    f1 = float(f1_score(y, preds, zero_division=0))
    precision = float(precision_score(y, preds, zero_division=0))
    recall = float(recall_score(y, preds, zero_division=0))
    log.info(f"Train metrics — AUC: {auc:.4f}  F1: {f1:.4f}  "
             f"Precision: {precision:.4f}  Recall: {recall:.4f}")

    # Build output scores
    df["churn_prob"] = probs
    df["churn_label"] = pd.cut(
        probs,
        bins=[-1, 0.3, 0.6, 1.01],
        labels=["low", "medium", "high"],
    ).astype(str)
    df["scored_at"] = datetime.now(timezone.utc).isoformat()

    scores_df = df[["user_id", "churn_prob", "churn_label", "scored_at"]]
    high_risk = int((df["churn_label"] == "high").sum())
    log.info(f"High-risk users: {high_risk} ({100*high_risk/max(1,len(df)):.1f}%)")

    upload_scores(scores_df, "scores_churn")

    # Save model
    model_path = "/tmp/churn_model.pkl"
    joblib.dump(pipeline, model_path)
    s3_key = model_s3_key(MODEL_NAME, "latest")
    s3_uri = s3_upload(model_path, s3_key)
    s3_upload(model_path, model_s3_key(MODEL_NAME, datetime.now(timezone.utc).strftime("%Y-%m-%d")))

    metrics = {
        "auc": round(auc, 4),
        "f1": round(f1, 4),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "cv_auc": round(cv_auc, 4) if cv_auc else None,
        "churn_rate": round(n_pos / max(1, len(y)), 4),
        "high_risk_count": high_risk,
        "classifier": type(pipeline[-1]).__name__,
    }
    log_ml_run(MODEL_NAME, metrics, s3_uri, len(df))
    log.info(f"=== Churn Training complete ===")


if __name__ == "__main__":
    main()
