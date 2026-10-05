# Patchbay Gateway - Claude Desktop client installer
# Self-contained: bundles its own Node + mcp-remote, so nothing is downloaded and
# nothing needs to be on PATH. Merges a single server entry into the user's existing
# Claude Desktop config without disturbing anything else.

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail($msg) {
    Write-Host ""
    Write-Host "ERROR: $msg" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

try {
    Write-Host "==============================================" -ForegroundColor Cyan
    Write-Host " Patchbay Gateway - Claude Desktop setup" -ForegroundColor Cyan
    Write-Host "==============================================" -ForegroundColor Cyan
    Write-Host ""

    $paramsPath = Join-Path $scriptDir 'params.json'
    if (-not (Test-Path $paramsPath)) { Fail "params.json not found next to this script." }
    $params = Get-Content $paramsPath -Raw | ConvertFrom-Json
    $serverName = $params.serverName
    $url = $params.url
    if ([string]::IsNullOrWhiteSpace($serverName)) { $serverName = 'patchbay' }
    if ([string]::IsNullOrWhiteSpace($url)) { Fail "No gateway URL in params.json." }

    # 1. Copy the bundled runtime into a stable per-user location.
    $dest = Join-Path $env:LOCALAPPDATA 'patchbay-gateway'
    Write-Host "Installing runtime to: $dest"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item (Join-Path $scriptDir 'node')       $dest -Recurse -Force
    Copy-Item (Join-Path $scriptDir 'mcp-remote') $dest -Recurse -Force

    $nodeExe = Join-Path $dest 'node\node.exe'
    $proxyJs = Join-Path $dest 'mcp-remote\node_modules\mcp-remote\dist\proxy.js'
    if (-not (Test-Path $nodeExe)) { Fail "Bundled node.exe missing after copy." }
    if (-not (Test-Path $proxyJs)) { Fail "Bundled mcp-remote missing after copy." }

    # 2. Merge the server entry into the Claude Desktop config (create if absent).
    $claudeDir = Join-Path $env:APPDATA 'Claude'
    $cfgPath = Join-Path $claudeDir 'claude_desktop_config.json'
    New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

    if (Test-Path $cfgPath) {
        Copy-Item $cfgPath "$cfgPath.bak" -Force
        Write-Host "Backed up existing config to: $cfgPath.bak"
        $raw = Get-Content $cfgPath -Raw
        if ([string]::IsNullOrWhiteSpace($raw)) { $cfg = [pscustomobject]@{} }
        else { $cfg = $raw | ConvertFrom-Json }
    } else {
        $cfg = [pscustomobject]@{}
    }

    if ($null -eq $cfg.mcpServers) {
        $cfg | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{}) -Force
    }

    $entry = [pscustomobject]@{
        command = $nodeExe
        args    = @($proxyJs, $url, '--allow-http')
    }
    $cfg.mcpServers | Add-Member -NotePropertyName $serverName -NotePropertyValue $entry -Force

    # 3. Write back as UTF-8 without BOM (Claude Desktop dislikes a BOM).
    $json = $cfg | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host ""
    Write-Host "Success!" -ForegroundColor Green
    Write-Host "Added MCP server '$serverName' to Claude Desktop."
    Write-Host ""
    Write-Host "LAST STEP: fully quit and restart Claude Desktop" -ForegroundColor Yellow
    Write-Host "(right-click the tray icon -> Quit, then reopen)."
    Write-Host ""
    Read-Host "Press Enter to close"
}
catch {
    Fail $_.Exception.Message
}
