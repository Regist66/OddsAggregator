[CmdletBinding()]
param(
    [ValidateRange(1, 168)][int]$DurationHours = 24,
    [ValidateRange(0, 10080)][int]$DurationMinutes = 0,
    [ValidateRange(1024, 65535)][int]$CdpPort = 9334,
    [string]$ProxyServer = "socks5://127.0.0.1:1080"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectDir = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $projectDir "logs\shadow-stability"
$runner = Join-Path $PSScriptRoot "run_shadow_stability_test.ps1"
$timestamp = "{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmssfff"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$durationArguments = if ($DurationMinutes -gt 0) {
    @("-DurationMinutes", $DurationMinutes)
} else {
    @("-DurationHours", $DurationHours)
}
$effectiveDurationMinutes = if ($DurationMinutes -gt 0) { $DurationMinutes } else { $DurationHours * 60 }
$displayDurationHours = [math]::Round($effectiveDurationMinutes / 60.0, 2)
$process = Start-Process -FilePath $powershell `
    -ArgumentList (@("-NoProfile", "-File", $runner) + $durationArguments + @("-CdpPort", $CdpPort, "-ProxyServer", $ProxyServer)) `
    -WorkingDirectory $projectDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logsDir "runner-$timestamp.log") `
    -RedirectStandardError (Join-Path $logsDir "runner-$timestamp.error.log") `
    -PassThru

Write-Host "A $displayDurationHours oras shadow stabilitasi teszt elindult (PID $($process.Id))." -ForegroundColor Green
Write-Host "Futasi naplo: $logsDir"
