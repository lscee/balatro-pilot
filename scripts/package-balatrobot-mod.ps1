[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$OutputDirectory = "",
  [switch]$UseInstalledRuntime
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$project = [System.IO.Path]::GetFullPath($ProjectRoot)
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $project "release"
}
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$expectedFingerprint = "b6da92128779742cd1a684c83b45027d603b3cf56be5d5a242c7269bb420c0d1"

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralPath).Hash.ToLowerInvariant()
}

function Get-RuntimeFingerprint {
  param([Parameter(Mandatory = $true)][string]$Root)
  $files = @(
    (Get-Item -LiteralPath (Join-Path $Root "balatrobot.json")),
    (Get-Item -LiteralPath (Join-Path $Root "balatrobot.lua"))
  )
  $files += @(Get-ChildItem -LiteralPath (Join-Path $Root "src\lua") -File -Recurse)
  $entries = @($files | ForEach-Object {
    $relative = $_.FullName.Substring($Root.Length).TrimStart([char]92).Replace("\", "/")
    $hash = Get-FileSha256 -LiteralPath $_.FullName
    "{0}`t{1}" -f $relative, $hash
  } | Sort-Object)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]::Join("`n", [string[]]$entries))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant() }
  finally { $sha.Dispose() }
}

if (-not $UseInstalledRuntime) {
  throw "Run install-balatrobot.ps1 to build and verify the pinned runtime, then pass -UseInstalledRuntime. This shortcut package is reproducible in content but ZIP container metadata may vary."
}

$source = Join-Path $env:APPDATA "Balatro\Mods\balatrobot"
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
  throw "Pinned BalatroBot runtime is not installed: $source"
}
$actualFingerprint = Get-RuntimeFingerprint -Root $source
if ($actualFingerprint -ne $expectedFingerprint) {
  throw "Installed BalatroBot runtime fingerprint mismatch. Run install-balatrobot.ps1 before packaging."
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("balatro-pilot-mod-" + [Guid]::NewGuid().ToString("N"))
try {
  $target = Join-Path $stage "balatrobot"
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $source "balatrobot.json") -Destination $target
  Copy-Item -LiteralPath (Join-Path $source "balatrobot.lua") -Destination $target
  New-Item -ItemType Directory -Path (Join-Path $target "src") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $source "src\lua") -Destination (Join-Path $target "src") -Recurse
  $stagedFingerprint = Get-RuntimeFingerprint -Root $target
  if ($stagedFingerprint -ne $expectedFingerprint) {
    throw "Staged BalatroBot runtime fingerprint mismatch; packaging stopped before creating the archive."
  }
  $provenance = @"
BalatroBot v1.5.2
Upstream: https://github.com/coder/balatrobot
Commit: 9052d76f14723293f6c6b2cecaa791a5c4ae68f3
Balatro Pilot runtime fingerprint: $expectedFingerprint
Includes Balatro Pilot entropy, stable-menu start guard, button-independent hand actions, canonical cumulative-Stake and sticker state, Endless/play settlement, cash-out safety, selected-card pack patches, Aura targeting, Boss reroll, and exact Buy & Use patches.
Lovely and Steamodded are prerequisites and are intentionally not bundled.
"@
  [System.IO.File]::WriteAllText((Join-Path $target "BALATRO-PILOT-PROVENANCE.txt"), $provenance, [System.Text.UTF8Encoding]::new($false))
  $upstreamLicense = @"
MIT License

Copyright (c) 2025 Coder

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"@
  [System.IO.File]::WriteAllText((Join-Path $target "LICENSE-BALATROBOT"), $upstreamLicense, [System.Text.UTF8Encoding]::new($false))
  $archive = Join-Path $output "balatrobot-pilot-v1.5.2.zip"
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  Compress-Archive -LiteralPath $target -DestinationPath $archive -CompressionLevel Optimal
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
  [System.IO.File]::WriteAllText("$archive.sha256", "$hash  $([System.IO.Path]::GetFileName($archive))`n", [System.Text.UTF8Encoding]::new($false))
  Write-Output "Created $archive"
  Write-Output "SHA256 $hash"
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
