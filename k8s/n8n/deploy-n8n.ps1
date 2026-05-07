#!/usr/bin/env pwsh
# deploy-n8n.ps1 — Deploy n8n to the k3s cluster
# Run from repo root: .\k8s\n8n\deploy-n8n.ps1
# Requires: SSH access to omv-main (192.168.1.128)

param(
    [string]$NotionToken   = "",
    [string]$AnthropicKey  = "",
    [string]$SlackWebhook  = ""
)

$OMV = "192.168.1.128"
$SSH = "ssh -i $HOME\.ssh\id_ed25519 pi@$OMV"
$MANIFEST = "$PSScriptRoot\n8n.yaml"

Write-Host "=== n8n Deploy ===" -ForegroundColor Cyan

# Prompt for secrets if not passed as params
if (-not $NotionToken)   { $NotionToken  = Read-Host "Notion Internal Integration Token" }
if (-not $AnthropicKey)  { $AnthropicKey = Read-Host "Anthropic API Key" }
if (-not $SlackWebhook)  { $SlackWebhook = Read-Host "Slack Webhook URL (leave blank to skip)" }

# Generate encryption key
$EncKey = -join ((0..31) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
Write-Host "Generated N8N_ENCRYPTION_KEY: $EncKey" -ForegroundColor Gray
Write-Host "(Save this — you need it if you ever restore n8n data)" -ForegroundColor Yellow

# Copy manifest to omv-main
Write-Host "`nCopying manifest..." -ForegroundColor Cyan
scp -i "$HOME\.ssh\id_ed25519" $MANIFEST "pi@${OMV}:/tmp/n8n.yaml"

# Apply manifest (creates NS, PVC, Deployment, Service, Certificate, Ingress, Middleware)
Write-Host "Applying manifest..." -ForegroundColor Cyan
Invoke-Expression "$SSH 'kubectl apply -f /tmp/n8n.yaml'"

# Create secret separately with real values
Write-Host "Creating secret..." -ForegroundColor Cyan
$SecretCmd = @"
kubectl create secret generic n8n-secrets -n n8n \
  --from-literal=N8N_ENCRYPTION_KEY='$EncKey' \
  --from-literal=NOTION_API_KEY='$NotionToken' \
  --from-literal=ANTHROPIC_API_KEY='$AnthropicKey' \
  --from-literal=SLACK_WEBHOOK_URL='$SlackWebhook' \
  --dry-run=client -o yaml | kubectl apply -f -
"@
Invoke-Expression "$SSH '$SecretCmd'"

# Restart deployment to pick up secret
Write-Host "Restarting n8n pod..." -ForegroundColor Cyan
Invoke-Expression "$SSH 'kubectl rollout restart deployment/n8n -n n8n'"

# Wait for rollout
Write-Host "Waiting for rollout..." -ForegroundColor Cyan
Invoke-Expression "$SSH 'kubectl rollout status deployment/n8n -n n8n --timeout=120s'"

# Show status
Write-Host "`n=== Status ===" -ForegroundColor Cyan
Invoke-Expression "$SSH 'kubectl get pods,svc,ingress,certificate -n n8n'"

Write-Host "`n✅ n8n deployed at https://n8n.cloudless.online" -ForegroundColor Green
Write-Host "   Import workflows from: k8s\n8n\workflows\analytics-to-notion.json" -ForegroundColor Gray
Write-Host "   Configure credentials: Notion API, Anthropic (Header Auth), Slack Webhook" -ForegroundColor Gray
