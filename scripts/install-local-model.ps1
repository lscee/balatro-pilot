[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ProjectRoot = "",
  [string]$BaseModel = "qwen3.5:9b-q4_K_M",
  [string]$Model = "balatro-pilot-qwen:latest"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$resolvedProject = [System.IO.Path]::GetFullPath($ProjectRoot)
$modelFile = Join-Path $resolvedProject "models\BalatroPilot.Modelfile"
if (-not (Test-Path -LiteralPath $modelFile -PathType Leaf)) {
  throw "Local model definition was not found: $modelFile"
}

$ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
if (-not (Test-Path -LiteralPath $ollama -PathType Leaf)) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($null -eq $winget) {
    throw "Ollama is not installed and winget.exe is unavailable. Install Ollama, then rerun this script."
  }
  if ($PSCmdlet.ShouldProcess("Ollama.Ollama", "Install with winget")) {
    $process = Start-Process -FilePath $winget.Source -ArgumentList @(
      "install", "--id", "Ollama.Ollama", "--exact",
      "--accept-package-agreements", "--accept-source-agreements", "--silent"
    ) -Wait -PassThru
    if ($process.ExitCode -ne 0) {
      throw "winget failed to install Ollama (exit code $($process.ExitCode))."
    }
  }
}

if ($WhatIfPreference) {
  Write-Output "[plan] Start loopback Ollama, pull $BaseModel, and create $Model from $modelFile"
  return
}
if (-not (Test-Path -LiteralPath $ollama -PathType Leaf)) {
  throw "Ollama installation completed but ollama.exe was not found at $ollama."
}

& (Join-Path $PSScriptRoot "start-local-ollama.ps1")
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "127.0.0.1:11434", [EnvironmentVariableTarget]::Process)

if ($PSCmdlet.ShouldProcess($BaseModel, "Download verified model layers through Ollama")) {
  & $ollama pull $BaseModel
  if ($LASTEXITCODE -ne 0) { throw "ollama pull failed for $BaseModel" }
}
if ($PSCmdlet.ShouldProcess($Model, "Create the Balatro Pilot local model")) {
  & $ollama create $Model -f $modelFile
  if ($LASTEXITCODE -ne 0) { throw "ollama create failed for $Model" }
}

$tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 5
$installedNames = @($tags.models | ForEach-Object { [string]$_.name })
if ($installedNames -notcontains $Model) {
  throw "Ollama did not report the expected local model '$Model'."
}
Write-Output "[ok] Local routine model is ready: $Model"
