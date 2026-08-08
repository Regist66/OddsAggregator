[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$IncludeProjectTools
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectDir = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$projectPattern = [regex]::Escape($projectDir)
$monitorPattern = '(?i)(?:^|[\\/])(?:sharpx|tippmixpro|vegas)_odds_monitor\.js(?=["''\s]|$)'

$targets = @(Get-CimInstance Win32_Process | Where-Object {
    if ($_.Name -ne "node.exe" -or -not $_.CommandLine) { return $false }
    if ($_.CommandLine -notmatch $projectPattern) { return $false }
    return $IncludeProjectTools -or $_.CommandLine -match $monitorPattern
})

if ($targets.Count -eq 0) {
    Write-Host "Nem fut leállítható OddsAggregator monitor." -ForegroundColor Yellow
    return
}

foreach ($target in $targets) {
    $description = "PID $($target.ProcessId): $($target.CommandLine)"
    if ($PSCmdlet.ShouldProcess($description, "Node folyamat leállítása")) {
        Stop-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
    }
}

Write-Host "Leállított folyamatok: $($targets.ProcessId -join ', ')" -ForegroundColor Green
