[CmdletBinding()]
param(
  [string]$RoutineCredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\routine-api-key.dpapi"),
  [string]$StrategicCredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\strategic-api-key.dpapi"),
  [switch]$RoutineOnly,
  [switch]$StrategicOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($RoutineOnly -and $StrategicOnly) {
  throw "Choose RoutineOnly or StrategicOnly, not both."
}

function Save-EncryptedCredential {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Path
  )
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $secret = Read-Host "$Label API Key" -AsSecureString
  $encrypted = ConvertFrom-SecureString -SecureString $secret
  [System.IO.File]::WriteAllText($Path, $encrypted, [System.Text.UTF8Encoding]::new($false))
  Write-Output "$Label credential encrypted for the current Windows user."
}

if (-not $StrategicOnly) {
  Save-EncryptedCredential -Label "High-frequency play" -Path $RoutineCredentialPath
}
if (-not $RoutineOnly) {
  Save-EncryptedCredential -Label "Strategic planning" -Path $StrategicCredentialPath
}
