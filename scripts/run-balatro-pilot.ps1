[CmdletBinding()]
param(
  [string]$ProjectRoot = "",

  [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\kimi-api-key.dpapi"),

  [string]$DeepSeekCredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\deepseek-api-key.dpapi"),

  [string]$RoutineCredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\routine-api-key.dpapi"),

  [string]$StrategicCredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\strategic-api-key.dpapi"),

  [switch]$ApiDoctor,

  [switch]$StrategicApiDoctor,

  [switch]$VisionApiDoctor,

  [switch]$DryRun,

  [switch]$ControllerOnly,

  [ValidateRange(0, 10000)]
  [int]$Steps = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Codex and other parent processes can prepend a PowerShell 7 module directory
# to PSModulePath even though this launcher intentionally runs under Windows
# PowerShell. Import the matching in-box security module explicitly so DPAPI
# credentials never depend on module auto-discovery order.
$securityModulePath = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
if (Test-Path -LiteralPath $securityModulePath -PathType Leaf) {
  Import-Module -Name $securityModulePath -Force -ErrorAction Stop
} else {
  Import-Module -Name "Microsoft.PowerShell.Security" -Force -ErrorAction Stop
}

if (@($ApiDoctor, $StrategicApiDoctor, $VisionApiDoctor).Where({ $_ }).Count -gt 1) {
  throw "Choose only one API doctor mode."
}
if (($ApiDoctor -or $StrategicApiDoctor -or $VisionApiDoctor) -and ($DryRun -or $Steps -gt 0)) {
  throw "API doctor modes cannot be combined with -DryRun or -Steps."
}
if ($ControllerOnly -and ($ApiDoctor -or $StrategicApiDoctor -or $VisionApiDoctor)) {
  throw "ControllerOnly cannot be combined with an API doctor mode."
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$resolvedProject = [System.IO.Path]::GetFullPath($ProjectRoot)
$packagePath = Join-Path $resolvedProject "package.json"
if (-not (Test-Path -LiteralPath $packagePath)) {
  throw "Balatro Pilot package.json was not found at $resolvedProject"
}
$configuredBackend = "auto"
$configuredProvider = "kimi-chat"
$configuredBalatrobotProvider = $null
$configuredBalatrobotStrategicProvider = $null
$usesModelRoutes = $false
$configPath = Join-Path $resolvedProject "config.json"
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  try {
    $projectConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $modelRoutesProperty = $projectConfig.PSObject.Properties["modelRoutes"]
    if ($null -ne $modelRoutesProperty -and $null -ne $modelRoutesProperty.Value) {
      $usesModelRoutes = $true
      $routineProperty = $modelRoutesProperty.Value.PSObject.Properties["routine"]
      $strategicRouteProperty = $modelRoutesProperty.Value.PSObject.Properties["strategic"]
      $visionProperty = $modelRoutesProperty.Value.PSObject.Properties["vision"]
      if ($null -ne $routineProperty -and -not [string]::IsNullOrWhiteSpace([string]$routineProperty.Value.provider)) {
        $configuredBalatrobotProvider = [string]$routineProperty.Value.provider
      }
      if ($null -ne $strategicRouteProperty -and -not [string]::IsNullOrWhiteSpace([string]$strategicRouteProperty.Value.provider)) {
        $configuredBalatrobotStrategicProvider = [string]$strategicRouteProperty.Value.provider
      }
      if ($null -ne $visionProperty -and -not [string]::IsNullOrWhiteSpace([string]$visionProperty.Value.provider)) {
        $configuredProvider = [string]$visionProperty.Value.provider
      }
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$projectConfig.controlBackend)) {
      $configuredBackend = [string]$projectConfig.controlBackend
    }
    if (-not $usesModelRoutes -and -not [string]::IsNullOrWhiteSpace([string]$projectConfig.provider)) {
      $configuredProvider = [string]$projectConfig.provider
    }
    $balatrobotProviderProperty = $projectConfig.PSObject.Properties["balatrobotProvider"]
    if (-not $usesModelRoutes -and $null -ne $balatrobotProviderProperty -and -not [string]::IsNullOrWhiteSpace([string]$balatrobotProviderProperty.Value)) {
      $configuredBalatrobotProvider = [string]$balatrobotProviderProperty.Value
    }
    $strategicProviderProperty = $projectConfig.PSObject.Properties["balatrobotStrategicProvider"]
    if (-not $usesModelRoutes -and $null -ne $strategicProviderProperty -and -not [string]::IsNullOrWhiteSpace([string]$strategicProviderProperty.Value)) {
      $configuredBalatrobotStrategicProvider = [string]$strategicProviderProperty.Value
    }
  } catch {
    throw "Unable to read planner providers/controlBackend from ${configPath}: $($_.Exception.Message)"
  }
}
$configuredBalatrobotProvider = if (-not [string]::IsNullOrWhiteSpace($env:BALATRO_ROUTINE_PROVIDER)) {
  [string]$env:BALATRO_ROUTINE_PROVIDER
} else { $configuredBalatrobotProvider }
$configuredBalatrobotStrategicProvider = if (-not [string]::IsNullOrWhiteSpace($env:BALATRO_STRATEGIC_PROVIDER)) {
  [string]$env:BALATRO_STRATEGIC_PROVIDER
} else { $configuredBalatrobotStrategicProvider }
$configuredProvider = if (-not [string]::IsNullOrWhiteSpace($env:BALATRO_VISION_PROVIDER)) {
  [string]$env:BALATRO_VISION_PROVIDER
} else { $configuredProvider }
$configuredBalatrobotProvider = if ([string]::IsNullOrWhiteSpace($configuredBalatrobotProvider)) {
  $configuredProvider
} else {
  $configuredBalatrobotProvider
}
$configuredBalatrobotStrategicProvider = if ([string]::IsNullOrWhiteSpace($configuredBalatrobotStrategicProvider)) {
  $configuredBalatrobotProvider
} else {
  $configuredBalatrobotStrategicProvider
}

function Get-ProviderCredential {
  param(
    [Parameter(Mandatory = $true)][string]$Provider,
    [ValidateSet("routine", "strategic", "vision")][string]$Route = "routine"
  )
  $routePath = if ($usesModelRoutes) {
    if ($Route -eq "strategic" -or $Route -eq "vision") { $StrategicCredentialPath } else { $RoutineCredentialPath }
  } else { $null }
  switch ($Provider) {
    "kimi-platform" { return [pscustomobject]@{ Environment = "MOONSHOT_API_KEY"; Path = $(if ($routePath) { $routePath } else { $CredentialPath }) } }
    "kimi-chat" { return [pscustomobject]@{ Environment = "KIMI_API_KEY"; Path = $(if ($routePath) { $routePath } else { $CredentialPath }) } }
    "deepseek-chat" { return [pscustomobject]@{ Environment = "DEEPSEEK_API_KEY"; Path = $(if ($routePath) { $routePath } else { $DeepSeekCredentialPath }) } }
    "openai-responses" { return [pscustomobject]@{ Environment = "OPENAI_API_KEY"; Path = $routePath } }
    default { throw "Unsupported configured provider '$Provider'" }
  }
}

$requiredRoutes = [System.Collections.Generic.List[object]]::new()
function Add-RequiredRoute {
  param([string]$Route, [string]$Provider)
  if ($Provider -eq "ollama-chat") { return }
  if (@($requiredRoutes | Where-Object { $_.Route -eq $Route -and $_.Provider -eq $Provider }).Count -eq 0) {
    $requiredRoutes.Add([pscustomobject]@{ Route = $Route; Provider = $Provider })
  }
}
if ($ApiDoctor) {
  Add-RequiredRoute -Route "routine" -Provider $configuredBalatrobotProvider
} elseif ($StrategicApiDoctor) {
  Add-RequiredRoute -Route "strategic" -Provider $configuredBalatrobotStrategicProvider
} elseif ($VisionApiDoctor) {
  Add-RequiredRoute -Route "vision" -Provider $configuredProvider
} else {
  if ($configuredBackend -eq "vision" -or $configuredBackend -eq "auto") {
    Add-RequiredRoute -Route "vision" -Provider $configuredProvider
  }
  if ($configuredBackend -ne "vision") {
    Add-RequiredRoute -Route "routine" -Provider $configuredBalatrobotProvider
    Add-RequiredRoute -Route "strategic" -Provider $configuredBalatrobotStrategicProvider
  }
}
if ($ControllerOnly) {
  if ($null -eq (Get-Process -Name "Balatro" -ErrorAction SilentlyContinue)) {
    throw "ControllerOnly requires Balatro.exe to already be running."
  }
  $rpcListener = Get-NetTCPConnection -State Listen -LocalPort 12346 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $rpcListener) {
    throw "ControllerOnly requires the existing BalatroBot JSON-RPC listener on port 12346."
  }
} elseif (-not $ApiDoctor -and -not $StrategicApiDoctor -and -not $VisionApiDoctor -and $configuredBackend -ne "vision") {
  $companionStarter = Join-Path $resolvedProject "scripts\start-companion-services.ps1"
  if (Test-Path -LiteralPath $companionStarter -PathType Leaf) {
    & $companionStarter -ProjectRoot $resolvedProject
  }
  $balatroBotStarter = Join-Path $resolvedProject "scripts\start-balatrobot.ps1"
  if (-not (Test-Path -LiteralPath $balatroBotStarter -PathType Leaf)) {
    throw "BalatroBot starter was not found: $balatroBotStarter"
  }
  & $balatroBotStarter -WindowMode Hidden
  $localModelStarter = Join-Path $resolvedProject "scripts\start-local-ollama.ps1"
  if (Test-Path -LiteralPath $localModelStarter -PathType Leaf) {
    try {
      & $localModelStarter
    } catch {
      Write-Warning "Local model service is unavailable; routine decisions will fall back to DeepSeek: $($_.Exception.Message)"
    }
  }
}

$loadedCredentials = @()
$exitCode = 1

try {
  foreach ($required in $requiredRoutes) {
    $credential = Get-ProviderCredential -Provider $required.Provider -Route $required.Route
    $routeEnvironment = if ($required.Route -eq "strategic" -or $required.Route -eq "vision") {
      "BALATRO_STRATEGY_API_KEY"
    } else {
      "BALATRO_ROUTINE_API_KEY"
    }
    $routeExisting = [Environment]::GetEnvironmentVariable($routeEnvironment, [EnvironmentVariableTarget]::Process)
    $providerExisting = [Environment]::GetEnvironmentVariable($credential.Environment, [EnvironmentVariableTarget]::Process)
    if (-not [string]::IsNullOrWhiteSpace($routeExisting)) {
      if (-not $usesModelRoutes -and [string]::IsNullOrWhiteSpace($providerExisting)) {
        [Environment]::SetEnvironmentVariable($credential.Environment, $routeExisting, [EnvironmentVariableTarget]::Process)
        $loadedCredentials += [pscustomobject]@{ Environment = $credential.Environment; Pointer = [IntPtr]::Zero }
      }
      continue
    }
    if (-not [string]::IsNullOrWhiteSpace($providerExisting)) {
      [Environment]::SetEnvironmentVariable($routeEnvironment, $providerExisting, [EnvironmentVariableTarget]::Process)
      $loadedCredentials += [pscustomobject]@{ Environment = $routeEnvironment; Pointer = [IntPtr]::Zero }
      continue
    }
    $hasEncryptedCredential =
      -not [string]::IsNullOrWhiteSpace([string]$credential.Path) -and
      (Test-Path -LiteralPath $credential.Path -PathType Leaf)
    if (-not $hasEncryptedCredential) {
      if ([string]::IsNullOrWhiteSpace([string]$credential.Path)) {
        throw "$routeEnvironment is required for the $($required.Route) route using '$($required.Provider)'; set it in the process environment."
      }
      throw "Encrypted credential for the $($required.Route) route using '$($required.Provider)' was not found at $($credential.Path)"
    }
    $encrypted = (Get-Content -LiteralPath $credential.Path -Raw).Trim()
    $secure = ConvertTo-SecureString -String $encrypted
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $routeSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
      [Environment]::SetEnvironmentVariable($routeEnvironment, $routeSecret, [EnvironmentVariableTarget]::Process)
      $loadedCredentials += [pscustomobject]@{ Environment = $routeEnvironment; Pointer = $secretPointer }
      if (-not $usesModelRoutes) {
        [Environment]::SetEnvironmentVariable($credential.Environment, $routeSecret, [EnvironmentVariableTarget]::Process)
        $loadedCredentials += [pscustomobject]@{ Environment = $credential.Environment; Pointer = [IntPtr]::Zero }
      }
      $secretPointer = [IntPtr]::Zero
    } finally {
      if ($secretPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
      }
    }
  }
  $npm = Get-Command "npm.cmd" -ErrorAction Stop
  Set-Location -LiteralPath $resolvedProject
  $npmArguments = if ($ApiDoctor) {
    @("run", "api-doctor")
  } elseif ($StrategicApiDoctor) {
    @("run", "strategic-api-doctor")
  } elseif ($VisionApiDoctor) {
    @("run", "vision-api-doctor")
  } else {
    @("run", "run")
  }
  if (-not $ApiDoctor -and -not $StrategicApiDoctor -and -not $VisionApiDoctor -and ($DryRun -or $Steps -gt 0)) {
    $npmArguments += "--"
    if ($DryRun) { $npmArguments += "--dry-run" }
    if ($Steps -gt 0) { $npmArguments += @("--steps", [string]$Steps) }
  }
  & $npm.Source @npmArguments
  if ($null -ne $LASTEXITCODE) {
    $exitCode = [int]$LASTEXITCODE
  }
} finally {
  foreach ($loaded in $loadedCredentials) {
    [Environment]::SetEnvironmentVariable($loaded.Environment, $null, [EnvironmentVariableTarget]::Process)
    if ($loaded.Pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($loaded.Pointer)
    }
  }
}

exit $exitCode
