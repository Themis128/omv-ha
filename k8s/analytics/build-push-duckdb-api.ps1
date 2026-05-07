#!/usr/bin/env pwsh
# build-push-duckdb-api.ps1
# Builds the DuckDB API image for ARM64 and pushes to GitHub Container Registry (ghcr.io)
# Run from repo root: .\k8s\analytics\build-push-duckdb-api.ps1
# Requires: Docker Desktop with buildx, gh CLI authenticated (gh auth login)

param(
    [string]$GhUser   = "themis128",
    [string]$RepoName = "duckdb-api",
    [string]$Tag      = "latest"
)

$IMAGE   = "ghcr.io/${GhUser}/${RepoName}:${Tag}"
$CONTEXT = "$PSScriptRoot\duckdb-api"

Write-Host "=== Build & Push DuckDB API ===" -ForegroundColor Cyan
Write-Host "Image: $IMAGE" -ForegroundColor Gray

# Login to GHCR using gh CLI token
Write-Host "`n1. Logging in to ghcr.io..." -ForegroundColor Cyan
$token = gh auth token 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ gh CLI not authenticated. Run: gh auth login" -ForegroundColor Red
    exit 1
}
$token | docker login ghcr.io -u $GhUser --password-stdin
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ GHCR login failed" -ForegroundColor Red
    exit 1
}

# Build for linux/arm64 and push
Write-Host "`n2. Building ARM64 image and pushing to GHCR..." -ForegroundColor Cyan
docker buildx build `
    --platform linux/arm64 `
    --tag $IMAGE `
    --push `
    $CONTEXT

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed" -ForegroundColor Red
    exit 1
}

Write-Host "`n✅ Pushed: $IMAGE" -ForegroundColor Green

# Set package visibility to public so the Pi can pull without a secret
Write-Host "`n3. Setting package visibility to public..." -ForegroundColor Cyan
gh api --method PATCH `
    -H "Accept: application/vnd.github+json" `
    "/user/packages/container/$RepoName" `
    -f visibility=public 2>&1 | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✅ Package is now public: ghcr.io/$GhUser/$RepoName" -ForegroundColor Green
} else {
    Write-Host "   ⚠️  Could not set visibility automatically — set manually:" -ForegroundColor Yellow
    Write-Host "   https://github.com/users/$GhUser/packages/container/$RepoName/settings"
}

Write-Host "`n4. Next: deploy DuckDB API to cluster" -ForegroundColor Cyan
Write-Host "   kubectl apply -f k8s\analytics\duckdb-api.yaml"
Write-Host "   Then update secret: kubectl edit secret duckdb-api-secrets -n analytics"
