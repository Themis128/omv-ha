"""
content_decay.py — Content Decay Detection
Schedule: every Monday 02:00 UTC

SQL-only analysis: identifies content whose engagement has dropped
> 50% vs. the prior 30-day baseline. No ML model needed — pure window SQL.
"""

import logging
import numpy as np
import pandas as pd
from datetime import datetime, timezone, timedelta

from common import (
    duckdb_query, duckdb_table_exists,
    upload_scores, log,
)

log = logging.getLogger("content-decay")


def make_synthetic_content_views() -> pd.DataFrame:
    """Synthetic content view data when no real table exists."""
    np.random.seed(789)
    now = datetime.now(timezone.utc)
    items = [f"page_{i}" for i in range(30)]
    records = []
    for item in items:
        # Some items have decayed (recent views << baseline)
        decayed = np.random.random() < 0.3
        for d in range(90):
            date = (now - timedelta(days=d)).date()
            if decayed and d < 15:
                views = int(abs(np.random.normal(5, 2)))   # current: low
            elif decayed:
                views = int(abs(np.random.normal(40, 10)))  # past: high
            else:
                views = int(abs(np.random.normal(30, 8)))   # stable
            records.append({"content_id": item, "date": str(date), "views": views})
    return pd.DataFrame(records)


def compute_decay(views_df: pd.DataFrame) -> pd.DataFrame:
    """Compute decay ratio: recent 7-day avg vs. prior 30-day baseline avg."""
    today = datetime.now(timezone.utc).date()
    views_df["date"] = pd.to_datetime(views_df["date"]).dt.date
    views_df["views"] = views_df["views"].fillna(0).astype(int)

    # Recent window: last 7 days (days 0–6)
    recent_cutoff = today - timedelta(days=7)
    # Baseline window: days 7–37
    baseline_start = today - timedelta(days=37)
    baseline_end = today - timedelta(days=7)

    recent = (
        views_df[views_df["date"] >= recent_cutoff]
        .groupby("content_id")["views"]
        .mean()
        .rename("recent_7d_avg")
    )
    baseline = (
        views_df[(views_df["date"] >= baseline_start) & (views_df["date"] < baseline_end)]
        .groupby("content_id")["views"]
        .mean()
        .rename("baseline_30d_avg")
    )

    merged = pd.concat([recent, baseline], axis=1).fillna(0)
    merged["decay_ratio"] = merged["recent_7d_avg"] / merged["baseline_30d_avg"].clip(lower=0.1)
    merged["decayed"] = merged["decay_ratio"] < 0.5
    merged["decay_pct"] = ((1 - merged["decay_ratio"]) * 100).clip(lower=0).round(1)
    merged["scored_at"] = datetime.now(timezone.utc).isoformat()
    merged = merged.reset_index().rename(columns={"index": "content_id"})

    return merged


def main():
    log.info("=== Content Decay Detection starting ===")

    # Try to load from DuckDB via SQL window functions (preferred)
    decay_df = None
    if duckdb_table_exists("content_daily_views"):
        try:
            rows = duckdb_query("""
                WITH recent AS (
                    SELECT content_id,
                           AVG(views) AS recent_7d_avg
                    FROM content_daily_views
                    WHERE date >= CURRENT_DATE - INTERVAL 7 DAY
                    GROUP BY content_id
                ),
                baseline AS (
                    SELECT content_id,
                           AVG(views) AS baseline_30d_avg
                    FROM content_daily_views
                    WHERE date BETWEEN CURRENT_DATE - INTERVAL 37 DAY
                                   AND CURRENT_DATE - INTERVAL 7 DAY
                    GROUP BY content_id
                )
                SELECT
                    r.content_id,
                    r.recent_7d_avg,
                    b.baseline_30d_avg,
                    r.recent_7d_avg / NULLIF(b.baseline_30d_avg, 0) AS decay_ratio,
                    r.recent_7d_avg / NULLIF(b.baseline_30d_avg, 0) < 0.5 AS decayed,
                    ROUND((1 - r.recent_7d_avg / NULLIF(b.baseline_30d_avg, 0.001)) * 100, 1)
                        AS decay_pct
                FROM recent r
                LEFT JOIN baseline b ON r.content_id = b.content_id
            """)
            decay_df = pd.DataFrame(rows)
            decay_df["scored_at"] = datetime.now(timezone.utc).isoformat()
            log.info(f"Loaded {len(decay_df)} content items from DuckDB SQL")
        except Exception as e:
            log.warning(f"DuckDB SQL failed: {e}. Falling back to pandas computation.")

    if decay_df is None or decay_df.empty:
        # Try page_views table
        if duckdb_table_exists("page_views") or duckdb_table_exists("events"):
            tbl = "page_views" if duckdb_table_exists("page_views") else "events"
            rows = duckdb_query(
                f"SELECT user_id, "
                f"{'url' if tbl == 'page_views' else 'item_id'} AS content_id, "
                f"ts FROM {tbl} "
                f"WHERE ts >= NOW() - INTERVAL 90 DAY LIMIT 500000"
            )
            raw_df = pd.DataFrame(rows)
            if not raw_df.empty and "content_id" in raw_df.columns:
                raw_df["date"] = pd.to_datetime(raw_df["ts"]).dt.date
                views_df = raw_df.groupby(["content_id", "date"]).size().reset_index(name="views")
                decay_df = compute_decay(views_df)
                log.info(f"Computed decay from {len(raw_df)} events")
            else:
                log.info("No usable event data — using synthetic data")
                views_df = make_synthetic_content_views()
                decay_df = compute_decay(views_df)
        else:
            log.info("No content tables found — using synthetic data for testing")
            views_df = make_synthetic_content_views()
            decay_df = compute_decay(views_df)

    n_decayed = int(decay_df["decayed"].sum()) if "decayed" in decay_df.columns else 0
    log.info(f"Decay analysis: {len(decay_df)} items, {n_decayed} decayed "
             f"({100*n_decayed/max(1,len(decay_df)):.1f}%)")

    if n_decayed > 0:
        top_decayed = decay_df[decay_df["decayed"]].nlargest(5, "decay_pct")
        log.info(f"Top decayed content:\n{top_decayed[['content_id', 'decay_pct']].to_string()}")

    upload_scores(decay_df, "scores_decay")
    log.info("=== Content Decay Detection complete ===")


if __name__ == "__main__":
    main()
