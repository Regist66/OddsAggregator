[CmdletBinding()]
param(
    [ValidateRange(250, 10000)][int]$RefreshMilliseconds = 1000,
    [string]$HeadlessFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectDir = Split-Path -Parent $PSScriptRoot
$normalFile = Join-Path $projectDir "data\football\surebets_live_odds.txt"
if ($HeadlessFile) {
    $headlessFile = [IO.Path]::GetFullPath($HeadlessFile)
} else {
    $shadowRoot = Join-Path $projectDir "data\shadow-headless"
    $latestRun = Get-ChildItem -LiteralPath $shadowRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    $headlessFile = if ($latestRun) {
        Join-Path $latestRun.FullName "football\surebets_live_odds.txt"
    } else {
        Join-Path $projectDir "data\football\surebets_live_odds_headless.txt"
    }
}

function Get-SurebetText {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return "(File does not exist yet; start a shadow test.)"
    }

    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding utf8
    } catch {
        return "(Temporary read error: $($_.Exception.Message))"
    }
}

while ($true) {
    Clear-Host
    $normalStamp = if (Test-Path -LiteralPath $normalFile) { (Get-Item -LiteralPath $normalFile).LastWriteTime.ToString("HH:mm:ss") } else { "nincs" }
    $headlessStamp = if (Test-Path -LiteralPath $headlessFile) { (Get-Item -LiteralPath $headlessFile).LastWriteTime.ToString("HH:mm:ss") } else { "nincs" }

    Write-Host ("Surebet comparison - refreshed: {0}  (Ctrl+C: exit)" -f (Get-Date -Format "HH:mm:ss")) -ForegroundColor Cyan
    Write-Host "Headless file: $headlessFile" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "=== NORMAL   | last write: $normalStamp ===" -ForegroundColor Yellow
    Write-Host (Get-SurebetText -Path $normalFile)
    Write-Host ""
    Write-Host "=== HEADLESS | last write: $headlessStamp ===" -ForegroundColor Green
    Write-Host (Get-SurebetText -Path $headlessFile)

    Start-Sleep -Milliseconds $RefreshMilliseconds
}
