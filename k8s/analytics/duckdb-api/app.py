"""
DuckDB Query API
Lightweight FastAPI wrapper around DuckDB for the analytics stack.
Reads S3 Parquet files (via httpfs) or local files in /data.

Endpoints:
  POST /query          — execute a SQL query, return JSON rows
  GET  /health         — liveness check
  GET  /tables         — list available tables/views
  POST /load-parquet   — register a Parquet file as a view

Concurrency note:
  DuckDB allows multiple concurrent read-only connections OR one read-write
  connection. Since Metabase holds a persistent read-only connection to the
  same file, duckdb-api opens per-request read-only connections for queries
  and short-lived read-write connections only for view registration
  (/load-parquet). Each connection is closed immediately after use.
"""

import os
import glob
import json
import logging
import time
from contextlib import contextmanager

import duckdb
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("duckdb-api")

DATA_DIR = os.getenv("DATA_DIR", "/data")
S3_REGION = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
S3_BUCKET = os.getenv("ANALYTICS_S3_BUCKET", "")
MAX_ROWS = int(os.getenv("MAX_ROWS", "10000"))
ML_ADMIN_TOKEN = os.getenv("ML_ADMIN_TOKEN", "")

db_path = os.path.join(DATA_DIR, "analytics.duckdb")


@contextmanager
def get_conn(read_only: bool = True, retries: int = 5, delay: float = 0.5):
    """Open a DuckDB connection, yield it, and close on exit.

    Uses read_only=True by default so multiple calls coexist with Metabase's
    persistent read-only connection. read_only=False is only needed for DDL
    (CREATE VIEW). If lock contention occurs, retry up to `retries` times.
    """
    conn = None
    last_err = None
    for attempt in range(retries):
        try:
            conn = duckdb.connect(db_path, read_only=read_only)
            _load_extensions(conn)
            break
        except duckdb.IOException as e:
            last_err = e
            if attempt < retries - 1:
                log.warning(f"Lock contention (attempt {attempt+1}/{retries}): {e}")
                time.sleep(delay)
            else:
                raise HTTPException(503, f"DuckDB unavailable (lock): {e}") from e
    try:
        yield conn
    finally:
        if conn:
            conn.close()


def _load_extensions(conn: duckdb.DuckDBPyConnection):
    try:
        conn.execute("LOAD httpfs;")
    except Exception:
        pass
    try:
        conn.execute("LOAD json;")
    except Exception:
        pass
    if S3_BUCKET:
        try:
            conn.execute(f"SET s3_region='{S3_REGION}';")
            aws_key = os.getenv("AWS_ACCESS_KEY_ID", "")
            aws_secret = os.getenv("AWS_SECRET_ACCESS_KEY", "")
            if aws_key:
                conn.execute(f"SET s3_access_key_id='{aws_key}';")
                conn.execute(f"SET s3_secret_access_key='{aws_secret}';")
        except Exception:
            pass


def _register_parquet_views():
    """Open a short-lived RW connection to register all local Parquet files as views."""
    parquet_files = glob.glob(f"{DATA_DIR}/**/*.parquet", recursive=True)
    if not parquet_files:
        log.info("No local Parquet files found to register.")
        return

    try:
        with get_conn(read_only=False, retries=3, delay=1.0) as conn:
            for f in parquet_files:
                view = os.path.splitext(os.path.basename(f))[0].replace("-", "_")
                try:
                    conn.execute(
                        f"CREATE OR REPLACE VIEW {view} AS SELECT * FROM read_parquet('{f}')"
                    )
                    log.info(f"Registered view: {view} → {f}")
                except Exception as e:
                    log.warning(f"Could not register {f}: {e}")
    except HTTPException as e:
        log.warning(f"Skipped Parquet view registration (lock contention): {e.detail}")


from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Install extensions once (needs RW)
    try:
        with get_conn(read_only=False, retries=3, delay=2.0) as conn:
            conn.execute("INSTALL httpfs;")
            conn.execute("INSTALL json;")
        log.info("Extensions installed.")
    except Exception as e:
        log.warning(f"Extension install skipped: {e}")

    _register_parquet_views()
    log.info(f"DuckDB API ready — DB: {db_path}")
    yield


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


class ExecuteRequest(BaseModel):
    sql: str


@app.get("/health")
def health():
    return {"status": "ok", "db": "duckdb"}


@app.get("/tables")
def list_tables():
    with get_conn(read_only=True) as conn:
        rows = conn.execute(
            "SELECT table_name, table_type FROM information_schema.tables "
            "WHERE table_schema='main' ORDER BY table_name"
        ).fetchall()
    return {"tables": [{"name": r[0], "type": r[1]} for r in rows]}


@app.post("/query")
def query(req: QueryRequest):
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

    try:
        with get_conn(read_only=True) as conn:
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
        with get_conn(read_only=False) as conn:
            conn.execute(
                f"CREATE OR REPLACE VIEW {req.view_name} AS "
                f"SELECT * FROM read_parquet('{req.path}')"
            )
        return {"created": req.view_name, "source": req.path}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/execute")
def execute(req: ExecuteRequest, x_ml_admin: str = Header(default=None)):
    """Execute a mutating SQL statement (INSERT/UPDATE/CREATE TABLE).

    Restricted to ML pipeline CronJobs via ML_ADMIN_TOKEN header.
    Allows: INSERT, UPDATE, CREATE TABLE, CREATE OR REPLACE VIEW.
    Blocks: DROP, DELETE, TRUNCATE, ALTER TABLE (for safety).
    """
    if not ML_ADMIN_TOKEN:
        raise HTTPException(503, "ML_ADMIN_TOKEN not configured")
    if x_ml_admin != ML_ADMIN_TOKEN:
        raise HTTPException(403, "Forbidden: invalid ML admin token")

    sql_upper = req.sql.strip().upper()
    blocked = ("DROP TABLE", "DROP VIEW", "DROP DATABASE", "DELETE FROM",
               "TRUNCATE", "ALTER TABLE", "ALTER DATABASE")
    for stmt in blocked:
        if sql_upper.startswith(stmt) or f"; {stmt}" in sql_upper:
            raise HTTPException(400, f"Blocked statement: {stmt}")

    try:
        with get_conn(read_only=False) as conn:
            conn.execute(req.sql)
        log.info(f"ML /execute: {req.sql[:120]}")
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"/execute error: {e}\nSQL: {req.sql}")
        raise HTTPException(500, str(e))
