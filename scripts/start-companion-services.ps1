[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [int]$DashboardPort = 4312,
  [int]$OverlayPort = 4313
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$resolvedProject = [System.IO.Path]::GetFullPath($ProjectRoot)
$node = Get-Command node -CommandType Application -ErrorAction Stop
$logs = Join-Path $resolvedProject "runs\web-services"
if (-not (Test-Path -LiteralPath $logs -PathType Container)) {
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
}

function Test-LoopbackPort {
  param([int]$Port)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync("127.0.0.1", $Port)
    return $task.Wait(350) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Start-NodeService {
  param([string]$Name, [string]$Entry, [int]$Port)
  if (Test-LoopbackPort -Port $Port) { return }
  $entryPath = Join-Path $resolvedProject $Entry
  if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw "$Name entry point is missing: $entryPath"
  }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdout = Join-Path $logs "$Name-$stamp.stdout.log"
  $stderr = Join-Path $logs "$Name-$stamp.stderr.log"
  Start-Process -FilePath $node.Source `
    -ArgumentList @($entryPath, "--host", "127.0.0.1", "--port", [string]$Port) `
    -WorkingDirectory $resolvedProject `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 200
    if (Test-LoopbackPort -Port $Port) { return }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "$Name did not listen on 127.0.0.1:$Port; inspect $stderr"
}

Start-NodeService -Name "dashboard" -Entry "src\dashboard-server.mjs" -Port $DashboardPort
Start-NodeService -Name "overlay" -Entry "src\overlay-server.mjs" -Port $OverlayPort
