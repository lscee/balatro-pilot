[CmdletBinding()]
param(
  [int]$Port = 11434,
  [int]$WaitSeconds = 20
)

$ErrorActionPreference = "Stop"
$endpoint = "http://127.0.0.1:$Port/api/version"

try {
  Invoke-RestMethod -Uri $endpoint -TimeoutSec 2 | Out-Null
  return
} catch {
  # Start the loopback service below.
}

$ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
if (-not (Test-Path -LiteralPath $ollama -PathType Leaf)) {
  throw "Ollama is not installed at $ollama"
}

$internet = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue
if ($internet.ProxyEnable -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$internet.ProxyServer)) {
  $proxy = [string]$internet.ProxyServer
  if ($proxy -notmatch "^https?://") { $proxy = "http://$proxy" }
  [Environment]::SetEnvironmentVariable("HTTP_PROXY", $proxy, [EnvironmentVariableTarget]::Process)
  [Environment]::SetEnvironmentVariable("HTTPS_PROXY", $proxy, [EnvironmentVariableTarget]::Process)
}
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "127.0.0.1:$Port", [EnvironmentVariableTarget]::Process)

Start-Process -FilePath $ollama -ArgumentList "serve" -WindowStyle Hidden | Out-Null
$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
do {
  Start-Sleep -Milliseconds 250
  try {
    Invoke-RestMethod -Uri $endpoint -TimeoutSec 2 | Out-Null
    return
  } catch {
    if ([DateTime]::UtcNow -ge $deadline) { break }
  }
} while ($true)

throw "Ollama did not become ready on 127.0.0.1:$Port within $WaitSeconds seconds"
