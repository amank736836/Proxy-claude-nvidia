param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs
)

$ErrorActionPreference = "Stop"

# Path to the proxy server
$proxyDir = $PSScriptRoot
$serverPath = Join-Path $proxyDir "server.mjs"

Write-Host "🚀 Starting NVIDIA NIM Proxy in background..." -ForegroundColor Cyan
# Start the Node.js proxy server in the background and capture the process
$proxyProcess = Start-Process -FilePath "node" -ArgumentList "`"$serverPath`"" -PassThru -WindowStyle Hidden

try {
    # Give the proxy a moment to start and bind to port 8082
    Start-Sleep -Seconds 2
    
    # Check if proxy started successfully
    if ($proxyProcess.HasExited) {
        Write-Error "Failed to start the proxy server."
        exit 1
    }

    # Set required environment variables for Claude Code
    $env:ANTHROPIC_BASE_URL = "http://localhost:8082"
    $env:ANTHROPIC_API_KEY  = "sk-nvidia-proxy"

    Write-Host "🤖 Running Claude with proxy..." -ForegroundColor Green
    
    # Execute the claude CLI with any arguments passed to this script
    if (Get-Command "claude.cmd" -ErrorAction SilentlyContinue) {
        & claude.cmd @ClaudeArgs
    } else {
        & claude @ClaudeArgs
    }

} finally {
    Write-Host "`n🛑 Stopping NVIDIA NIM Proxy..." -ForegroundColor Cyan
    # Ensure the background proxy process is killed when Claude exits
    if (-not $proxyProcess.HasExited) {
        Stop-Process -Id $proxyProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
