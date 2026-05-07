# ARM64 DuckDB API image — published to GitHub Container Registry
# Build & push:
#   .\k8s\analytics\build-push-duckdb-api.ps1
# Or manually:
#   docker buildx build --platform linux/arm64 \
#     -t ghcr.io/themis128/duckdb-api:latest \
#     --push k8s/analytics/duckdb-api/
FROM python:3.12-slim

WORKDIR /app

# System deps for DuckDB native extensions
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Pre-install DuckDB extensions during build (avoids cold-start downloads)
RUN python -c "import duckdb; c=duckdb.connect(); c.execute('INSTALL httpfs; INSTALL json;')"

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
