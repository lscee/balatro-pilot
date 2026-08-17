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
  [switch]$ForceRestart,
  [ValidateSet("", "status", "pause", "start")]
  [string]$ControlAction = "",
  [int]$ExpectedRevision = -1,
  [switch]$Json
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
$controlPath = Join-Path $stateDirectory "controller-control.json"
$runnerPath = Join-Path $resolvedProject "scripts\run-balatro-pilot.ps1"
$launchPath = Join-Path $resolvedProject "src\launch.mjs"
$indexPath = Join-Path $resolvedProject "src\index.mjs"
$runsPath = Join-Path $resolvedProject "runs"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $stateDirectory)) {
  New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
}

function Write-WatchdogLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = "{0} {1}" -f ([DateTime]::UtcNow.ToString("o")), $Message
  Add-Content -LiteralPath $watchdogLog -Value $line -Encoding UTF8
  Write-Output $line
}

function Read-ControlState {
  $fallback = [pscustomobject]@{
    desiredState = "running"
    revision = 0
    updatedAt = [DateTime]::UtcNow.ToString("o")
    operationError = $null
  }
  if (-not (Test-Path -LiteralPath $controlPath -PathType Leaf)) { return $fallback }
  try {
    $loaded = Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json -ErrorAction Stop
    if ([string]$loaded.desiredState -notin @("running", "paused")) { return $fallback }
    return [pscustomobject]@{
      desiredState = [string]$loaded.desiredState
      revision = [math]::Max(0, [int]$loaded.revision)
      updatedAt = if ([string]::IsNullOrWhiteSpace([string]$loaded.updatedAt)) { $fallback.updatedAt } else { [string]$loaded.updatedAt }
      operationError = if ($null -eq $loaded.operationError) { $null } else { [string]$loaded.operationError }
    }
  } catch {
    return $fallback
  }
}

function Write-ControlState {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("running", "paused")][string]$DesiredState,
    [Parameter(Mandatory = $true)][int]$Revision,
    [AllowNull()][string]$OperationError
  )
  $value = [ordered]@{
    desiredState = $DesiredState
    revision = $Revision
    updatedAt = [DateTime]::UtcNow.ToString("o")
    operationError = $OperationError
  }
  $temporary = Join-Path $stateDirectory ("controller-control.{0}.tmp" -f ([Guid]::NewGuid().ToString("N")))
  try {
    [System.IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json), $utf8NoBom)
    Move-Item -LiteralPath $temporary -Destination $controlPath -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
  return [pscustomobject]$value
}

function Get-PilotProcesses {
  return @(
    Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $name = [string]$_.Name
      $commandLine = [string]$_.CommandLine
      if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
      $runnerPattern = '(?i)(?:^|\s)-File\s+"?' + [regex]::Escape($runnerPath) + '"?(?=\s|$)'
      $doctorPattern = '(?i)(?:^|\s)-(?:ApiDoctor|StrategicApiDoctor|VisionApiDoctor)(?=\s|$)'
      if (
        $name -in @("powershell.exe", "pwsh.exe") -and
        $commandLine -match $runnerPattern -and
        $commandLine -notmatch $doctorPattern
      ) { return $true }
      $launchPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($launchPath) + '"?\s+run(?:\s|$)'
      $indexPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($indexPath) + '"?\s+run(?:\s|$)'
      return $name -eq "node.exe" -and ($commandLine -match $launchPattern -or $commandLine -match $indexPattern)
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
    if ($line -notmatch '"type":"(?:plan|input_ack|bot_state|bot_transition_wait|rpc_uncertain|rpc_uncertain_quarantine_result)"') { continue }
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
  $rpcUncertain = @($interesting | Where-Object { $_.type -eq "rpc_uncertain" })

  if ($rpcUncertain.Count -ge 3) {
    $latestRpcTimeout = $rpcUncertain | Select-Object -Last 1
    $latestFingerprint = [string]$latestRpcTimeout.stateFingerprint
    $latestMethod = [string]$latestRpcTimeout.method
    $rpcStreak = @()
    for ($index = $interesting.Count - 1; $index -ge 0; $index -= 1) {
      $event = $interesting[$index]
      if ([string]$event.type -eq "rpc_uncertain") {
        if (
          [string]$event.stateFingerprint -ne $latestFingerprint -or
          [string]$event.method -ne $latestMethod
        ) { break }
        $rpcStreak = @($event) + $rpcStreak
        continue
      }
      if ([string]$event.type -eq "bot_state") {
        $eventFingerprint = [string]$event.fingerprint
        if (-not [string]::IsNullOrWhiteSpace($eventFingerprint) -and $eventFingerprint -ne $latestFingerprint) { break }
        continue
      }
      if ([string]$event.type -eq "rpc_uncertain_quarantine_result") {
        $changedProperty = $event.PSObject.Properties["changed"]
        if ($null -ne $changedProperty -and [bool]$changedProperty.Value) { break }
      }
    }
    if ($rpcStreak.Count -ge 3) {
      $firstRpcAt = [DateTime]::Parse([string]$rpcStreak[0].at).ToUniversalTime()
      $lastRpcAt = [DateTime]::Parse([string]$rpcStreak[-1].at).ToUniversalTime()
      if (($lastRpcAt - $firstRpcAt).TotalMinutes -ge 2) {
        return [pscustomobject]@{
          Healthy = $false
          Reason = "BalatroBot RPC $latestMethod timed out $($rpcStreak.Count) times on the same exact game-state fingerprint for at least 2 minutes"
          EventAgeMinutes = $eventAge
          EventPath = $eventFile.FullName
          PlanCount = $plans.Count
        }
      }
    }
  }

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
    $name = [string]$current.Name
    $runnerPattern = '(?i)(?:^|\s)-File\s+"?' + [regex]::Escape($runnerPath) + '"?(?=\s|$)'
    $doctorPattern = '(?i)(?:^|\s)-(?:ApiDoctor|StrategicApiDoctor|VisionApiDoctor)(?=\s|$)'
    $launchPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($launchPath) + '"?\s+run(?:\s|$)'
    $indexPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($indexPath) + '"?\s+run(?:\s|$)'
    $isExactRunner =
      $name -in @("powershell.exe", "pwsh.exe") -and
      $commandLine -match $runnerPattern -and
      $commandLine -notmatch $doctorPattern
    $isExactController = $name -eq "node.exe" -and ($commandLine -match $launchPattern -or $commandLine -match $indexPattern)
    if (-not $isExactRunner -and -not $isExactController) { continue }
    Stop-Process -Id $current.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Wait-PilotStopped {
  param([int]$TimeoutMilliseconds = 8000)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    $remaining = @(Get-PilotProcesses)
    if ($remaining.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Get-ControlStatus {
  param([AllowNull()][string]$ErrorCode = $null)
  $control = Read-ControlState
  $processes = @(Get-PilotProcesses)
  $nodeProcess = $processes | Where-Object {
    ([string]$_.CommandLine).IndexOf($indexPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    ([string]$_.CommandLine).IndexOf($launchPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } | Sort-Object CreationDate | Select-Object -First 1
  $controllerPid = if ($null -ne $nodeProcess) { [int]$nodeProcess.ProcessId } elseif ($processes.Count -gt 0) { [int]$processes[0].ProcessId } else { $null }
  $effectiveState = if ($processes.Count -gt 0) { "running" } elseif ($control.desiredState -eq "paused") { "paused" } else { "stopped" }
  return [pscustomobject]@{
    desiredState = [string]$control.desiredState
    effectiveState = $effectiveState
    revision = [int]$control.revision
    updatedAt = [string]$control.updatedAt
    operationError = $control.operationError
    controllerPid = $controllerPid
    errorCode = $ErrorCode
  }
}

function Write-ControlResult {
  param([Parameter(Mandatory = $true)]$Status)
  if ($Json) { Write-Output ($Status | ConvertTo-Json -Compress) }
  else { Write-Output $Status }
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
    "-StrategicCredentialPath", ('"{0}"' -f $StrategicCredentialPath),
    "-ControllerOnly"
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
  } | ConvertTo-Json | ForEach-Object { [System.IO.File]::WriteAllText($statePath, $_, $utf8NoBom) }

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
    if (-not [string]::IsNullOrWhiteSpace($ControlAction)) {
      $busy = Get-ControlStatus -ErrorCode "CONTROL_BUSY"
      $busy.operationError = "Another control operation is already running."
      Write-ControlResult -Status $busy
      exit 5
    }
    Write-WatchdogLog "Another watchdog check is already running; skipped."
    exit 0
  }

  if (-not [string]::IsNullOrWhiteSpace($ControlAction)) {
    $currentControl = Read-ControlState
    if ($ExpectedRevision -ge 0 -and $ExpectedRevision -ne [int]$currentControl.revision) {
      $conflict = Get-ControlStatus -ErrorCode "REVISION_CONFLICT"
      $conflict.operationError = "The controller state changed; refresh before trying again."
      Write-ControlResult -Status $conflict
      exit 4
    }

    if ($ControlAction -eq "status") {
      Write-ControlResult -Status (Get-ControlStatus)
      exit 0
    }

    if ($ControlAction -eq "pause") {
      if ($currentControl.desiredState -ne "paused") {
        $currentControl = Write-ControlState -DesiredState "paused" -Revision ([int]$currentControl.revision + 1) -OperationError $null
      }
      if (-not (Wait-PilotStopped -TimeoutMilliseconds 8000)) {
        $remaining = @(Get-PilotProcesses)
        if ($remaining.Count -gt 0) { Stop-PilotProcesses -Processes $remaining }
        [void](Wait-PilotStopped -TimeoutMilliseconds 2500)
      }
      $pausedStatus = Get-ControlStatus
      if ($pausedStatus.effectiveState -ne "paused") {
        $currentControl = Write-ControlState -DesiredState "paused" -Revision ([int]$currentControl.revision) -OperationError "The controller could not be stopped safely."
        $pausedStatus = Get-ControlStatus -ErrorCode "CONTROL_OPERATION_FAILED"
        Write-ControlResult -Status $pausedStatus
        exit 2
      }
      Write-ControlResult -Status $pausedStatus
      exit 0
    }

    if ($ControlAction -eq "start") {
      $processes = @(Get-PilotProcesses)
      if ($processes.Count -gt 0) {
        if ($currentControl.desiredState -ne "running") {
          [void](Write-ControlState -DesiredState "running" -Revision ([int]$currentControl.revision + 1) -OperationError $null)
        }
        Write-ControlResult -Status (Get-ControlStatus)
        exit 0
      }
      if ($null -eq (Get-Process -Name "Balatro" -ErrorAction SilentlyContinue)) {
        $failed = Write-ControlState -DesiredState $currentControl.desiredState -Revision ([int]$currentControl.revision) -OperationError "Balatro.exe is not running."
        Write-ControlResult -Status (Get-ControlStatus -ErrorCode "CONTROL_OPERATION_FAILED")
        exit 2
      }
      if ($null -eq (Get-NetTCPConnection -State Listen -LocalPort 12346 -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        $failed = Write-ControlState -DesiredState $currentControl.desiredState -Revision ([int]$currentControl.revision) -OperationError "BalatroBot JSON-RPC is not listening."
        Write-ControlResult -Status (Get-ControlStatus -ErrorCode "CONTROL_OPERATION_FAILED")
        exit 2
      }
      $nextRevision = if ($currentControl.desiredState -eq "running") { [int]$currentControl.revision } else { [int]$currentControl.revision + 1 }
      [void](Write-ControlState -DesiredState "running" -Revision $nextRevision -OperationError $null)
      try {
        $started = Start-PilotProcess
      } catch {
        [void](Write-ControlState -DesiredState "running" -Revision $nextRevision -OperationError "The controller failed to start.")
        Write-ControlResult -Status (Get-ControlStatus -ErrorCode "CONTROL_OPERATION_FAILED")
        exit 2
      }
      Write-ControlResult -Status (Get-ControlStatus)
      exit 0
    }
  }

  if ($CheckOnly -and $ForceRestart) {
    throw "CheckOnly and ForceRestart cannot be used together"
  }

  $controlState = Read-ControlState
  $processes = @(Get-PilotProcesses)
  if ($controlState.desiredState -eq "paused") {
    if ($processes.Count -gt 0) {
      if (-not (Wait-PilotStopped -TimeoutMilliseconds 8000)) {
        Stop-PilotProcesses -Processes @(Get-PilotProcesses)
      }
    }
    Write-WatchdogLog "Paused: controller remains stopped by dashboard control."
    exit 0
  }
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
  if (-not [string]::IsNullOrWhiteSpace($ControlAction)) {
    $control = Read-ControlState
    [void](Write-ControlState -DesiredState $control.desiredState -Revision ([int]$control.revision) -OperationError "Pilot control operation failed.")
    Write-ControlResult -Status (Get-ControlStatus -ErrorCode "CONTROL_OPERATION_FAILED")
  } else {
    Write-WatchdogLog "ERROR: $($_.Exception.Message)"
  }
  exit 2
} finally {
  if ($lockTaken) {
    $mutex.ReleaseMutex() | Out-Null
  }
  $mutex.Dispose()
}
