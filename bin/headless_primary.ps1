[CmdletBinding()]
param(
    [ValidateSet("Start", "Status", "Watch", "Stop", "Restart")]
    [string]$Action = "Status",
    [ValidateRange(1024, 65535)]
    [int]$CdpPort = 9333,
    [string]$ProxyServer = "socks5://127.0.0.1:1080",
    [string]$ChromeProfile,
    [switch]$SkipManager,
    [ValidateRange(1, 60)]
    [int]$RefreshSeconds = 2
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectDir = Split-Path -Parent $PSScriptRoot
$projectsRoot = Split-Path -Parent $projectDir
$dataDir = Join-Path $projectDir "data"
$footballDataDir = Join-Path $dataDir "football"
$logsDir = Join-Path $projectDir "logs\headless-primary"
$stateDir = Join-Path $dataDir "headless-primary"
$stateFile = Join-Path $stateDir "instance.json"
$managerDir = Join-Path $projectsRoot "SurebetManager"
$instanceTitle = "oddsaggregator-headless-primary"
$cdpBaseUrl = "http://127.0.0.1:$CdpPort"
$chromeProfilePath = if ($ChromeProfile) {
    [IO.Path]::GetFullPath($ChromeProfile)
} else {
    Join-Path $env:LOCALAPPDATA "Google\Chrome\OddsAggregatorHeadlessPrimary"
}

$requiredPages = @(
    [pscustomobject]@{ Name = "SharpX"; Match = "^https://sharpxch\.com/player/sport/1(?:[/?#]|$)"; Url = "https://sharpxch.com/player/sport/1" },
    [pscustomobject]@{ Name = "TippmixPro"; Match = "^https://(?:www\.)?tippmixpro\.hu/"; Url = "https://www.tippmixpro.hu/hu/fogadas/i" },
    [pscustomobject]@{ Name = "Vegas"; Match = "^https://vegas\.hu/sports(?:[/?#]|$)"; Url = "https://vegas.hu/sports/live" }
)

$monitorDefinitions = @(
    [pscustomobject]@{ Name = "TippmixPro"; Script = "tippmixpro_odds_monitor.js" },
    [pscustomobject]@{ Name = "SharpX"; Script = "sharpx_odds_monitor.js" },
    [pscustomobject]@{ Name = "Vegas"; Script = "vegas_odds_monitor.js" }
)

$outputFiles = @(
    [pscustomobject]@{ Name = "Kozos oddslista"; Path = (Join-Path $dataDir "combined_odds.txt") },
    [pscustomobject]@{ Name = "Surebetek"; Path = (Join-Path $footballDataDir "surebets_live_odds.txt") },
    [pscustomobject]@{ Name = "SharpX statusz"; Path = (Join-Path $dataDir "sharpx_status_snapshot.json") },
    [pscustomobject]@{ Name = "TippmixPro snapshot"; Path = (Join-Path $dataDir "tippmixpro_odds_snapshot.json") },
    [pscustomobject]@{ Name = "Vegas snapshot"; Path = (Join-Path $dataDir "vegas_odds_snapshot.json") }
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

function Get-Processes {
    try {
        return @(Get-CimInstance Win32_Process -ErrorAction Stop)
    } catch {
        throw "A folyamatlista nem kerdezheto le: $($_.Exception.Message)"
    }
}

function Get-PrimaryMonitorProcesses {
    $titlePattern = [regex]::Escape("--title=$instanceTitle")
    return @(Get-Processes | Where-Object {
        $_.Name -eq "node.exe" -and $_.CommandLine -and $_.CommandLine -match $titlePattern -and
        $_.CommandLine -match [regex]::Escape((Join-Path $projectDir "src"))
    })
}

function Get-ConflictingMonitorProcesses {
    # Match the script basename too: manually started monitors often use a
    # relative path, but they still write the same canonical files.
    $scriptPatterns = $monitorDefinitions | ForEach-Object { [regex]::Escape($_.Script) }
    $primaryTitlePattern = [regex]::Escape("--title=$instanceTitle")
    return @(Get-Processes | Where-Object {
        if ($_.Name -ne "node.exe" -or -not $_.CommandLine -or $_.CommandLine -match $primaryTitlePattern) {
            return $false
        }
        $commandLine = $_.CommandLine
        return $null -ne ($scriptPatterns | Where-Object { $commandLine -match $_ } | Select-Object -First 1)
    })
}

function Get-PrimaryChromeProcesses {
    $portPattern = [regex]::Escape("--remote-debugging-port=$CdpPort")
    $profilePattern = [regex]::Escape("--user-data-dir=$chromeProfilePath")
    return @(Get-Processes | Where-Object {
        $_.Name -eq "chrome.exe" -and $_.CommandLine -and $_.CommandLine -match $portPattern -and $_.CommandLine -match $profilePattern
    })
}

function Get-CdpVersion {
    try {
        return Invoke-RestMethod -Uri "$cdpBaseUrl/json/version" -TimeoutSec 2
    } catch {
        return $null
    }
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
        if (Get-CdpVersion) { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw "A headless Chrome CDP vegpont nem erheto el: $cdpBaseUrl"
}

function Open-CdpPage {
    param([Parameter(Mandatory = $true)][string]$Url)

    $encodedUrl = [uri]::EscapeDataString($Url)
    $null = Invoke-RestMethod -Method Put -Uri "$cdpBaseUrl/json/new?$encodedUrl" -TimeoutSec 10
}

function Set-MonitorEnvironment {
    $env:SHARPX_CDP_ENDPOINT = $cdpBaseUrl
    $env:TIPPMIXPRO_CDP_ENDPOINT = $cdpBaseUrl
    $env:VEGAS_CDP_ENDPOINT = $cdpBaseUrl
    $env:SHARPX_OUTPUT_FILE = Join-Path $dataDir "combined_odds.txt"
    $env:SUREBETS_OUTPUT_FILE = Join-Path $footballDataDir "surebets_live_odds.txt"
    $env:SHARPX_WATCHLIST_FILE = Join-Path $dataDir "sharpx_watchlist.json"
    $env:SHARPX_STATUS_SNAPSHOT_FILE = Join-Path $dataDir "sharpx_status_snapshot.json"
    $env:TIPPMIXPRO_OUTPUT_FILE = Join-Path $dataDir "tippmixpro_odds_snapshot.json"
    $env:VEGAS_OUTPUT_FILE = Join-Path $dataDir "vegas_odds_snapshot.json"
    $env:TIPPMIXPRO_SNAPSHOT_FILE = $env:TIPPMIXPRO_OUTPUT_FILE
    $env:VEGAS_SNAPSHOT_FILE = $env:VEGAS_OUTPUT_FILE
}

function Start-PrimaryMonitor {
    param([Parameter(Mandatory = $true)][pscustomobject]$Definition, [Parameter(Mandatory = $true)][string]$NodePath)

    $scriptPath = Join-Path $projectDir "src\$($Definition.Script)"
    $existing = Get-PrimaryMonitorProcesses | Where-Object {
        $_.CommandLine -match [regex]::Escape($scriptPath)
    } | Select-Object -First 1
    if ($existing) {
        Write-Host "$($Definition.Name) mar fut (PID $($existing.ProcessId))." -ForegroundColor Yellow
        return $existing.ProcessId
    }

    $baseName = [IO.Path]::GetFileNameWithoutExtension($Definition.Script)
    $process = Start-Process -FilePath $NodePath `
        -ArgumentList "--title=$instanceTitle", $scriptPath `
        -WorkingDirectory $projectDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logsDir "$baseName.log") `
        -RedirectStandardError (Join-Path $logsDir "$baseName.error.log") `
        -PassThru
    Write-Host "$($Definition.Name) monitor elindult (PID $($process.Id))." -ForegroundColor Green
    return $process.Id
}

function Start-SurebetManager {
    if ($SkipManager) { return }

    $managerEntry = Join-Path $managerDir "main_qt.py"
    if (-not (Test-Path -LiteralPath $managerEntry -PathType Leaf)) {
        Write-Warning "A Surebet Manager nem talalhato: $managerEntry"
        return
    }

    $managerRunning = Get-Processes | Where-Object {
        $_.CommandLine -and $_.CommandLine -match "(?:^|[\\/])main_qt\.py(?:\s|$)"
    } | Select-Object -First 1
    if ($managerRunning) {
        Write-Host "A Surebet Manager mar fut (PID $($managerRunning.ProcessId))." -ForegroundColor Yellow
        return
    }

    $pyw = Get-Command pyw.exe -ErrorAction SilentlyContinue
    if (-not $pyw) { $pyw = Get-Command pyw -ErrorAction SilentlyContinue }
    if (-not $pyw) {
        Write-Warning "A pyw nem talalhato, ezert a Surebet Manager nem indult el."
        return
    }

    $surebetsPath = Join-Path $footballDataDir "surebets_live_odds.txt"
    Start-Process -FilePath $pyw.Source -ArgumentList $managerEntry, "--suggestion-path", $surebetsPath -WorkingDirectory $managerDir
    Write-Host "A Surebet Manager elindult." -ForegroundColor Green
}

function Write-State {
    param([int[]]$MonitorPids, [Nullable[int]]$ChromePid)

    $state = [ordered]@{
        instanceTitle = $instanceTitle
        startedAt = (Get-Date).ToUniversalTime().ToString("o")
        cdpEndpoint = $cdpBaseUrl
        chromeProfile = $chromeProfilePath
        chromePid = $ChromePid
        monitorPids = @($MonitorPids)
        outputs = @($outputFiles | ForEach-Object { $_.Path })
    }
    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stateFile -Encoding utf8
}

function Start-PrimaryStack {
    $conflictingProcesses = @(Get-ConflictingMonitorProcesses)
    if ($conflictingProcesses.Count -gt 0) {
        $pids = ($conflictingProcesses.ProcessId -join ", ")
        throw "Mas OddsAggregator monitorok meg futnak (PID: $pids). A primary inditas elott allitsd le oket, hogy ne legyen parhuzamos adatgyujtes vagy kanonikus kimeneti utkozes."
    }

    New-Item -ItemType Directory -Force -Path $dataDir, $footballDataDir, $logsDir, $stateDir | Out-Null
    $chromePid = $null
    $cdp = Get-CdpVersion
    if (-not $cdp) {
        $chromeArgs = @(
            "--headless=new",
            "--user-data-dir=$chromeProfilePath",
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
        $chrome = Start-Process -FilePath (Find-Chrome) `
            -ArgumentList $chromeArgs `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logsDir "chrome.log") `
            -RedirectStandardError (Join-Path $logsDir "chrome.error.log") `
            -PassThru
        $chromePid = $chrome.Id
        Wait-ForCdp
    } elseif (@(Get-PrimaryChromeProcesses).Count -eq 0) {
        throw "A $cdpBaseUrl CDP-portot egy nem ehhez a headless primary peldanyhoz tartozo Chrome hasznalja. Valassz masik portot vagy allitsd le azt a peldanyt."
    } else {
        Write-Host "A headless primary Chrome mar elerheto: $cdpBaseUrl" -ForegroundColor Yellow
        $chromePid = (Get-PrimaryChromeProcesses | Select-Object -First 1).ProcessId
    }

    $targets = Get-CdpTargets
    foreach ($page in $requiredPages) {
        if ($targets | Where-Object { $_.url -match $page.Match } | Select-Object -First 1) { continue }
        Write-Host "$($page.Name) oldal megnyitasa..." -ForegroundColor Cyan
        Open-CdpPage -Url $page.Url
    }

    Start-Sleep -Seconds 5
    $node = Get-Command node.exe -ErrorAction Stop
    $monitorPids = @()
    $monitorEnvironmentNames = @(
        "SHARPX_CDP_ENDPOINT", "TIPPMIXPRO_CDP_ENDPOINT", "VEGAS_CDP_ENDPOINT",
        "SHARPX_OUTPUT_FILE", "SUREBETS_OUTPUT_FILE", "SHARPX_WATCHLIST_FILE",
        "SHARPX_STATUS_SNAPSHOT_FILE", "TIPPMIXPRO_OUTPUT_FILE", "VEGAS_OUTPUT_FILE",
        "TIPPMIXPRO_SNAPSHOT_FILE", "VEGAS_SNAPSHOT_FILE"
    )
    $previousEnvironment = @{}
    foreach ($name in $monitorEnvironmentNames) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }
    try {
        Set-MonitorEnvironment
        foreach ($definition in $monitorDefinitions) {
            $monitorPids += Start-PrimaryMonitor -Definition $definition -NodePath $node.Source
            Start-Sleep -Seconds 1
        }
    } finally {
        foreach ($name in $monitorEnvironmentNames) {
            [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
        }
    }
    Start-SurebetManager
    Write-State -MonitorPids $monitorPids -ChromePid $chromePid

    Write-Host ""
    Write-Host "A headless elsodleges stack elindult." -ForegroundColor Green
    Write-Host "Allapot: & .\bin\headless_primary.ps1 Status"
    Write-Host "Elo nezet: & .\bin\headless_primary.ps1 Watch"
}

function Get-FileHealth {
    param([Parameter(Mandatory = $true)][pscustomobject]$Output)

    if (-not (Test-Path -LiteralPath $Output.Path -PathType Leaf)) {
        return [pscustomobject]@{ Kimenet = $Output.Name; KorMasodperc = $null; Allapot = "hianyzik" }
    }
    $age = [math]::Round(((Get-Date) - (Get-Item -LiteralPath $Output.Path).LastWriteTime).TotalSeconds, 1)
    $state = if ($age -le 10) { "friss" } elseif ($age -le 30) { "kesik" } else { "elavult" }
    return [pscustomobject]@{ Kimenet = $Output.Name; KorMasodperc = $age; Allapot = $state }
}

function Show-PrimaryStatus {
    $cdp = Get-CdpVersion
    $targets = Get-CdpTargets
    $primaryChrome = @(Get-PrimaryChromeProcesses)
    $primaryMonitors = @(Get-PrimaryMonitorProcesses)
    $conflictingMonitors = @(Get-ConflictingMonitorProcesses)

    $cdpState = if ($cdp) { "elerheto" } else { "nem erheto el" }
    Write-Host "Headless elsodleges stack - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
    Write-Host "CDP: $cdpBaseUrl | $cdpState | Chrome-fofolyamat: $($primaryChrome.Count)"
    $pageStates = $requiredPages | ForEach-Object {
        $page = $_
        [pscustomobject]@{ Oldal = $page.Name; Nyitva = [bool]($targets | Where-Object { $_.url -match $page.Match } | Select-Object -First 1) }
    }
    $pageStates | Format-Table -AutoSize | Out-Host

    $monitorStates = $monitorDefinitions | ForEach-Object {
        $scriptPath = Join-Path $projectDir "src\$($_.Script)"
        $process = $primaryMonitors | Where-Object { $_.CommandLine -match [regex]::Escape($scriptPath) } | Select-Object -First 1
        [pscustomobject]@{
            Monitor = $_.Name
            Allapot = if ($process) { "fut" } else { "nem fut" }
            PID = if ($process) { $process.ProcessId } else { $null }
        }
    }
    $monitorStates | Format-Table -AutoSize | Out-Host

    $outputFiles | ForEach-Object { Get-FileHealth -Output $_ } | Format-Table -AutoSize | Out-Host

    $errorLogs = Get-ChildItem -LiteralPath $logsDir -Filter "*.error.log" -File -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{ Naplo = $_.Name; MeretKB = [math]::Round($_.Length / 1KB, 1); Modositva = $_.LastWriteTime.ToString("HH:mm:ss") }
    }
    if ($errorLogs) {
        Write-Host "Hibanaplok:" -ForegroundColor Yellow
        $errorLogs | Format-Table -AutoSize | Out-Host
    }
    if ($conflictingMonitors.Count -gt 0) {
        Write-Warning "Mas OddsAggregator monitor is fut: PID $($conflictingMonitors.ProcessId -join ', '). Ez utkozhet a kanonikus kimenetekkel."
    }
}

function Stop-PrimaryStack {
    $monitors = Get-PrimaryMonitorProcesses
    foreach ($process in $monitors) {
        Write-Host "Monitor leallitasa: PID $($process.ProcessId)" -ForegroundColor Yellow
        Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    }

    $chromeProcesses = Get-PrimaryChromeProcesses
    foreach ($process in $chromeProcesses) {
        Write-Host "Headless Chrome leallitasa: PID $($process.ProcessId)" -ForegroundColor Yellow
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
        Remove-Item -LiteralPath $stateFile -Force
    }
    Write-Host "A headless elsodleges monitorok es sajat Chrome-peldanya leallt." -ForegroundColor Green
    Write-Host "A Surebet Manager szandekosan futva maradt; az ablak bezarasaval allithato le."
}

switch ($Action) {
    "Start" { Start-PrimaryStack }
    "Status" { Show-PrimaryStatus }
    "Watch" {
        while ($true) {
            Write-Host ""
            Write-Host ("----- Frissites: {0} -----" -f (Get-Date -Format "HH:mm:ss")) -ForegroundColor DarkGray
            Show-PrimaryStatus
            Write-Host "Frissites $RefreshSeconds masodpercenkent. Kilepes: Ctrl+C" -ForegroundColor DarkGray
            Start-Sleep -Seconds $RefreshSeconds
        }
    }
    "Stop" { Stop-PrimaryStack }
    "Restart" {
        Stop-PrimaryStack
        Start-Sleep -Seconds 2
        Start-PrimaryStack
    }
}
