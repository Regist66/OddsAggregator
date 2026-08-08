[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$CdpPort = 9333,
    [string]$ProxyServer = "socks5://127.0.0.1:1080",
    [string]$DataDirectory,
    [string]$LogsDirectory,
    [string]$ChromeProfile,
    [string]$InstanceTitle = "oddsaggregator-headless-ab",
    [switch]$RequireNewChrome
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectDir = Split-Path -Parent $PSScriptRoot
$testDataDir = if ($DataDirectory) { $DataDirectory } else { Join-Path $projectDir "data\ab-headless" }
$testFootballDataDir = Join-Path $testDataDir "football"
$testLogsDir = if ($LogsDirectory) { $LogsDirectory } else { Join-Path $projectDir "logs\ab-headless" }
$cdpBaseUrl = "http://127.0.0.1:$CdpPort"
$chromeProfile = [IO.Path]::GetFullPath($(if ($ChromeProfile) { $ChromeProfile } else { Join-Path $env:LOCALAPPDATA "Google\Chrome\OddsAggregatorHeadlessAB" }))

$requiredPages = @(
    [pscustomobject]@{ Name = "SharpX soccer"; Match = "^https://sharpxch\.com/player/sport/1(?:[/?#]|$)"; Url = "https://sharpxch.com/player/sport/1" },
    [pscustomobject]@{ Name = "TippmixPro"; Match = "^https://(?:www\.)?tippmixpro\.hu/"; Url = "https://www.tippmixpro.hu/hu/fogadas/i" },
    [pscustomobject]@{ Name = "Vegas Sports"; Match = "^https://vegas\.hu/sports(?:[/?#]|$)"; Url = "https://vegas.hu/sports/live" }
)

function Find-Chrome {
    $candidates = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    throw "Google Chrome nem talalhato."
}

function Get-CdpTargets {
    try { return @(Invoke-RestMethod -Uri "$cdpBaseUrl/json" -TimeoutSec 2) } catch { return @() }
}

function Get-CdpVersion {
    try { return Invoke-RestMethod -Uri "$cdpBaseUrl/json/version" -TimeoutSec 2 } catch { return $null }
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

function Get-PortChromeProcesses {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "chrome.exe" -and $_.CommandLine -and
        (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "remote-debugging-port" -Value ([string]$CdpPort))
    })
}

function Get-ProfileChromeProcesses {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "chrome.exe" -and $_.CommandLine -and
        (Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "user-data-dir" -Value $chromeProfile)
    })
}

function Get-OwnedChromeProcesses {
    return @(Get-PortChromeProcesses | Where-Object {
        Test-CommandLineFlagValue -CommandLine $_.CommandLine -FlagName "user-data-dir" -Value $chromeProfile
    })
}

function Wait-ForCdp {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        try {
            $null = Invoke-RestMethod -Uri "$cdpBaseUrl/json/version" -TimeoutSec 2
            return
        } catch { Start-Sleep -Milliseconds 500 }
    } while ((Get-Date) -lt $deadline)
    throw "A headless Chrome CDP vegpont nem erheto el: $cdpBaseUrl"
}

function Open-CdpPage {
    param([Parameter(Mandatory = $true)][string]$Url)
    $encodedUrl = [uri]::EscapeDataString($Url)
    $null = Invoke-RestMethod -Method Put -Uri "$cdpBaseUrl/json/new?$encodedUrl" -TimeoutSec 10
}

function Start-TestMonitor {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$ScriptName)

    $scriptPath = Join-Path $projectDir "src\$ScriptName"
    $existing = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "node.exe" -and $_.CommandLine -match [regex]::Escape("--title=$instanceTitle") -and
        $_.CommandLine -match [regex]::Escape($scriptPath)
    } | Select-Object -First 1
    if ($existing) {
        Write-Host "$Name mar fut (PID $($existing.ProcessId))." -ForegroundColor Yellow
        return
    }

    $node = Get-Command node.exe -ErrorAction Stop
    $baseName = [IO.Path]::GetFileNameWithoutExtension($ScriptName)
    $process = Start-Process -FilePath $node.Source `
        -ArgumentList "--title=$instanceTitle", $scriptPath `
        -WorkingDirectory $projectDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $testLogsDir "$baseName.log") `
        -RedirectStandardError (Join-Path $testLogsDir "$baseName.error.log") `
        -PassThru
    Write-Host "$Name elindult (PID $($process.Id))." -ForegroundColor Green
}

New-Item -ItemType Directory -Force -Path $testDataDir, $testFootballDataDir, $testLogsDir | Out-Null

$cdpVersion = Get-CdpVersion
$portChrome = @(Get-PortChromeProcesses)
$ownedChrome = @(Get-OwnedChromeProcesses)
$profileChrome = @(Get-ProfileChromeProcesses)
if ($profileChrome.Count -gt 0 -and $ownedChrome.Count -eq 0) {
    throw "A teszt Chrome-profilja mar masik CDP-porton fut (PID: $($profileChrome.ProcessId -join ', ')): $chromeProfile"
}
if ($RequireNewChrome -and ($cdpVersion -or $portChrome.Count -gt 0 -or $profileChrome.Count -gt 0)) {
    throw "A teszthez uj, izolalt Chrome-peldany szukseges, de a port vagy a profil mar hasznalatban van: $cdpBaseUrl; $chromeProfile"
}
if (-not $cdpVersion -and $portChrome.Count -eq 0) {
    $chromeArgs = @(
        "--headless=new",
        "--user-data-dir=$chromeProfile",
        "--proxy-server=$ProxyServer",
        "--remote-debugging-port=$CdpPort",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps"
    )
    Write-Host "Headless Chrome inditasa..." -ForegroundColor Cyan
    Start-Process -FilePath (Find-Chrome) -ArgumentList $chromeArgs
    Wait-ForCdp
} elseif ($ownedChrome.Count -eq 0) {
    $owners = if ($portChrome.Count -gt 0) { "Chrome PID: $($portChrome.ProcessId -join ', ')" } else { "ismeretlen folyamat" }
    throw "A $cdpBaseUrl CDP-portot nem ehhez a tesztprofilhoz tartozo folyamat hasznalja ($owners). Valassz masik portot; a teszt nem hasznalja ujra a production Chrome-ot."
} elseif (-not $cdpVersion) {
    Wait-ForCdp
} else {
    Write-Host "A sajat headless teszt-Chrome CDP mar elerheto: $cdpBaseUrl" -ForegroundColor Yellow
}

$verifiedCdpVersion = Get-CdpVersion
$verifiedOwnedChrome = @(Get-OwnedChromeProcesses)
if (-not $verifiedCdpVersion -or $verifiedOwnedChrome.Count -eq 0) {
    throw "A headless teszt-Chrome inditasa utan a CDP-port/profile ownership nem igazolhato: $cdpBaseUrl; $chromeProfile"
}

$targets = Get-CdpTargets
foreach ($page in $requiredPages) {
    if ($targets | Where-Object { $_.url -match $page.Match } | Select-Object -First 1) { continue }
    Write-Host "$($page.Name) oldal megnyitasa..." -ForegroundColor Cyan
    Open-CdpPage -Url $page.Url
}

Start-Sleep -Seconds 5

$monitorEnvironment = [ordered]@{
    SHARPX_CDP_ENDPOINT = $cdpBaseUrl
    TIPPMIXPRO_CDP_ENDPOINT = $cdpBaseUrl
    VEGAS_CDP_ENDPOINT = $cdpBaseUrl
    SHARPX_OUTPUT_FILE = (Join-Path $testDataDir "combined_odds.txt")
    SUREBETS_OUTPUT_FILE = (Join-Path $testFootballDataDir "surebets_live_odds.txt")
    SHARPX_WATCHLIST_FILE = (Join-Path $testDataDir "sharpx_watchlist.json")
    SHARPX_STATUS_SNAPSHOT_FILE = (Join-Path $testDataDir "sharpx_status_snapshot.json")
    TIPPMIXPRO_OUTPUT_FILE = (Join-Path $testDataDir "tippmixpro_odds_snapshot.json")
    VEGAS_OUTPUT_FILE = (Join-Path $testDataDir "vegas_odds_snapshot.json")
    TIPPMIXPRO_SNAPSHOT_FILE = (Join-Path $testDataDir "tippmixpro_odds_snapshot.json")
    VEGAS_SNAPSHOT_FILE = (Join-Path $testDataDir "vegas_odds_snapshot.json")
}
$previousEnvironment = @{}
foreach ($name in $monitorEnvironment.Keys) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, $monitorEnvironment[$name], "Process")
}
try {
    Start-TestMonitor -Name "TippmixPro headless monitor" -ScriptName "tippmixpro_odds_monitor.js"
    Start-Sleep -Seconds 1
    Start-TestMonitor -Name "SharpX headless monitor" -ScriptName "sharpx_odds_monitor.js"
    Start-Sleep -Seconds 2
    Start-TestMonitor -Name "Vegas headless monitor" -ScriptName "vegas_odds_monitor.js"
} finally {
    foreach ($name in $monitorEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
    }
}

Write-Host ""
Write-Host "A headless A/B stack elindult." -ForegroundColor Green
Write-Host "Meres: .\bin\measure_headless_ab_test.ps1"
Write-Host "Kimenetek: $testDataDir"
Write-Host "Naplok: $testLogsDir"
