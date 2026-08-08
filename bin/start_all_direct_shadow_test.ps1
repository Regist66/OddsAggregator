[CmdletBinding()]
param(
    [ValidateRange(1, 24)][int]$DurationHours = 2,
    [ValidateRange(0, 1440)][int]$DurationMinutes = 0,
    [ValidateSet("PiaDocker", "Host")][string]$DirectNetwork = "PiaDocker",
    [string]$PiaContainerName = "pia-gluetun",
    [string]$NodeImage = "node:24.18.0-bookworm-slim"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectDir = Split-Path -Parent $PSScriptRoot
$effectiveDurationMinutes = if ($DurationMinutes -gt 0) { $DurationMinutes } else { $DurationHours * 60 }
$runId = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
$dataDir = Join-Path $projectDir "data\all-direct-shadow\$runId"
$logsDir = Join-Path $projectDir "logs\all-direct-shadow\$runId"
$comparisonDir = Join-Path $logsDir "comparison"
$manifestFile = Join-Path $logsDir "run-manifest.json"
New-Item -ItemType Directory -Force -Path $dataDir, $logsDir, $comparisonDir | Out-Null

$script:runStartedAt = [DateTimeOffset]::UtcNow
$script:runDeadline = $script:runStartedAt.AddMinutes($effectiveDurationMinutes)
$script:readyAt = $null
$script:cleanupCompletedAt = $null
$script:docker = $null
$script:cleanupStack = @()
$script:processEntries = @()
$script:containerEntries = @()
$script:outputEntries = @()

function Write-RunManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [string]$Failure = ""
    )
    $manifest = [ordered]@{
        schemaVersion = 1
        runId = $runId
        launcher = "start_all_direct_shadow_test.ps1"
        status = $Status
        failure = if ($Failure) { $Failure } else { $null }
        directNetwork = $DirectNetwork
        piaContainerName = if ($DirectNetwork -eq "PiaDocker") { $PiaContainerName } else { $null }
        nodeImage = if ($DirectNetwork -eq "PiaDocker") { $NodeImage } else { $null }
        durationMinutes = $effectiveDurationMinutes
        startedAt = $script:runStartedAt.ToString("o")
        deadlineAt = $script:runDeadline.ToString("o")
        deadlineUnixMs = $script:runDeadline.ToUnixTimeMilliseconds()
        readyAt = if ($script:readyAt) { $script:readyAt.ToString("o") } else { $null }
        cleanupCompletedAt = if ($script:cleanupCompletedAt) { $script:cleanupCompletedAt.ToString("o") } else { $null }
        dataDir = $dataDir
        logsDir = $logsDir
        comparisonDir = $comparisonDir
        outputs = @($script:outputEntries)
        processes = @($script:processEntries)
        containers = @($script:containerEntries)
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestFile -Encoding UTF8
}

function Add-TrackedProcess {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$StandardOutput = "",
        [string]$StandardError = ""
    )
    $processStartedAt = [DateTime]::UtcNow.ToString("o")
    try { $processStartedAt = $Process.StartTime.ToUniversalTime().ToString("o") } catch { }
    $script:cleanupStack += [pscustomobject]@{ Kind = "Process"; Handle = $Process; Name = $Name }
    $script:processEntries += [pscustomobject]@{
        role = $Role
        name = $Name
        pid = $Process.Id
        startedAt = $processStartedAt
        standardOutput = if ($StandardOutput) { $StandardOutput } else { $null }
        standardError = if ($StandardError) { $StandardError } else { $null }
    }
    Write-RunManifest -Status "starting"
}

function Add-TrackedContainer {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Role
    )
    $cleanupId = if ($Id) { $Id } else { $Name }
    $script:cleanupStack += [pscustomobject]@{ Kind = "Container"; Name = $Name; Id = $cleanupId }
    if (-not $Id) { throw "A Docker collector nem adott vissza container ID-t: $Name" }
    $script:containerEntries += [pscustomobject]@{
        role = $Role
        name = $Name
        id = $Id
        startedAt = [DateTime]::UtcNow.ToString("o")
    }
    Write-RunManifest -Status "starting"
}

function Get-RemainingDurationHours {
    $remaining = $script:runDeadline - [DateTimeOffset]::UtcNow
    if ($remaining.TotalMilliseconds -le 1000) {
        throw "A kozos futasi deadline elerkezett a startup befejezese elott."
    }
    return $remaining.TotalHours.ToString("0.########", [Globalization.CultureInfo]::InvariantCulture)
}

function Test-ReadyOutput {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
        $item = Get-Item -LiteralPath $Path -ErrorAction Stop
        if ($item.LastWriteTimeUtc -lt $script:runStartedAt.UtcDateTime) { return $false }
        $document = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        return $null -ne $document
    } catch {
        return $false
    }
}

function Assert-CollectorAlive {
    param([Parameter(Mandatory = $true)]$Collector)
    if ($Collector.Mode -eq "Host") {
        if ($Collector.Process.HasExited) {
            throw "$($Collector.Name) collector kilepett a readiness elott (exit=$($Collector.Process.ExitCode))."
        }
        return
    }

    $runningOutput = & $script:docker inspect --format "{{.State.Running}}" $Collector.ContainerName 2>$null
    $inspectExitCode = $LASTEXITCODE
    $running = (@($runningOutput) -join "").Trim()
    if ($inspectExitCode -ne 0 -or $running -ne "true") {
        throw "$($Collector.Name) collector kontenere nem fut a readiness ellenorzeskor."
    }
    if ($null -ne $Collector.LogFollower -and $Collector.LogFollower.HasExited) {
        throw "$($Collector.Name) docker log follower kilepett (exit=$($Collector.LogFollower.ExitCode))."
    }
}

function Wait-CollectorReadiness {
    param([Parameter(Mandatory = $true)][array]$Collectors)
    $readinessDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
    while ($true) {
        $pending = @()
        foreach ($collectorState in $Collectors) {
            Assert-CollectorAlive -Collector $collectorState
            if (-not (Test-ReadyOutput -Path $collectorState.Output)) {
                $pending += $collectorState.Name
            }
        }
        if ($pending.Count -eq 0) { return }
        $now = [DateTimeOffset]::UtcNow
        if ($now -ge $readinessDeadline -or $now -ge $script:runDeadline) {
            throw "A collector readiness 60 masodpercen belul nem teljesult: $($pending -join ', ')."
        }
        Start-Sleep -Milliseconds 500
    }
}

function Invoke-StartupCleanup {
    for ($index = $script:cleanupStack.Count - 1; $index -ge 0; $index -= 1) {
        $resource = $script:cleanupStack[$index]
        if ($resource.Kind -eq "Process") {
            try {
                if (-not $resource.Handle.HasExited) {
                    Stop-Process -Id $resource.Handle.Id -Force -ErrorAction Stop
                    $null = $resource.Handle.WaitForExit(5000)
                }
            } catch { }
            continue
        }
        if ($resource.Kind -eq "Container" -and $null -ne $script:docker) {
            try { $null = & $script:docker rm --force $resource.Id 2>$null } catch { }
        }
    }
}

$collectors = @(
    [pscustomobject]@{ Name = "SharpX"; Script = "sharpx_direct_shadow.js"; OutputName = "sharpx_status_snapshot.json" },
    [pscustomobject]@{ Name = "Vegas"; Script = "vegas_direct_shadow.js"; OutputName = "vegas_odds_snapshot.json" },
    [pscustomobject]@{ Name = "TippmixPro"; Script = "tippmixpro_direct_shadow.js"; OutputName = "tippmixpro_odds_snapshot.json" }
)
foreach ($collector in $collectors) {
    $script:outputEntries += [pscustomobject]@{
        provider = $collector.Name
        path = Join-Path $dataDir $collector.OutputName
    }
}
Write-RunManifest -Status "starting"

try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    if ($DirectNetwork -eq "PiaDocker") {
        $script:docker = (Get-Command docker.exe -ErrorAction Stop).Source
        $piaRunningOutput = & $script:docker inspect --format "{{.State.Running}}" $PiaContainerName 2>$null
        $piaInspectExitCode = $LASTEXITCODE
        $piaRunning = (@($piaRunningOutput) -join "").Trim()
        if ($piaInspectExitCode -ne 0 -or $piaRunning -ne "true") {
            throw "A '$PiaContainerName' Docker-kontener nem fut."
        }
    }

    $collectorStates = @()
    foreach ($collector in $collectors) {
        $scriptPath = Join-Path $projectDir "src\$($collector.Script)"
        $output = Join-Path $dataDir $collector.OutputName
        $stdoutLog = Join-Path $logsDir "$($collector.Name).log"
        $stderrLog = Join-Path $logsDir "$($collector.Name).error.log"
        $remainingHours = Get-RemainingDurationHours

        if ($DirectNetwork -eq "Host") {
            $collectorArguments = @("--title=oddsaggregator-all-direct-shadow", $scriptPath, "--output-file", $output, "--duration-hours", $remainingHours)
            if ($collector.Name -eq "Vegas") {
                $collectorArguments += @("--watchlist-file", (Join-Path $dataDir "sharpx_status_snapshot.json"))
            }
            $collectorProcess = Start-Process -FilePath $node -ArgumentList $collectorArguments -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
            Add-TrackedProcess -Process $collectorProcess -Role "collector" -Name $collector.Name -StandardOutput $stdoutLog -StandardError $stderrLog
            $collectorStates += [pscustomobject]@{
                Name = $collector.Name
                Mode = "Host"
                Output = $output
                Process = $collectorProcess
                ContainerName = $null
                LogFollower = $null
            }
            continue
        }

        $containerName = "oddsaggregator-direct-$runId-$($collector.Name.ToLowerInvariant())"
        $containerOutput = "/app/data/all-direct-shadow/$runId/$($collector.OutputName)"
        $mount = "type=bind,src=$projectDir,dst=/app"
        $dockerArgs = @(
            "run", "--detach", "--rm", "--name", $containerName,
            "--network", "container:$PiaContainerName",
            "--mount", $mount,
            "--workdir", "/app",
            $NodeImage,
            "node", "--title=oddsaggregator-all-direct-shadow",
            "src/$($collector.Script)",
            "--output-file", $containerOutput,
            "--duration-hours", $remainingHours
        )
        if ($collector.Name -eq "Vegas") {
            $dockerArgs += @("--watchlist-file", "/app/data/all-direct-shadow/$runId/sharpx_status_snapshot.json")
        }
        $containerOutputText = & $script:docker @dockerArgs
        if ($LASTEXITCODE -ne 0) { throw "A $($collector.Name) PIA Docker-collector inditasa sikertelen." }
        $containerId = (@($containerOutputText) -join "").Trim()
        Add-TrackedContainer -Name $containerName -Id $containerId -Role $collector.Name
        $logFollower = Start-Process -FilePath $script:docker -ArgumentList "logs", "--follow", $containerName -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
        Add-TrackedProcess -Process $logFollower -Role "docker-log-follower" -Name $collector.Name -StandardOutput $stdoutLog -StandardError $stderrLog
        $collectorStates += [pscustomobject]@{
            Name = $collector.Name
            Mode = "Docker"
            Output = $output
            Process = $null
            ContainerName = $containerName
            LogFollower = $logFollower
        }
    }

    Wait-CollectorReadiness -Collectors $collectorStates
    $script:readyAt = [DateTimeOffset]::UtcNow
    Write-RunManifest -Status "collectors-ready"

    $comparatorProcesses = @()
    $sharpComparator = Join-Path $projectDir "src\sharpx_direct_shadow_comparator.js"
    $sharpRemainingHours = Get-RemainingDurationHours
    $sharpComparatorProcess = Start-Process -FilePath $node -ArgumentList $sharpComparator, "--normal-file", (Join-Path $projectDir "data\sharpx_status_snapshot.json"), "--direct-file", (Join-Path $dataDir "sharpx_status_snapshot.json"), "--output-dir", (Join-Path $comparisonDir "sharpx"), "--duration-hours", $sharpRemainingHours -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir "sharpx-comparator.log") -RedirectStandardError (Join-Path $logsDir "sharpx-comparator.error.log") -PassThru
    Add-TrackedProcess -Process $sharpComparatorProcess -Role "comparator" -Name "sharpx" -StandardOutput (Join-Path $logsDir "sharpx-comparator.log") -StandardError (Join-Path $logsDir "sharpx-comparator.error.log")
    $comparatorProcesses += $sharpComparatorProcess

    $providerComparator = Join-Path $projectDir "src\provider_direct_shadow_comparator.js"
    foreach ($provider in @(
        [pscustomobject]@{ Name = "vegas"; File = "vegas_odds_snapshot.json" },
        [pscustomobject]@{ Name = "tippmixpro"; File = "tippmixpro_odds_snapshot.json" }
    )) {
        $providerRemainingHours = Get-RemainingDurationHours
        $comparatorStdout = Join-Path $logsDir "$($provider.Name)-comparator.log"
        $comparatorStderr = Join-Path $logsDir "$($provider.Name)-comparator.error.log"
        $providerComparatorProcess = Start-Process -FilePath $node -ArgumentList $providerComparator, "--provider", $provider.Name, "--normal-file", (Join-Path $projectDir "data\$($provider.File)"), "--direct-file", (Join-Path $dataDir $provider.File), "--output-dir", (Join-Path $comparisonDir $provider.Name), "--duration-hours", $providerRemainingHours -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $comparatorStdout -RedirectStandardError $comparatorStderr -PassThru
        Add-TrackedProcess -Process $providerComparatorProcess -Role "comparator" -Name $provider.Name -StandardOutput $comparatorStdout -StandardError $comparatorStderr
        $comparatorProcesses += $providerComparatorProcess
    }

    Start-Sleep -Milliseconds 500
    foreach ($comparatorProcess in $comparatorProcesses) {
        if ($comparatorProcess.HasExited) {
            throw "Egy comparator a startup soran kilepett (PID=$($comparatorProcess.Id), exit=$($comparatorProcess.ExitCode))."
        }
    }
    foreach ($collectorState in $collectorStates) { Assert-CollectorAlive -Collector $collectorState }

    Write-RunManifest -Status "running"
} catch {
    $startupError = $_.Exception
    Invoke-StartupCleanup
    $script:cleanupCompletedAt = [DateTimeOffset]::UtcNow
    try { Write-RunManifest -Status "failed" -Failure $startupError.Message } catch { }
    throw $startupError
}

$networkDescription = if ($DirectNetwork -eq "PiaDocker") { "PIA VPN: Docker network=container:$PiaContainerName" } else { "host network (debug only)" }
Write-Host "Haromforrasos direct shadow teszt elindult: $runId" -ForegroundColor Green
Write-Host "Collectorok: SharpX, Vegas, TippmixPro. Kozos deadline: $($script:runDeadline.ToString('o'))."
Write-Host "Halozat: $networkDescription"
Write-Host "Adatok: $dataDir"
Write-Host "Osszevetes: $comparisonDir"
Write-Host "Run manifest: $manifestFile"
