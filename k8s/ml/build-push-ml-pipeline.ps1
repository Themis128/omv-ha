#!/usr/bin/env pwsh
# build-push-ml-pipeline.ps1
# Builds the ML Pipeline image for ARM64 and pushes to GitHub Container Registry
# Run from repo root: .\k8s\ml\build-push-ml-pipeline.ps1

param(
    [string]$GhUser   = "themis128",
    [string]$RepoName = "ml-pipeline",
    [string]$Tag      = "latest"
)

$IMAGE   = "ghcr.io/${GhUser}/${RepoName}:${Tag}"
$CONTEXT = "$PSScriptRoot"

Write-Host "=== Build & Push ML Pipeline ===" -ForegroundColor Cyan
Write-Host "Image : $IMAGE" -ForegroundColor Gray
Write-Host "Context: $CONTEXT" -ForegroundColor Gray

# Login to GHCR
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
Write-Host "`n2. Building ARM64 image and pushing..." -ForegroundColor Cyan
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

# Set package visibility to public
Write-Host "`n3. Setting package visibility to public..." -ForegroundColor Cyan
gh api --method PATCH `
    -H "Accept: application/vnd.github+json" `
    "/user/packages/container/$RepoName" `
    -f visibility=public 2>&1 | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✅ Package is now public: ghcr.io/$GhUser/$RepoName" -ForegroundColor Green
} else {
    Write-Host "   ⚠️  Set visibility manually: https://github.com/users/$GhUser/packages/container/$RepoName/settings"
}

Write-Host "`n4. Next steps:" -ForegroundColor Cyan
Write-Host "   # Generate ML_ADMIN_TOKEN and update secret:"
Write-Host "   kubectl get secret duckdb-api-secrets -n analytics -o yaml"
Write-Host "   # Apply the k8s manifests:"
Write-Host "   kubectl apply -f k8s\ml\cronjobs.yaml"
Write-Host "   # Test by running feature engineer manually:"
Write-Host "   kubectl create job ml-feature-test --from=cronjob/ml-feature-engineer -n analytics"
