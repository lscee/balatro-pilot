[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\kimi-api-key.dpapi"),
  [string]$DeepSeekCredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\deepseek-api-key.dpapi"),
  [string]$RoutineCredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\routine-api-key.dpapi"),
  [string]$StrategicCredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\strategic-api-key.dpapi"),
  [ValidateRange(5, 120)]
  [int]$StaleMinutes = 20,
  [ValidateRange(4, 30)]
  [int]$RepeatedPlanLimit = 8,
  [ValidateRange(6, 40)]
  [int]$CyclePlanLimit = 12,
  [Alias("DryRun")]
  [switch]$CheckOnly,
  [switch]$ForceRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$resolvedProject = [System.IO.Path]::GetFullPath($ProjectRoot)
$stateDirectory = Join-Path $env:LOCALAPPDATA "BalatroPilot"
$watchdogLog = Join-Path $stateDirectory "watchdog.log"
$statePath = Join-Path $stateDirectory "watchdog-state.json"
$runnerPath = Join-Path $resolvedProject "scripts\run-balatro-pilot.ps1"
$launchPath = Join-Path $resolvedProject "src\launch.mjs"
$indexPath = Join-Path $resolvedProject "src\index.mjs"
$runsPath = Join-Path $resolvedProject "runs"

if (-not (Test-Path -LiteralPath $stateDirectory)) {
  New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
}

function Write-WatchdogLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = "{0} {1}" -f ([DateTime]::UtcNow.ToString("o")), $Message
  Add-Content -LiteralPath $watchdogLog -Value $line -Encoding UTF8
  Write-Output $line
}

function Get-PilotProcesses {
  $paths = @($runnerPath, $launchPath, $indexPath)
  return @(
    Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $commandLine = [string]$_.CommandLine
      if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
      foreach ($path in $paths) {
        if ($commandLine.IndexOf($path, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
          return $true
        }
      }
      return $false
    }
  )
}

function Get-PlanFingerprint {
  param([Parameter(Mandatory = $true)]$Event)
  $plan = $Event.plan
  $state = $plan.state
  $parts = @(
    [string]$plan.screen,
    [string]$state.ante,
    [string]$state.money,
    [string]$state.score,
    [string]$state.target,
    [string]$state.handsLeft,
    [string]$state.discardsLeft,
    [string]$state.deckRemaining,
    [string]$state.deckTotal,
    [string]$state.blind,
    [string]$state.outcome
  )
  return $parts -join "|"
}

function Get-ProgressStatus {
  $eventFile = $null
  if (Test-Path -LiteralPath $runsPath) {
    $eventFile = Get-ChildItem -LiteralPath $runsPath -Filter "events.ndjson" -File -Recurse -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1
  }
  if ($null -eq $eventFile) {
    return [pscustomobject]@{
      Healthy = $false
      Reason = "no run log exists"
      EventAgeMinutes = [double]::PositiveInfinity
      EventPath = $null
      PlanCount = 0
    }
  }

  $eventAge = ([DateTime]::UtcNow - $eventFile.LastWriteTimeUtc).TotalMinutes
  $latestEvent = $null
  try {
    $latestLine = Get-Content -LiteralPath $eventFile.FullName -Tail 1 -ErrorAction Stop
    if (-not [string]::IsNullOrWhiteSpace([string]$latestLine)) {
      $latestEvent = $latestLine | ConvertFrom-Json -ErrorAction Stop
    }
  } catch {
    $latestEvent = $null
  }
  if ($null -ne $latestEvent -and [string]$latestEvent.type -eq "focus_wait") {
    return [pscustomobject]@{
      Healthy = $true
      Reason = "waiting for Balatro foreground focus"
      EventAgeMinutes = $eventAge
      EventPath = $eventFile.FullName
      PlanCount = 0
    }
  }
  if ($eventAge -ge $StaleMinutes) {
    return [pscustomobject]@{
      Healthy = $false
      Reason = "latest run log is $([math]::Round($eventAge, 1)) minutes old"
      EventAgeMinutes = $eventAge
      EventPath = $eventFile.FullName
      PlanCount = 0
    }
  }

  $interesting = @()
  foreach ($line in (Get-Content -LiteralPath $eventFile.FullName -Tail 1200 -ErrorAction Stop)) {
    if ($line -notmatch '"type":"(?:plan|input_ack|bot_state|bot_transition_wait)"') { continue }
    try {
      $interesting += ($line | ConvertFrom-Json -ErrorAction Stop)
    } catch {
      continue
    }
  }

  $plans = @($interesting | Where-Object { $_.type -eq "plan" })
  $acks = @(
    $interesting | Where-Object {
      $_.type -eq "input_ack" -and ($null -eq $_.attempts -or [int]$_.attempts -gt 0)
    }
  )
  $botStates = @($interesting | Where-Object { $_.type -eq "bot_state" })
  $transitionWaits = @($interesting | Where-Object { $_.type -eq "bot_transition_wait" })

  if ($transitionWaits.Count -gt 0) {
    $latestTransitionWait = $transitionWaits | Select-Object -Last 1
    if ([double]$latestTransitionWait.transitionMs -ge 120000) {
      return [pscustomobject]@{
        Healthy = $false
        Reason = "BalatroBot remained in transitional state $($latestTransitionWait.state) for at least 2 minutes"
        EventAgeMinutes = $eventAge
        EventPath = $eventFile.FullName
        PlanCount = $plans.Count
      }
    }
  }

  if ($botStates.Count -ge $RepeatedPlanLimit) {
    $recentBotStates = @($botStates | Select-Object -Last $RepeatedPlanLimit)
    $botFingerprints = @($recentBotStates | ForEach-Object { [string]$_.fingerprint } | Select-Object -Unique)
    $firstBotStateAt = [DateTime]::Parse([string]$recentBotStates[0].at).ToUniversalTime()
    $lastBotStateAt = [DateTime]::Parse([string]$recentBotStates[-1].at).ToUniversalTime()
    if ($botFingerprints.Count -eq 1 -and ($lastBotStateAt - $firstBotStateAt).TotalMinutes -ge 2) {
      return [pscustomobject]@{
        Healthy = $false
        Reason = "BalatroBot repeated the same exact game-state fingerprint for at least 2 minutes"
        EventAgeMinutes = $eventAge
        EventPath = $eventFile.FullName
        PlanCount = $plans.Count
      }
    }
  }

  if ($plans.Count -ge $RepeatedPlanLimit) {
    $recentPlans = @($plans | Select-Object -Last $RepeatedPlanLimit)
    $fingerprints = @($recentPlans | ForEach-Object { Get-PlanFingerprint -Event $_ } | Select-Object -Unique)
    if ($fingerprints.Count -eq 1) {
      return [pscustomobject]@{
        Healthy = $false
        Reason = "the last $RepeatedPlanLimit decisions produced no game-state progress"
        EventAgeMinutes = $eventAge
        EventPath = $eventFile.FullName
        PlanCount = $plans.Count
      }
    }
    $recentScreens = @($recentPlans | ForEach-Object { [string]$_.plan.screen } | Select-Object -Unique)
    $firstRecentAt = [DateTime]::Parse([string]$recentPlans[0].at).ToUniversalTime()
    $lastRecentAt = [DateTime]::Parse([string]$recentPlans[-1].at).ToUniversalTime()
    if (
      $recentScreens.Count -eq 1 -and
      $recentScreens[0] -in @("pack", "shop") -and
      ($lastRecentAt - $firstRecentAt).TotalMinutes -ge 3
    ) {
      return [pscustomobject]@{
        Healthy = $false
        Reason = "the last $RepeatedPlanLimit decisions remained on the same $($recentScreens[0]) screen for at least 3 minutes"
        EventAgeMinutes = $eventAge
        EventPath = $eventFile.FullName
        PlanCount = $plans.Count
      }
    }
  }

  if ($plans.Count -ge $CyclePlanLimit) {
    $cyclePlans = @($plans | Select-Object -Last $CyclePlanLimit)
    $cycleFingerprints = @($cyclePlans | ForEach-Object { Get-PlanFingerprint -Event $_ } | Select-Object -Unique)
    $firstAt = [DateTime]::Parse([string]$cyclePlans[0].at).ToUniversalTime()
    $lastAt = [DateTime]::Parse([string]$cyclePlans[-1].at).ToUniversalTime()
    if ($cycleFingerprints.Count -le 2 -and ($lastAt - $firstAt).TotalMinutes -ge 5) {
      return [pscustomobject]@{
        Healthy = $false
        Reason = "the last $CyclePlanLimit decisions are cycling between $($cycleFingerprints.Count) states"
        EventAgeMinutes = $eventAge
        EventPath = $eventFile.FullName
        PlanCount = $plans.Count
      }
    }
  }

  if ($acks.Count -ge 6) {
    $recentAcks = @($acks | Select-Object -Last 6)
    $failedAcks = @($recentAcks | Where-Object { -not [bool]$_.acknowledged })
    $latestPlan = $plans | Select-Object -Last 1
    $latestAck = $recentAcks | Select-Object -Last 1
    $ackPlan = $plans | Where-Object { [int]$_.step -eq [int]$latestAck.step } | Select-Object -Last 1
    $ackIsCurrent =
      $null -ne $latestPlan -and
      $null -ne $ackPlan -and
      ([int]$latestPlan.step - [int]$latestAck.step) -le 2 -and
      [string]$latestPlan.plan.screen -eq [string]$ackPlan.plan.screen
    if ($failedAcks.Count -eq 6 -and $ackIsCurrent) {
      return [pscustomobject]@{
        Healthy = $false
        Reason = "the last 6 controller inputs all failed visual confirmation"
        EventAgeMinutes = $eventAge
        EventPath = $eventFile.FullName
        PlanCount = $plans.Count
      }
    }
  }

  return [pscustomobject]@{
    Healthy = $true
    Reason = "run log is advancing"
    EventAgeMinutes = $eventAge
    EventPath = $eventFile.FullName
    PlanCount = $plans.Count
  }
}

function Stop-PilotProcesses {
  param([Parameter(Mandatory = $true)][array]$Processes)
  $ordered = @($Processes | Sort-Object CreationDate)
  foreach ($process in $ordered) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ProcessId)" -ErrorAction SilentlyContinue
    if ($null -eq $current) { continue }
    $commandLine = [string]$current.CommandLine
    if (
      $commandLine.IndexOf($runnerPath, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and
      $commandLine.IndexOf($launchPath, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and
      $commandLine.IndexOf($indexPath, [StringComparison]::OrdinalIgnoreCase) -lt 0
    ) {
      continue
    }
    & taskkill.exe /PID $current.ProcessId /T /F 2>&1 | Out-Null
  }
}

function Start-PilotProcess {
  $configPath = Join-Path $resolvedProject "config.json"
  $usesModelRoutes = $false
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $projectConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $modelRoutesProperty = $projectConfig.PSObject.Properties["modelRoutes"]
    $usesModelRoutes = $null -ne $modelRoutesProperty -and $null -ne $modelRoutesProperty.Value
    if (-not $usesModelRoutes -and -not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) {
      throw "Encrypted Kimi credential is missing: $CredentialPath"
    }
    $balatrobotProviderProperty = $projectConfig.PSObject.Properties["balatrobotProvider"]
    $configuredBalatrobotProvider = if ($null -eq $balatrobotProviderProperty) { "" } else { [string]$balatrobotProviderProperty.Value }
    $strategicProviderProperty = $projectConfig.PSObject.Properties["balatrobotStrategicProvider"]
    $configuredStrategicProvider = if ($null -eq $strategicProviderProperty) { "" } else { [string]$strategicProviderProperty.Value }
    $usesDeepSeek =
      [string]$projectConfig.provider -eq "deepseek-chat" -or
      $configuredBalatrobotProvider -eq "deepseek-chat" -or
      $configuredStrategicProvider -eq "deepseek-chat"
    if ($usesDeepSeek -and -not (Test-Path -LiteralPath $DeepSeekCredentialPath -PathType Leaf)) {
      throw "Encrypted DeepSeek credential is missing: $DeepSeekCredentialPath"
    }
  }
  if (-not $usesModelRoutes -and -not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) {
    throw "Encrypted Kimi credential is missing: $CredentialPath"
  }
  if (-not (Test-Path -LiteralPath $runnerPath)) {
    throw "Runner script is missing: $runnerPath"
  }

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdoutPath = Join-Path $stateDirectory "controller-$timestamp.stdout.log"
  $stderrPath = Join-Path $stateDirectory "controller-$timestamp.stderr.log"
  $powerShellPath = (Get-Process -Id $PID).Path
  $arguments = @(
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $runnerPath),
    "-ProjectRoot", ('"{0}"' -f $resolvedProject),
    "-CredentialPath", ('"{0}"' -f $CredentialPath),
    "-DeepSeekCredentialPath", ('"{0}"' -f $DeepSeekCredentialPath),
    "-RoutineCredentialPath", ('"{0}"' -f $RoutineCredentialPath),
    "-StrategicCredentialPath", ('"{0}"' -f $StrategicCredentialPath)
  )
  $startParameters = @{
    FilePath = $powerShellPath
    ArgumentList = $arguments
    WorkingDirectory = $resolvedProject
    WindowStyle = "Hidden"
    RedirectStandardOutput = $stdoutPath
    RedirectStandardError = $stderrPath
    PassThru = $true
  }
  $process = Start-Process @startParameters

  [pscustomobject]@{
    pid = $process.Id
    startedAt = [DateTime]::UtcNow.ToString("o")
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

  Start-Sleep -Milliseconds 1200
  if ($null -eq (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
    throw "Balatro Pilot exited immediately; inspect $stderrPath"
  }
  return $process
}

$mutex = New-Object System.Threading.Mutex($false, "Local\BalatroPilotWatchdog")
$lockTaken = $false

try {
  $lockTaken = $mutex.WaitOne(0)
  if (-not $lockTaken) {
    Write-WatchdogLog "Another watchdog check is already running; skipped."
    exit 0
  }

  if ($CheckOnly -and $ForceRestart) {
    throw "CheckOnly and ForceRestart cannot be used together"
  }

  $processes = @(Get-PilotProcesses)
  if ($ForceRestart) {
    $reason = "the scheduled diagnosis and verified repair completed"
  } elseif ($processes.Count -eq 0) {
    $reason = "Balatro Pilot process is not running"
  } else {
    $oldestCreation = @($processes | Sort-Object CreationDate | Select-Object -First 1)[0].CreationDate
    $processAge = ([DateTime]::Now - [DateTime]$oldestCreation).TotalMinutes
    if ($processAge -lt 5) {
      Write-WatchdogLog "Healthy: Balatro Pilot is still in its startup grace period."
      exit 0
    }
    $progress = Get-ProgressStatus
    if ($progress.Healthy) {
      Write-WatchdogLog "Healthy: $($processes.Count) managed process(es); latest event age $([math]::Round($progress.EventAgeMinutes, 1)) minute(s)."
      exit 0
    }
    $reason = $progress.Reason
  }

  if ($CheckOnly) {
    Write-WatchdogLog "STUCK: $reason. Diagnosis and repair are required before restart."
    exit 3
  }

  if ($processes.Count -gt 0) {
    Stop-PilotProcesses -Processes $processes
    Start-Sleep -Milliseconds 800
  }
  $started = Start-PilotProcess
  Write-WatchdogLog "Restarted Balatro Pilot as PID $($started.Id) because $reason."
  exit 0
} catch {
  Write-WatchdogLog "ERROR: $($_.Exception.Message)"
  exit 2
} finally {
  if ($lockTaken) {
    $mutex.ReleaseMutex() | Out-Null
  }
  $mutex.Dispose()
}
