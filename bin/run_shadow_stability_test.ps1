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
$effectiveDurationMinutes = if ($DurationMinutes -gt 0) { $DurationMinutes } else { $DurationHours * 60 }
$effectiveDurationHours = $effectiveDurationMinutes / 60.0
$effectiveDurationHoursArgument = $effectiveDurationHours.ToString([Globalization.CultureInfo]::InvariantCulture)
$runId = "{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmssfff"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$shadowDataDir = Join-Path $projectDir "data\shadow-headless\$runId"
$shadowLogsDir = Join-Path $projectDir "logs\shadow-headless\$runId"
$comparisonLogsDir = Join-Path $projectDir "logs\shadow-stability\$runId"
$shadowLiveSurebetsFile = Join-Path $shadowDataDir "football\surebets_live_odds.txt"
$headlessProfile = Join-Path $env:LOCALAPPDATA "Google\Chrome\OddsAggregatorShadow\$runId"
$instanceTitle = "oddsaggregator-shadow-headless-$runId"
$headlessStart = Join-Path $PSScriptRoot "start_headless_ab_test.ps1"
$comparator = Join-Path $projectDir "src\shadow_stability_comparator.js"
$normalDataDir = Join-Path $projectDir "data"
$normalLogsDir = Join-Path $projectDir "logs"

function Test-CommandLineFlagValue {
    param(
        [Parameter(Mandatory = $true)][string]$CommandLine,
        [Parameter(Mandatory = $true)][string]$FlagName,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $flag = [regex]::Escape("--$FlagName")
    $escapedValue = [regex]::Escape($Value)
    $alternatives = @(
        ('"{0}={1}"' -f $flag, $escapedValue),
        ('{0}="{1}"' -f $flag, $escapedValue)
    )
    if ($Value -notmatch '\s') {
        $alternatives += ('{0}={1}' -f $flag, $escapedValue)
    }
    $argumentPattern = '(?i)(?:^|\s)(?:{0})(?=\s|$)' -f ($alternatives -join '|')
    return [regex]::IsMatch($CommandLine, $argumentPattern)
}

function Stop-ShadowStack {
    $processes = @(Get-CimInstance Win32_Process)
    $normalizedProfile = [IO.Path]::GetFullPath($headlessProfile)
    $chromeIds = @($processes | Where-Object {
        $_.Name -eq "chrome.exe" -and $_.CommandLine -and
        (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "remote-debugging-port" -Value ([string]$CdpPort)) -and
        (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "user-data-dir" -Value $normalizedProfile)
    } | ForEach-Object { [int]$_.ProcessId })
    $nodeIds = @($processes | Where-Object {
        $_.Name -eq "node.exe" -and $_.CommandLine -and
        (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "title" -Value $instanceTitle)
    } | ForEach-Object { [int]$_.ProcessId })
    $ids = @($chromeIds + $nodeIds | Select-Object -Unique)
    foreach ($processId in $ids) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

New-Item -ItemType Directory -Force -Path $shadowDataDir, $shadowLogsDir, $comparisonLogsDir, (Split-Path -Parent $shadowLiveSurebetsFile) | Out-Null
Remove-Item -LiteralPath $shadowLiveSurebetsFile -Force -ErrorAction SilentlyContinue
$comparatorProcess = $null
try {
    & $headlessStart -CdpPort $CdpPort -ProxyServer $ProxyServer -DataDirectory $shadowDataDir `
        -LogsDirectory $shadowLogsDir -ChromeProfile $headlessProfile -InstanceTitle $instanceTitle `
        -RequireNewChrome
    $node = Get-Command node.exe -ErrorAction Stop
    $comparatorProcess = Start-Process -FilePath $node.Source -ArgumentList @(
        $comparator,
        "--normal-data", $normalDataDir,
        "--headless-data", $shadowDataDir,
        "--normal-logs", $normalLogsDir,
        "--headless-logs", $shadowLogsDir,
        "--output-dir", $comparisonLogsDir,
        "--duration-hours", $effectiveDurationHoursArgument
    ) -WorkingDirectory $projectDir -NoNewWindow -PassThru
    $timeoutMs = [int](($effectiveDurationMinutes * 60 + 300) * 1000)
    if (-not $comparatorProcess.WaitForExit($timeoutMs)) {
        Stop-Process -Id $comparatorProcess.Id -Force -ErrorAction SilentlyContinue
        throw "A shadow comparator nem allt le a futasi ido utan 5 percen belul."
    }
    if ($comparatorProcess.ExitCode -ne 0) { throw "A shadow comparator hibakoddal allt le: $($comparatorProcess.ExitCode)" }
} finally {
    try {
        if ($null -ne $comparatorProcess) {
            try {
                if (-not $comparatorProcess.HasExited) {
                    Stop-Process -Id $comparatorProcess.Id -Force -ErrorAction SilentlyContinue
                }
            } catch {
                # The comparator may exit between HasExited and Stop-Process.
            }
        }
    } finally {
        Stop-ShadowStack
    }
}

Write-Host "A shadow stabilitasi teszt befejezodott: $comparisonLogsDir" -ForegroundColor Green
Write-Host "Headless surebet tukor: $shadowLiveSurebetsFile" -ForegroundColor Green
