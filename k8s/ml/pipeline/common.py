"""
common.py — Shared utilities for all ML pipeline CronJobs.

All DuckDB access goes through duckdb-api REST (never direct file access).
All S3 access uses boto3 with credentials from env vars.
"""

import os
import json
import logging
import uuid
import time
from datetime import datetime, timezone
from typing import Any

import boto3
import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("ml-pipeline")

# ── Config from env ───────────────────────────────────────────────────────────
DUCKDB_API_URL = os.getenv(
    "DUCKDB_API_URL", "http://duckdb-api.analytics.svc.cluster.local"
)
ML_ADMIN_TOKEN = os.getenv("ML_ADMIN_TOKEN", "")
S3_BUCKET = os.getenv("ANALYTICS_S3_BUCKET", "cloudless-analytics-data")
S3_REGION = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
S3_MODEL_PREFIX = os.getenv("S3_MODEL_PREFIX", "ml-models")
S3_PARQUET_PREFIX = os.getenv("S3_PARQUET_PREFIX", "ml-parquet")
REQUEST_TIMEOUT = int(os.getenv("DUCKDB_TIMEOUT", "60"))


# ── DuckDB API helpers ────────────────────────────────────────────────────────

def duckdb_query(sql: str, limit: int = 100_000) -> list[dict]:
    """Run a read-only SQL query via duckdb-api. Returns list of row dicts."""
    resp = requests.post(
        f"{DUCKDB_API_URL}/query",
        json={"sql": sql, "limit": limit},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("rows", [])


def duckdb_execute(sql: str) -> None:
    """Execute a mutating SQL statement via duckdb-api /execute (token-protected)."""
    if not ML_ADMIN_TOKEN:
        raise RuntimeError("ML_ADMIN_TOKEN not set — cannot execute mutating SQL")
    resp = requests.post(
        f"{DUCKDB_API_URL}/execute",
        json={"sql": sql},
        headers={"x-ml-admin": ML_ADMIN_TOKEN},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()


def duckdb_table_exists(table: str) -> bool:
    """Check if a table or view exists in the analytics DB."""
    try:
        rows = duckdb_query(
            f"SELECT 1 FROM information_schema.tables "
            f"WHERE table_schema='main' AND table_name='{table}'"
        )
        return len(rows) > 0
    except Exception:
        return False


def duckdb_load_parquet(path: str, view_name: str) -> None:
    """Register a Parquet file (local or s3://) as a DuckDB view."""
    resp = requests.post(
        f"{DUCKDB_API_URL}/load-parquet",
        json={"path": path, "view_name": view_name},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    log.info(f"Registered DuckDB view: {view_name} → {path}")


def duckdb_tables() -> list[str]:
    """List all tables/views in the analytics DB."""
    rows = duckdb_query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"
    )
    return [r["table_name"] for r in rows]


# ── S3 helpers ────────────────────────────────────────────────────────────────

def s3_client():
    return boto3.client("s3", region_name=S3_REGION)


def s3_upload(local_path: str, s3_key: str) -> str:
    """Upload a local file to S3. Returns the full s3:// URI."""
    s3 = s3_client()
    s3.upload_file(local_path, S3_BUCKET, s3_key)
    uri = f"s3://{S3_BUCKET}/{s3_key}"
    log.info(f"Uploaded: {local_path} → {uri}")
    return uri


def s3_download(s3_key: str, local_path: str) -> None:
    """Download a file from S3 to local path."""
    s3 = s3_client()
    s3.download_file(S3_BUCKET, s3_key, local_path)
    log.info(f"Downloaded: s3://{S3_BUCKET}/{s3_key} → {local_path}")


def s3_key_exists(s3_key: str) -> bool:
    try:
        s3_client().head_object(Bucket=S3_BUCKET, Key=s3_key)
        return True
    except Exception:
        return False


def model_s3_key(model_name: str, version: str = "latest") -> str:
    return f"{S3_MODEL_PREFIX}/{model_name}/{version}.pkl"


def parquet_s3_key(name: str) -> str:
    return f"{S3_PARQUET_PREFIX}/{name}.parquet"


def parquet_s3_uri(name: str) -> str:
    return f"s3://{S3_BUCKET}/{parquet_s3_key(name)}"


# ── ML run tracking ───────────────────────────────────────────────────────────

def ensure_ml_schema() -> None:
    """Create ML tracking tables if they don't exist."""
    tables = {
        "ml_runs": """
            CREATE TABLE IF NOT EXISTS ml_runs (
                run_id VARCHAR PRIMARY KEY,
                model_name VARCHAR,
                trained_at TIMESTAMP,
                metrics VARCHAR,
                model_s3_path VARCHAR,
                is_champion BOOLEAN DEFAULT true,
                training_rows INTEGER
            )
        """,
        "ml_features": """
            CREATE TABLE IF NOT EXISTS ml_features (
                feature_name VARCHAR,
                computed_at TIMESTAMP,
                row_count INTEGER,
                s3_parquet_path VARCHAR
            )
        """,
        "ab_experiments": """
            CREATE TABLE IF NOT EXISTS ab_experiments (
                experiment_id VARCHAR PRIMARY KEY,
                name VARCHAR,
                variants VARCHAR,
                started_at TIMESTAMP,
                ended_at TIMESTAMP,
                status VARCHAR DEFAULT 'active'
            )
        """,
        "ab_assignments": """
            CREATE TABLE IF NOT EXISTS ab_assignments (
                experiment_id VARCHAR,
                user_id VARCHAR,
                variant VARCHAR,
                assigned_at TIMESTAMP,
                converted BOOLEAN DEFAULT false,
                converted_at TIMESTAMP
            )
        """,
    }
    for table_name, ddl in tables.items():
        if not duckdb_table_exists(table_name):
            log.info(f"Creating table: {table_name}")
            duckdb_execute(ddl.strip())
        else:
            log.info(f"Table exists: {table_name}")


def log_ml_run(
    model_name: str,
    metrics: dict[str, Any],
    model_s3_path: str,
    training_rows: int,
) -> str:
    """Insert a row into ml_runs and return the run_id."""
    run_id = str(uuid.uuid4())
    trained_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    metrics_json = json.dumps(metrics).replace("'", "''")
    model_s3_path_esc = model_s3_path.replace("'", "''")

    # Mark previous champion as non-champion for this model
    try:
        duckdb_execute(
            f"UPDATE ml_runs SET is_champion=false "
            f"WHERE model_name='{model_name}' AND is_champion=true"
        )
    except Exception:
        pass  # Table may be empty

    duckdb_execute(
        f"INSERT INTO ml_runs (run_id, model_name, trained_at, metrics, "
        f"model_s3_path, is_champion, training_rows) VALUES "
        f"('{run_id}', '{model_name}', '{trained_at}', '{metrics_json}', "
        f"'{model_s3_path_esc}', true, {training_rows})"
    )
    log.info(f"Logged ML run: {model_name} run_id={run_id} metrics={metrics}")
    return run_id


def log_ml_feature(feature_name: str, row_count: int, s3_path: str) -> None:
    computed_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    s3_path_esc = s3_path.replace("'", "''")
    duckdb_execute(
        f"INSERT INTO ml_features (feature_name, computed_at, row_count, s3_parquet_path) "
        f"VALUES ('{feature_name}', '{computed_at}', {row_count}, '{s3_path_esc}')"
    )


# ── Parquet I/O ───────────────────────────────────────────────────────────────

def write_parquet(df, local_path: str) -> None:
    """Write a pandas DataFrame to a local Parquet file."""
    df.to_parquet(local_path, index=False, engine="pyarrow")
    log.info(f"Written {len(df)} rows to {local_path}")


def upload_scores(df, name: str, tmp_path: str = "/tmp") -> str:
    """Write df to parquet, upload to S3, register DuckDB view. Returns s3 URI."""
    local = f"{tmp_path}/{name}.parquet"
    write_parquet(df, local)
    s3_key = parquet_s3_key(name)
    uri = s3_upload(local, s3_key)
    duckdb_load_parquet(uri, name)
    return uri


def retry(fn, retries: int = 3, delay: float = 5.0):
    """Retry a function on exception."""
    for i in range(retries):
        try:
            return fn()
        except Exception as e:
            if i < retries - 1:
                log.warning(f"Retry {i+1}/{retries} after error: {e}")
                time.sleep(delay)
            else:
                raise
