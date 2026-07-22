[CmdletBinding()]
param(
    [int]$CdpPort = 9222,
    [string]$ProxyServer = "socks5://127.0.0.1:1080",
    [switch]$SkipManager
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectDir = Split-Path -Parent $PSScriptRoot
$projectsRoot = Split-Path -Parent $projectDir
$managerDir = Join-Path $projectsRoot "SurebetManager"
$logsDir = Join-Path $projectDir "logs"
$dataDir = Join-Path $projectDir "data"
$footballDataDir = Join-Path $dataDir "football"
$cdpBaseUrl = "http://127.0.0.1:$CdpPort"
$chromeProfile = Join-Path $env:LOCALAPPDATA "Google\Chrome\Football"

$requiredPages = @(
    [pscustomobject]@{
        Name = "SharpX soccer"
        Match = "^https://sharpxch\.com/player/sport/1(?:[/?#]|$)"
        Url = "https://sharpxch.com/player/sport/1"
    },
    [pscustomobject]@{
        Name = "TippmixPro"
        Match = "^https://(?:www\.)?tippmixpro\.hu/"
        Url = "https://www.tippmixpro.hu/hu/fogadas/i"
    },
    [pscustomobject]@{
        Name = "Vegas Sports"
        Match = "^https://vegas\.hu/sports(?:[/?#]|$)"
        Url = "https://vegas.hu/sports/live"
    }
)

function Find-Chrome {
    $candidates = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return $candidate
        }
    }

    throw "Google Chrome nem talalhato."
}

function Get-CdpTargets {
    try {
        return @(Invoke-RestMethod -Uri "$cdpBaseUrl/json" -TimeoutSec 2)
    } catch {
        return @()
    }
}

function Wait-ForCdp {
    param([int]$TimeoutSeconds = 30)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $null = Invoke-RestMethod -Uri "$cdpBaseUrl/json/version" -TimeoutSec 2
            return
        } catch {
            Start-Sleep -Milliseconds 500
        }
    } while ((Get-Date) -lt $deadline)

    throw "A Chrome CDP vegpont nem erheto el: $cdpBaseUrl"
}

function Open-CdpPage {
    param([Parameter(Mandatory = $true)][string]$Url)

    $encodedUrl = [uri]::EscapeDataString($Url)
    $null = Invoke-RestMethod -Method Put -Uri "$cdpBaseUrl/json/new?$encodedUrl" -TimeoutSec 10
}

function Test-CommandLineProcess {
    param([Parameter(Mandatory = $true)][string]$Pattern)

    return $null -ne (Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and $_.CommandLine -match $Pattern
    } | Select-Object -First 1)
}

function Start-Monitor {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$ScriptName,
        [Parameter(Mandatory = $true)][string]$NodePath
    )

    $scriptPath = Join-Path $projectDir "src\$ScriptName"
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "Hianyzik a monitor: $scriptPath"
    }

    $processPattern = [regex]::Escape($scriptPath)
    if (Test-CommandLineProcess -Pattern $processPattern) {
        Write-Host "$Name mar fut; nem indul uj peldany." -ForegroundColor Yellow
        return
    }

    $baseName = [IO.Path]::GetFileNameWithoutExtension($ScriptName)
    $stdoutPath = Join-Path $logsDir "$baseName.log"
    $stderrPath = Join-Path $logsDir "$baseName.error.log"
    $process = Start-Process -FilePath $NodePath `
        -ArgumentList $scriptPath `
        -WorkingDirectory $projectDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    Write-Host "$Name elindult (PID $($process.Id))." -ForegroundColor Green
}

New-Item -ItemType Directory -Force -Path $logsDir, $dataDir, $footballDataDir | Out-Null

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "A node.exe nem talalhato a PATH valtozoban."
}
$nodePath = $nodeCommand.Source

# 1. Chrome and the CDP endpoint
$targets = Get-CdpTargets
if (@($targets).Count -eq 0) {
    $chromePath = Find-Chrome
    $chromeArgs = @(
        "--user-data-dir=$chromeProfile",
        "--proxy-server=$ProxyServer",
        "--remote-debugging-port=$CdpPort",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-allow-origins=*"
    )

    Write-Host "Chrome inditasa..." -ForegroundColor Cyan
    Start-Process -FilePath $chromePath -ArgumentList $chromeArgs
    Wait-ForCdp
} else {
    Write-Host "A Chrome CDP mar elerheto: $cdpBaseUrl" -ForegroundColor Yellow
}

# 2. Open only the required pages that are currently missing.
$targets = Get-CdpTargets
foreach ($page in $requiredPages) {
    $isOpen = $null -ne ($targets | Where-Object { $_.url -match $page.Match } | Select-Object -First 1)
    if ($isOpen) {
        Write-Host "$($page.Name) oldal mar nyitva van." -ForegroundColor DarkGray
        continue
    }

    Write-Host "$($page.Name) oldal megnyitasa..." -ForegroundColor Cyan
    Open-CdpPage -Url $page.Url
}

# Give the sites time to create their iframe and data connections.
Start-Sleep -Seconds 5

# 3. Surebet Manager GUI, wired directly to this aggregator's surebet file.
if (-not $SkipManager) {
    $managerEntry = Join-Path $managerDir "main_qt.py"
    if (-not (Test-Path -LiteralPath $managerEntry -PathType Leaf)) {
        Write-Warning "A Surebet Manager nem talalhato, ezert nem indult el: $managerEntry"
    } elseif (Test-CommandLineProcess -Pattern "(?:^|[\\/])main_qt\.py(?:\s|$)") {
        Write-Host "A Surebet Manager mar fut; nem indul uj peldany." -ForegroundColor Yellow
    } else {
        $pywCommand = Get-Command pyw.exe -ErrorAction SilentlyContinue
        if (-not $pywCommand) {
            $pywCommand = Get-Command pyw -ErrorAction SilentlyContinue
        }

        if (-not $pywCommand) {
            Write-Warning "A pyw nem talalhato, ezert a Surebet Manager nem indult el."
        } else {
            $surebetsPath = Join-Path $footballDataDir "surebets_live_odds.txt"
            $managerArgs = @(
                $managerEntry,
                "--suggestion-path",
                $surebetsPath
            )
            Start-Process -FilePath $pywCommand.Source -ArgumentList $managerArgs -WorkingDirectory $managerDir
            Write-Host "Surebet Manager elindult." -ForegroundColor Green
        }
    }
}

# 4. Collectors. The order is intentional: SharpX creates the Vegas watchlist.
Start-Monitor -Name "TippmixPro monitor" -ScriptName "tippmixpro_odds_monitor.js" -NodePath $nodePath
Start-Sleep -Seconds 1
Start-Monitor -Name "SharpX monitor" -ScriptName "sharpx_odds_monitor.js" -NodePath $nodePath
Start-Sleep -Seconds 2
Start-Monitor -Name "Vegas monitor" -ScriptName "vegas_odds_monitor.js" -NodePath $nodePath

Write-Host ""
Write-Host "Az OddsAggregator stack elindult." -ForegroundColor Green
Write-Host "Oddsok:   $(Join-Path $dataDir 'combined_odds.txt')"
Write-Host "Surebetek: $(Join-Path $footballDataDir 'surebets_live_odds.txt')"
Write-Host "Naplok:   $logsDir"
