[CmdletBinding()]
param(
  [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA "BalatroPilot\kimi-api-key.dpapi")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$credentialDirectory = Split-Path -Parent $CredentialPath
if (-not (Test-Path -LiteralPath $credentialDirectory)) {
  New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
}

$secret = Read-Host "KIMI or Moonshot API Key" -AsSecureString
if ($secret.Length -lt 1) {
  throw "API Key cannot be empty"
}

$encrypted = ConvertFrom-SecureString -SecureString $secret
Set-Content -LiteralPath $CredentialPath -Value $encrypted -Encoding ASCII -NoNewline
Write-Output "Encrypted Kimi/Moonshot credential stored for the current Windows user."
