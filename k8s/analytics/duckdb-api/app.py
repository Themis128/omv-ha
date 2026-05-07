"""
DuckDB Query API
Lightweight FastAPI wrapper around DuckDB for the analytics stack.
Reads S3 Parquet files (via httpfs) or local files in /data.

Endpoints:
  POST /query          — execute a SQL query, return JSON rows
  GET  /health         — liveness check
  GET  /tables         — list available tables/views
  POST /load-parquet   — register a Parquet file as a view
"""

import os
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

import duckdb
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("duckdb-api")

DATA_DIR = os.getenv("DATA_DIR", "/data")
S3_REGION = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
S3_BUCKET = os.getenv("ANALYTICS_S3_BUCKET", "")
MAX_ROWS = int(os.getenv("MAX_ROWS", "10000"))

# Global connection — DuckDB is single-writer, safe for read-heavy workloads
conn: duckdb.DuckDBPyConnection = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global conn
    db_path = os.path.join(DATA_DIR, "analytics.duckdb")
    conn = duckdb.connect(db_path)

    # Extensions
    conn.execute("INSTALL httpfs; LOAD httpfs;")
    conn.execute("INSTALL json;  LOAD json;")

    # S3 credentials from environment (IAM role on EC2, or explicit keys)
    if S3_BUCKET:
        conn.execute(f"SET s3_region='{S3_REGION}';")
        aws_key = os.getenv("AWS_ACCESS_KEY_ID", "")
        aws_secret = os.getenv("AWS_SECRET_ACCESS_KEY", "")
        if aws_key:
            conn.execute(f"SET s3_access_key_id='{aws_key}';")
            conn.execute(f"SET s3_secret_access_key='{aws_secret}';")

    # Auto-register any parquet files already in DATA_DIR
    import glob
    for f in glob.glob(f"{DATA_DIR}/**/*.parquet", recursive=True):
        view = os.path.splitext(os.path.basename(f))[0].replace("-", "_")
        try:
            conn.execute(f"CREATE OR REPLACE VIEW {view} AS SELECT * FROM read_parquet('{f}')")
            log.info(f"Registered view: {view} → {f}")
        except Exception as e:
            log.warning(f"Could not register {f}: {e}")

    log.info(f"DuckDB API ready — DB: {db_path}")
    yield
    conn.close()


app = FastAPI(title="DuckDB Analytics API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class QueryRequest(BaseModel):
    sql: str
    limit: int = MAX_ROWS


class ParquetRequest(BaseModel):
    path: str        # local path or s3://bucket/key
    view_name: str


@app.get("/health")
def health():
    return {"status": "ok", "db": "duckdb"}


@app.get("/tables")
def list_tables():
    rows = conn.execute(
        "SELECT table_name, table_type FROM information_schema.tables "
        "WHERE table_schema='main' ORDER BY table_name"
    ).fetchall()
    return {"tables": [{"name": r[0], "type": r[1]} for r in rows]}


@app.post("/query")
def query(req: QueryRequest):
    try:
        # Safety: block destructive statements
        sql_upper = req.sql.strip().upper()
        for banned in ("DROP ", "DELETE ", "TRUNCATE ", "ALTER ", "INSERT ", "UPDATE "):
            if sql_upper.startswith(banned):
                raise HTTPException(400, f"Mutating query not allowed: {banned.strip()}")

        # Inject LIMIT if not present
        if "LIMIT" not in sql_upper and req.limit > 0:
            sql = f"{req.sql.rstrip(';')} LIMIT {req.limit}"
        else:
            sql = req.sql

        rel = conn.execute(sql)
        cols = [d[0] for d in rel.description]
        rows = rel.fetchall()
        return {
            "columns": cols,
            "rows": [dict(zip(cols, r)) for r in rows],
            "count": len(rows),
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Query error: {e}\nSQL: {req.sql}")
        raise HTTPException(500, str(e))


@app.post("/load-parquet")
def load_parquet(req: ParquetRequest):
    try:
        conn.execute(
            f"CREATE OR REPLACE VIEW {req.view_name} AS "
            f"SELECT * FROM read_parquet('{req.path}')"
        )
        return {"created": req.view_name, "source": req.path}
    except Exception as e:
        raise HTTPException(500, str(e))
