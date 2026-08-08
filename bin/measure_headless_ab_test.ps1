[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$CdpPort = 9333,
    [ValidateRange(15, 7200)][int]$DurationSeconds = 900,
    [ValidateRange(1, 60)][int]$SampleSeconds = 5,
    [string]$DataDirectory,
    [string]$LogsDirectory,
    [string]$MonitorCommandPattern = "--title=oddsaggregator-headless-ab"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectDir = Split-Path -Parent $PSScriptRoot
if (-not $DataDirectory) { $DataDirectory = Join-Path $projectDir "data\ab-headless" }
if (-not $LogsDirectory) { $LogsDirectory = Join-Path $projectDir "logs\ab-headless" }
$timestamp = "{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmssfff"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$outputFile = Join-Path $LogsDirectory "metrics-$timestamp.csv"
$outputs = @{
    Combined = Join-Path $DataDirectory "combined_odds.txt"
    Surebets = Join-Path $DataDirectory "football\surebets_live_odds.txt"
    Tippmix = Join-Path $DataDirectory "tippmixpro_odds_snapshot.json"
    Vegas = Join-Path $DataDirectory "vegas_odds_snapshot.json"
}

function Get-DescendantProcessIds {
    param([Parameter(Mandatory = $true)][int[]]$RootIds, [Parameter(Mandatory = $true)][object[]]$Processes)

    $result = [System.Collections.Generic.List[int]]::new()
    $frontier = @($RootIds)
    while ($frontier.Count -gt 0) {
        $result.AddRange([int[]]$frontier)
        $frontier = @($Processes | Where-Object { $frontier -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
    }
    return @($result | Select-Object -Unique)
}

function Get-ProcessMetrics {
    param([int[]]$ProcessIds)
    $items = foreach ($id in $ProcessIds) { Get-Process -Id $id -ErrorAction SilentlyContinue }
    $workingSet = ($items | Measure-Object -Property WorkingSet64 -Sum).Sum
    $cpuSeconds = ($items | Measure-Object -Property CPU -Sum).Sum
    if ($null -eq $workingSet) { $workingSet = 0 }
    if ($null -eq $cpuSeconds) { $cpuSeconds = 0 }
    return [pscustomobject]@{
        Count = @($items).Count
        WorkingSetMB = [math]::Round($workingSet / 1MB, 1)
        CpuSeconds = [math]::Round($cpuSeconds, 2)
    }
}

function Get-OutputAgeSeconds {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return -1 }
    return [math]::Round(((Get-Date) - (Get-Item -LiteralPath $Path).LastWriteTime).TotalSeconds, 2)
}

New-Item -ItemType Directory -Force -Path $LogsDirectory | Out-Null
$sampleCount = [math]::Max(1, [math]::Floor($DurationSeconds / $SampleSeconds))
Write-Host "Headless A/B meres indul: $sampleCount minta, $SampleSeconds masodpercenkent." -ForegroundColor Cyan

$rows = for ($sample = 1; $sample -le $sampleCount; $sample += 1) {
    $processes = @(Get-CimInstance Win32_Process)
    $cdpArgumentPattern = '(?i)(?:^|\s)--remote-debugging-port={0}(?=\s|$)' -f [regex]::Escape([string]$CdpPort)
    $chromeRoots = @($processes | Where-Object {
        $_.Name -eq "chrome.exe" -and $_.CommandLine -match $cdpArgumentPattern
    } | ForEach-Object { [int]$_.ProcessId })
    $chrome = Get-ProcessMetrics (Get-DescendantProcessIds -RootIds $chromeRoots -Processes $processes)
    $monitorIds = @($processes | Where-Object {
        $_.Name -eq "node.exe" -and $_.CommandLine -match $MonitorCommandPattern
    } | ForEach-Object { [int]$_.ProcessId })
    $monitors = Get-ProcessMetrics $monitorIds

    [pscustomobject]@{
        Timestamp = (Get-Date).ToString("o")
        ChromeProcesses = $chrome.Count
        ChromeWorkingSetMB = $chrome.WorkingSetMB
        ChromeCpuSeconds = $chrome.CpuSeconds
        MonitorProcesses = $monitors.Count
        MonitorWorkingSetMB = $monitors.WorkingSetMB
        MonitorCpuSeconds = $monitors.CpuSeconds
        CombinedAgeSeconds = Get-OutputAgeSeconds $outputs.Combined
        SurebetsAgeSeconds = Get-OutputAgeSeconds $outputs.Surebets
        TippmixAgeSeconds = Get-OutputAgeSeconds $outputs.Tippmix
        VegasAgeSeconds = Get-OutputAgeSeconds $outputs.Vegas
    }
    if ($sample -lt $sampleCount) { Start-Sleep -Seconds $SampleSeconds }
}

$rows | Export-Csv -LiteralPath $outputFile -NoTypeInformation -Encoding utf8
$rows | Measure-Object -Property ChromeWorkingSetMB -Average -Maximum | ForEach-Object {
    Write-Host "Chrome working set: atlag $([math]::Round($_.Average, 1)) MB, maximum $([math]::Round($_.Maximum, 1)) MB."
}
Write-Host "Meresi CSV: $outputFile" -ForegroundColor Green
