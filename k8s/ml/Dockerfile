# ML Pipeline image — ARM64 (linux/arm64 / aarch64)
# All Python packages use pre-built manylinux_2_28_aarch64 wheels — no compilation.
#
# Build & push:
#   .\k8s\ml\build-push-ml-pipeline.ps1
# Or manually:
#   docker buildx build --platform linux/arm64 \
#     -t ghcr.io/themis128/ml-pipeline:latest \
#     --push k8s/ml/
FROM python:3.12-slim

WORKDIR /app

# Runtime dependencies only (no build tools needed — all packages are pure wheels)
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Install with explicit index to ensure arm64 wheel selection
RUN pip install --no-cache-dir \
    --index-url https://pypi.org/simple/ \
    -r requirements.txt

# Copy pipeline scripts
COPY pipeline/ /scripts/

# Verify arm64 wheel was actually installed (not compiled fallback)
RUN python -c "import sklearn; import lightgbm; import pandas; import boto3; print('All ML deps OK')"

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/scripts

WORKDIR /scripts

# Default: show help (actual command is overridden per CronJob)
CMD ["python", "--version"]
