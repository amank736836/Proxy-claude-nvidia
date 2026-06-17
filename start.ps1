# start.ps1
# Starts the global Anthropic → NVIDIA NIM Proxy (Node.js)

Write-Host "=== Global NVIDIA NIM Proxy ===" -ForegroundColor Cyan
Write-Host "Port  : 8082" -ForegroundColor Green
Write-Host "Model : moonshotai/kimi-k2.6" -ForegroundColor Green
Write-Host ""
Write-Host "Starting proxy... (Ctrl+C to stop)" -ForegroundColor Yellow
Write-Host ""

$serverPath = Join-Path $PSScriptRoot "server.mjs"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$logPath = Join-Path $logDir "proxy_$timestamp.log"
Write-Host "Proxy logs will be saved to: $logPath" -ForegroundColor Gray

node $serverPath *>&1 | Tee-Object -FilePath $logPath -Append
