# upload_scripts.ps1
# Base64-encode each task script and push to SSM as /cloudless/tasks/script-<task-id>
# Also uploads the new orchestrator.py to the Pi via SCP.
# Run from the cloudless-tasks directory.
# Prerequisites: AWS CLI configured, ssh/scp access to omv-main (192.168.1.128)

$ErrorActionPreference = "Stop"
$Region = "us-east-1"
$PiHost = "192.168.1.128"
$PiUser = "root"  # or your SSH user
$ScriptsDir = $PSScriptRoot

$tasks = @(
    "windsor-configuration-check",
    "cloudless-agency-hub-status",
    "weekly-sentry-digest",
    "daily-leads-digest",
    "notion-stale-submissions",
    "weekly-seo-snapshot",
    "weekly-gsc-notion-sync"
)

Write-Host "=== Uploading task scripts to SSM ===" -ForegroundColor Cyan

foreach ($task in $tasks) {
    $scriptPath = Join-Path $ScriptsDir "scripts\$task.py"
    if (-not (Test-Path $scriptPath)) {
        Write-Warning "Script not found: $scriptPath — skipping"
        continue
    }

    # Base64 encode (no line breaks)
    $bytes = [System.IO.File]::ReadAllBytes($scriptPath)
    $b64 = [Convert]::ToBase64String($bytes)

    $paramName = "/cloudless/tasks/script-$task"
    Write-Host "  Uploading $task ..." -NoNewline

    aws ssm put-parameter `
        --name $paramName `
        --value $b64 `
        --type String `
        --overwrite `
        --region $Region | Out-Null

    Write-Host " OK" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Deploying orchestrator.py to Pi ===" -ForegroundColor Cyan

$orchSrc = Join-Path $ScriptsDir "orchestrator.py"
if (Test-Path $orchSrc) {
    scp $orchSrc "${PiUser}@${PiHost}:/usr/local/lib/cloudless-tasks/orchestrator.py"
    Write-Host "orchestrator.py deployed." -ForegroundColor Green
} else {
    Write-Warning "orchestrator.py not found at $orchSrc"
}

Write-Host ""
Write-Host "=== Creating scripts directory on Pi ===" -ForegroundColor Cyan
ssh "${PiUser}@${PiHost}" "mkdir -p /usr/local/lib/cloudless-tasks/scripts"
Write-Host "Directory created." -ForegroundColor Green

Write-Host ""
Write-Host "=== All done! ===" -ForegroundColor Green
Write-Host "The orchestrator will self-bootstrap scripts from SSM on first run."
Write-Host "To force-install a script now: ssh to Pi and run:"
Write-Host "  python3 /usr/local/lib/cloudless-tasks/orchestrator.py <task-id>"
