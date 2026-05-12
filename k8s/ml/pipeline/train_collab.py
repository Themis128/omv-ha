"""
train_collab.py — Collaborative Filtering Recommendation Model
Schedule: every night 02:00 UTC

Reads features_collab from DuckDB, builds user-item matrix,
trains TruncatedSVD, writes top-N recommendations per user to scores_recs.parquet.
"""

import logging
import joblib
import json
import numpy as np
import pandas as pd
import scipy.sparse as sp
from datetime import datetime, timezone
from sklearn.decomposition import TruncatedSVD
from sklearn.preprocessing import normalize

from common import (
    duckdb_query, duckdb_table_exists, ensure_ml_schema,
    upload_scores, s3_upload, log_ml_run, model_s3_key, log,
)

log = logging.getLogger("train-collab")

MODEL_NAME = "collab"
N_COMPONENTS = 30   # SVD latent dimensions
TOP_N = 10          # recommendations per user


def build_sparse_matrix(df: pd.DataFrame):
    """Convert user-item interaction long-format to sparse CSR matrix."""
    users = df["user_id"].unique()
    items = df["item_id"].unique()

    user_idx = {u: i for i, u in enumerate(users)}
    item_idx = {it: i for i, it in enumerate(items)}

    row = df["user_id"].map(user_idx).values
    col = df["item_id"].map(item_idx).values
    data = df["interaction_score"].fillna(1.0).values.astype(float)

    matrix = sp.csr_matrix((data, (row, col)), shape=(len(users), len(items)))
    return matrix, user_idx, item_idx, users, items


def main():
    log.info("=== Collab Filtering Training starting ===")
    ensure_ml_schema()

    if not duckdb_table_exists("features_collab"):
        log.error("features_collab view not found. Run feature_engineer first.")
        raise SystemExit(1)

    rows = duckdb_query("SELECT * FROM features_collab LIMIT 500000")
    df = pd.DataFrame(rows)
    log.info(f"Loaded {len(df)} user-item interactions")

    if "interaction_score" not in df.columns:
        df["interaction_score"] = 1.0

    n_users = df["user_id"].nunique()
    n_items = df["item_id"].nunique()
    log.info(f"Unique users: {n_users}, unique items: {n_items}")

    if n_users < 5 or n_items < 3:
        log.warning("Too few users/items for meaningful recommendations. Proceeding anyway.")

    # Build sparse matrix
    matrix, user_idx, item_idx, users, items = build_sparse_matrix(df)
    log.info(f"Sparse matrix shape: {matrix.shape}, density: {matrix.nnz / max(1, matrix.shape[0] * matrix.shape[1]):.4f}")

    # Fit TruncatedSVD
    n_components = min(N_COMPONENTS, min(matrix.shape) - 1, max(2, n_items - 1))
    log.info(f"Fitting TruncatedSVD (n_components={n_components})...")
    svd = TruncatedSVD(n_components=n_components, random_state=42, n_iter=7)
    user_factors = svd.fit_transform(matrix)       # shape: (n_users, k)
    item_factors = svd.components_.T               # shape: (n_items, k)

    # Normalize for cosine similarity
    user_factors_norm = normalize(user_factors, norm="l2")
    item_factors_norm = normalize(item_factors, norm="l2")

    explained_var = float(svd.explained_variance_ratio_.sum())
    log.info(f"Explained variance: {explained_var:.4f}")

    # Generate top-N recommendations for each user
    log.info(f"Generating top-{TOP_N} recommendations for {n_users} users...")
    user_list = list(users)
    item_list = list(items)

    # Batch score: (n_users, n_items) similarity matrix
    scores_matrix = user_factors_norm @ item_factors_norm.T  # cosine similarity

    # Mask already-seen items (set to -inf)
    seen_mask = (matrix > 0).toarray()
    scores_matrix[seen_mask] = -np.inf

    recs = []
    for i, user_id in enumerate(user_list):
        top_idx = np.argsort(scores_matrix[i])[::-1][:TOP_N]
        top_items = [item_list[j] for j in top_idx if scores_matrix[i, j] > -np.inf]
        top_scores = [float(scores_matrix[i, j]) for j in top_idx if scores_matrix[i, j] > -np.inf]
        recs.append({
            "user_id": user_id,
            "recommended_items": json.dumps(top_items),
            "recommendation_scores": json.dumps([round(s, 4) for s in top_scores]),
            "n_recommendations": len(top_items),
            "scored_at": datetime.now(timezone.utc).isoformat(),
        })

    scores_df = pd.DataFrame(recs)
    log.info(f"Generated recommendations for {len(scores_df)} users")

    upload_scores(scores_df, "scores_recs")

    # Save model
    model_data = {
        "svd": svd,
        "user_factors": user_factors,
        "item_factors": item_factors,
        "item_factors_norm": item_factors_norm,
        "user_idx": user_idx,
        "item_idx": item_idx,
        "item_list": item_list,
    }
    model_path = "/tmp/collab_model.pkl"
    joblib.dump(model_data, model_path)
    s3_key = model_s3_key(MODEL_NAME, "latest")
    s3_uri = s3_upload(model_path, s3_key)
    s3_upload(model_path, model_s3_key(MODEL_NAME, datetime.now(timezone.utc).strftime("%Y-%m-%d")))

    metrics = {
        "explained_variance": round(explained_var, 4),
        "n_components": n_components,
        "n_users": n_users,
        "n_items": n_items,
        "avg_recommendations_per_user": round(scores_df["n_recommendations"].mean(), 2),
        "interactions": len(df),
    }
    log_ml_run(MODEL_NAME, metrics, s3_uri, len(df))
    log.info("=== Collab Training complete ===")


if __name__ == "__main__":
    main()
