[CmdletBinding()]
param(
    [ValidateRange(1, 24)][int]$DurationHours = 8,
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
$dataDir = Join-Path $projectDir "data\sharpx-direct-shadow\$runId"
$logsDir = Join-Path $projectDir "logs\sharpx-direct-shadow\$runId"
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
$script:outputEntries = @([pscustomobject]@{
    provider = "SharpX"
    path = Join-Path $dataDir "sharpx_status_snapshot.json"
})

function Write-RunManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [string]$Failure = ""
    )
    $manifest = [ordered]@{
        schemaVersion = 1
        runId = $runId
        launcher = "start_sharpx_direct_shadow_test.ps1"
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
        [Parameter(Mandatory = $true)][string]$Id
    )
    $cleanupId = if ($Id) { $Id } else { $Name }
    $script:cleanupStack += [pscustomobject]@{ Kind = "Container"; Name = $Name; Id = $cleanupId }
    if (-not $Id) { throw "A Docker collector nem adott vissza container ID-t: $Name" }
    $script:containerEntries += [pscustomobject]@{
        role = "SharpX"
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
    param([Parameter(Mandatory = $true)]$CollectorState)
    if ($CollectorState.Mode -eq "Host") {
        if ($CollectorState.Process.HasExited) {
            throw "SharpX collector kilepett a readiness elott (exit=$($CollectorState.Process.ExitCode))."
        }
        return
    }
    $runningOutput = & $script:docker inspect --format "{{.State.Running}}" $CollectorState.ContainerName 2>$null
    $inspectExitCode = $LASTEXITCODE
    $running = (@($runningOutput) -join "").Trim()
    if ($inspectExitCode -ne 0 -or $running -ne "true") {
        throw "A SharpX collector kontenere nem fut a readiness ellenorzeskor."
    }
    if ($null -ne $CollectorState.LogFollower -and $CollectorState.LogFollower.HasExited) {
        throw "A SharpX docker log follower kilepett (exit=$($CollectorState.LogFollower.ExitCode))."
    }
}

function Wait-CollectorReadiness {
    param([Parameter(Mandatory = $true)]$CollectorState)
    $readinessDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
    while ($true) {
        Assert-CollectorAlive -CollectorState $CollectorState
        if (Test-ReadyOutput -Path $CollectorState.Output) { return }
        $now = [DateTimeOffset]::UtcNow
        if ($now -ge $readinessDeadline -or $now -ge $script:runDeadline) {
            throw "A SharpX collector readiness 60 masodpercen belul nem teljesult."
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

Write-RunManifest -Status "starting"

try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $collector = Join-Path $projectDir "src\sharpx_direct_shadow.js"
    $comparator = Join-Path $projectDir "src\sharpx_direct_shadow_comparator.js"
    $statusFile = Join-Path $dataDir "sharpx_status_snapshot.json"
    $collectorStdout = Join-Path $logsDir "collector.log"
    $collectorStderr = Join-Path $logsDir "collector.error.log"
    $remainingHours = Get-RemainingDurationHours

    if ($DirectNetwork -eq "Host") {
        $collectorProcess = Start-Process -FilePath $node -ArgumentList "--title=oddsaggregator-sharpx-direct-shadow", $collector, "--output-file", $statusFile, "--duration-hours", $remainingHours -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $collectorStdout -RedirectStandardError $collectorStderr -PassThru
        Add-TrackedProcess -Process $collectorProcess -Role "collector" -Name "SharpX" -StandardOutput $collectorStdout -StandardError $collectorStderr
        $collectorState = [pscustomobject]@{
            Mode = "Host"
            Output = $statusFile
            Process = $collectorProcess
            ContainerName = $null
            LogFollower = $null
        }
    } else {
        $script:docker = (Get-Command docker.exe -ErrorAction Stop).Source
        $piaRunningOutput = & $script:docker inspect --format "{{.State.Running}}" $PiaContainerName 2>$null
        $piaInspectExitCode = $LASTEXITCODE
        $piaRunning = (@($piaRunningOutput) -join "").Trim()
        if ($piaInspectExitCode -ne 0 -or $piaRunning -ne "true") {
            throw "A '$PiaContainerName' Docker-kontener nem fut."
        }
        $containerName = "oddsaggregator-direct-$runId-sharpx"
        $mount = "type=bind,src=$projectDir,dst=/app"
        $containerOutput = "/app/data/sharpx-direct-shadow/$runId/sharpx_status_snapshot.json"
        $containerOutputText = & $script:docker run --detach --rm --name $containerName --network "container:$PiaContainerName" --mount $mount --workdir "/app" $NodeImage node "--title=oddsaggregator-sharpx-direct-shadow" "src/sharpx_direct_shadow.js" "--output-file" $containerOutput "--duration-hours" $remainingHours
        if ($LASTEXITCODE -ne 0) { throw "A SharpX PIA Docker-collector inditasa sikertelen." }
        $containerId = (@($containerOutputText) -join "").Trim()
        Add-TrackedContainer -Name $containerName -Id $containerId
        $logFollower = Start-Process -FilePath $script:docker -ArgumentList "logs", "--follow", $containerName -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $collectorStdout -RedirectStandardError $collectorStderr -PassThru
        Add-TrackedProcess -Process $logFollower -Role "docker-log-follower" -Name "SharpX" -StandardOutput $collectorStdout -StandardError $collectorStderr
        $collectorState = [pscustomobject]@{
            Mode = "Docker"
            Output = $statusFile
            Process = $null
            ContainerName = $containerName
            LogFollower = $logFollower
        }
    }

    Wait-CollectorReadiness -CollectorState $collectorState
    $script:readyAt = [DateTimeOffset]::UtcNow
    Write-RunManifest -Status "collectors-ready"

    $comparatorRemainingHours = Get-RemainingDurationHours
    $comparatorStdout = Join-Path $logsDir "comparator.log"
    $comparatorStderr = Join-Path $logsDir "comparator.error.log"
    $comparatorProcess = Start-Process -FilePath $node -ArgumentList $comparator, "--normal-file", (Join-Path $projectDir "data\sharpx_status_snapshot.json"), "--direct-file", $statusFile, "--output-dir", $comparisonDir, "--duration-hours", $comparatorRemainingHours -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $comparatorStdout -RedirectStandardError $comparatorStderr -PassThru
    Add-TrackedProcess -Process $comparatorProcess -Role "comparator" -Name "SharpX" -StandardOutput $comparatorStdout -StandardError $comparatorStderr

    Start-Sleep -Milliseconds 500
    if ($comparatorProcess.HasExited) {
        throw "A SharpX comparator a startup soran kilepett (exit=$($comparatorProcess.ExitCode))."
    }
    Assert-CollectorAlive -CollectorState $collectorState
    Write-RunManifest -Status "running"
} catch {
    $startupError = $_.Exception
    Invoke-StartupCleanup
    $script:cleanupCompletedAt = [DateTimeOffset]::UtcNow
    try { Write-RunManifest -Status "failed" -Failure $startupError.Message } catch { }
    throw $startupError
}

$networkDescription = if ($DirectNetwork -eq "PiaDocker") { "PIA VPN: Docker network=container:$PiaContainerName" } else { "host network (debug only)" }
Write-Host "SharpX direct shadow teszt elindult. Run ID: $runId" -ForegroundColor Green
Write-Host "Kozos deadline: $($script:runDeadline.ToString('o'))"
Write-Host "Halozat: $networkDescription"
Write-Host "Direct adat: $dataDir"
Write-Host "Osszevetes: $comparisonDir"
Write-Host "Run manifest: $manifestFile"
