[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$NormalMeasurementProcessId,
    [ValidateRange(60, 7200)][int]$DurationSeconds = 900,
    [ValidateRange(1, 60)][int]$SampleSeconds = 5
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectDir = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $projectDir "logs\resource-ab"
$measurementScript = Join-Path $PSScriptRoot "measure_headless_ab_test.ps1"
$headlessStartScript = Join-Path $PSScriptRoot "start_headless_ab_test.ps1"
$normalStartScript = Join-Path $PSScriptRoot "start_stack.ps1"
$runLog = Join-Path $logsDir "run.log"
$runId = "{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmssfff"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$normalCdpPort = 9222
$normalInstanceTitle = "oddsaggregator-production-gui-$normalCdpPort"
$normalChromeProfile = Join-Path $env:LOCALAPPDATA "Google\Chrome\Football"
$headlessCdpPort = 9333
$headlessInstanceTitle = "oddsaggregator-headless-ab-clean-$runId"
$headlessProfile = Join-Path $env:LOCALAPPDATA "Google\Chrome\OddsAggregatorHeadlessAB\$runId"
$headlessDataDir = Join-Path $projectDir "data\ab-headless\$runId"
$headlessLogsDir = Join-Path $projectDir "logs\ab-headless\$runId"
$headlessMeasurementLogsDir = Join-Path $projectDir "logs\resource-headless-clean\$runId"

function Write-RunLog {
    param([string]$Message)
    $line = "$(Get-Date -Format 'o') $Message"
    Add-Content -LiteralPath $runLog -Value $line -Encoding utf8
    Write-Host $line
}

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

function Get-StackProcesses {
    param(
        [Parameter(Mandatory = $true)][int]$CdpPort,
        [Parameter(Mandatory = $true)][string]$NodeTitle,
        [Parameter(Mandatory = $true)][string]$ChromeProfile
    )

    $processes = @(Get-CimInstance Win32_Process)
    $normalizedProfile = [IO.Path]::GetFullPath($ChromeProfile)
    return @($processes | Where-Object {
        $_.Name -eq "chrome.exe" -and $_.CommandLine -and
        (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "remote-debugging-port" -Value ([string]$CdpPort)) -and
        (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "user-data-dir" -Value $normalizedProfile)
    } | ForEach-Object { $_ }) + @($processes | Where-Object {
        $_.Name -eq "node.exe" -and $_.CommandLine -and
        (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "title" -Value $NodeTitle)
    } | ForEach-Object { $_ }) | Select-Object -Unique -Property ProcessId, Name, CommandLine, CreationDate
}

function Get-HeadlessRunProcesses {
    return @(Get-StackProcesses -CdpPort $headlessCdpPort -NodeTitle $headlessInstanceTitle -ChromeProfile $headlessProfile)
}

function Stop-ProcessIds {
    param([int[]]$ProcessIds, [string]$Description)

    $uniqueIds = @($ProcessIds | Where-Object { $_ -gt 0 } | Select-Object -Unique)
    if ($uniqueIds.Count -eq 0) { return }
    try {
        Write-RunLog "Leallitas ($Description): PID=$($uniqueIds -join ',')"
    } catch {
        Write-Warning "A leallitasi naplo nem irhato: $($_.Exception.Message)"
    }
    foreach ($processId in $uniqueIds) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-OwnedProcesses {
    param([object[]]$ProcessIdentities, [string]$Description)

    $validatedIds = @()
    foreach ($identity in @($ProcessIdentities)) {
        $processId = [int]$identity.ProcessId
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
        if ($null -eq $current) { continue }
        if ($current.Name -ne $identity.Name -or
            $current.CommandLine -ne $identity.CommandLine -or
            $current.CreationDate -ne $identity.CreationDate) {
            Write-Warning "PID $processId mar nem a futashoz tartozo folyamat; leallitas kihagyva."
            continue
        }
        $validatedIds += $processId
    }
    Stop-ProcessIds -ProcessIds $validatedIds -Description $Description
}

function Stop-Stack {
    param(
        [Parameter(Mandatory = $true)][int]$CdpPort,
        [Parameter(Mandatory = $true)][string]$NodeTitle,
        [Parameter(Mandatory = $true)][string]$ChromeProfile,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $ids = @(Get-StackProcesses -CdpPort $CdpPort -NodeTitle $NodeTitle -ChromeProfile $ChromeProfile |
        ForEach-Object { [int]$_.ProcessId })
    Stop-ProcessIds -ProcessIds $ids -Description $Description
}

function Test-LocalTcpPort {
    param([Parameter(Mandatory = $true)][int]$CdpPort)

    $client = New-Object System.Net.Sockets.TcpClient
    $asyncResult = $null
    try {
        $asyncResult = $client.BeginConnect("127.0.0.1", $CdpPort, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($asyncResult)
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $asyncResult) { $asyncResult.AsyncWaitHandle.Close() }
        $client.Close()
    }
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
Write-RunLog "Varakozas a normal baseline-re (PID $NormalMeasurementProcessId)."
while (Get-Process -Id $NormalMeasurementProcessId -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 5
}

$preflightProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "chrome.exe" -and $_.CommandLine -and
        (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "remote-debugging-port" -Value ([string]$headlessCdpPort))) -or
    ($_.Name -eq "node.exe" -and $_.CommandLine -and
        (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "title" -Value "oddsaggregator-headless-ab"))
})
$unexpectedMonitorProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    if ($_.Name -ne "node.exe" -or -not $_.CommandLine) { return $false }
    $isOddsMonitor = $_.CommandLine -match '(?i)(?:sharpx|tippmixpro|vegas)_odds_monitor\.js(?=["''\s]|$)'
    return $isOddsMonitor -and -not (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "title" -Value $normalInstanceTitle)
})
if ($unexpectedMonitorProcesses.Count -gt 0) {
    throw "A tiszta A/B teszt csak a sajat grafikus production stackbol indithato. Mas monitor fut (PID: $($unexpectedMonitorProcesses.ProcessId -join ',')). A normal stack valtozatlan maradt."
}
if ($preflightProcesses.Count -gt 0 -or (Test-LocalTcpPort -CdpPort $headlessCdpPort)) {
    $owners = if ($preflightProcesses.Count -gt 0) { $preflightProcesses.ProcessId -join "," } else { "ismeretlen CDP-tulajdonos" }
    throw "A tiszta A/B teszt nem indithato: a $headlessCdpPort port vagy egy korabbi A/B stack mar hasznalatban van (PID: $owners). A normal stack valtozatlan maradt."
}

$headlessRunProcesses = @()
$normalNeedsRestore = $false
try {
    Write-RunLog "Normal baseline kesz; normal stack leallitasa."
    Stop-Stack -CdpPort $normalCdpPort -NodeTitle $normalInstanceTitle `
        -ChromeProfile $normalChromeProfile -Description "normal stack"
    $normalNeedsRestore = $true
    Start-Sleep -Seconds 3

    Write-RunLog "Izolalt headless stack inditasa."
    try {
        & $headlessStartScript -CdpPort $headlessCdpPort -DataDirectory $headlessDataDir `
            -LogsDirectory $headlessLogsDir -ChromeProfile $headlessProfile `
            -InstanceTitle $headlessInstanceTitle -RequireNewChrome
    } finally {
        $headlessRunProcesses = @(Get-HeadlessRunProcesses)
    }
    Write-RunLog "Izolalt headless meres inditasa."
    & $measurementScript -CdpPort $headlessCdpPort -DurationSeconds $DurationSeconds -SampleSeconds $SampleSeconds `
        -DataDirectory $headlessDataDir -LogsDirectory $headlessMeasurementLogsDir `
        -MonitorCommandPattern ([regex]::Escape("--title=$headlessInstanceTitle"))
    Write-RunLog "Headless meres kesz."
} finally {
    try {
        Write-RunLog "A futashoz tartozo headless stack leallitasa."
        Stop-OwnedProcesses -ProcessIdentities $headlessRunProcesses -Description "headless A/B $runId"
    } finally {
        if ($normalNeedsRestore) {
            & $normalStartScript
            Write-RunLog "Normal stack visszaallt."
        }
    }
}
